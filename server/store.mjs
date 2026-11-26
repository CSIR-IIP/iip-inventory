import { HttpError, CATS, buildSeed, newId, nameKey, safeId, whole, validDate, today } from './util.mjs';

const LOCATION_CACHE_MS = 5 * 60 * 1000;
const CHUNK = 200; // ops per import transaction: <= 2 writes each, under Firestore's 500-write limit
const STATE_LOG_LIMIT = Math.max(50, Number(process.env.STATE_LOG_LIMIT) || 500);

const issuedOf = i => Object.values(i.alloc || {}).reduce((a, b) => a + b, 0);
const publicItem = (id, d) => ({
  id, name: d.name, category: d.category, qty: d.qty, unit: d.unit, min: d.min, description: d.description || '',
  alloc: d.alloc || {}, roomMin: d.roomMin || {}, sample: !!d.sample, createdAt: d.createdAt
});
const publicLog = (id, d) => ({
  id, ts: d.ts, date: d.date, type: d.type, item: d.item, itemId: d.itemId, qty: d.qty, loc: d.loc || '', note: d.note || '',
  actor: d.actor || '', ...(d.actorUid ? { actorUid: d.actorUid } : {}), ...(d.sample ? { sample: true } : {})
});
const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);

function text(v, max, label) {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return s;
}

export function createStore(db) {
  const items = db.collection('inventory');
  const logs = db.collection('activityLogs');
  const locs = db.collection('locations');
  const config = db.collection('appConfig').doc('current');
  let seeding = null, locCache = null;
  // Raise the SDK's default of 5 attempts so bursts of concurrent edits to one item are retried instead of failing.
  const run = fn => db.runTransaction(fn, { maxAttempts: 10 });

  const logEntry = (type, it, qty, loc, note, date, actor) => ({
    id: newId(), ts: Date.now(), date: date || today(), type, item: it.name, itemId: it.id, qty, loc: loc || '', note: note || '',
    actor: actor?.username || 'Unknown', actorUid: actor?.id || ''
  });

  async function chunked(ops) { // ops: (batch)=>void; runs in batches of <=400 writes
    for (let i = 0; i < ops.length; i += 400) {
      const b = db.batch();
      ops.slice(i, i + 400).forEach(fn => fn(b));
      await b.commit();
    }
  }

  async function loadLocations() {
    if (locCache && Date.now() - locCache.at < LOCATION_CACHE_MS) return locCache.value;
    const snap = await locs.get();
    const rows = snap.docs.map(d => d.data()).sort((a, b) => a.groupOrder - b.groupOrder || a.order - b.order);
    const groups = [];
    for (const r of rows) {
      let g = groups.find(x => x[0] === r.group);
      if (!g) groups.push(g = [r.group, []]);
      g[1].push(r.name);
    }
    const value = { locations: rows.map(r => r.name), groups };
    locCache = { at: Date.now(), value };
    return value;
  }

  /** Seeds only what is empty, exactly once, even if several cold instances race. Never overwrites existing data. */
  function ensureSeeded() {
    if (!seeding) {
      seeding = (async () => {
        const snap = await config.get();
        if (snap.exists && snap.data().seeded === true) return;
        await run(async tx => {
          const cfg = await tx.get(config);
          if (cfg.exists && cfg.data().seeded === true) return;
          const [inv, loc] = await Promise.all([tx.get(items.limit(1)), tx.get(locs.limit(1))]);
          const seed = buildSeed();
          const patch = { seeded: true, seededAt: new Date().toISOString(), version: 1, inventorySeeded: true };
          const seedInventory = inv.empty && !(cfg.exists && cfg.data().inventorySeeded === true);
          if (loc.empty) seed.locations.forEach(l => tx.set(locs.doc(l.id), l));
          if (seedInventory) {
            seed.items.forEach(i => tx.set(items.doc(i.id), i));
            seed.log.forEach(l => tx.set(logs.doc(l.id), l));
          }
          tx.set(config, patch, { merge: true });
        });
        locCache = null;
      })().catch(e => { seeding = null; throw e; });
    }
    return seeding;
  }

  async function getState({ allLogs = false } = {}) {
    const logQuery = allLogs ? logs.orderBy('ts', 'desc') : logs.orderBy('ts', 'desc').limit(STATE_LOG_LIMIT);
    const [l, itemSnap, logSnap] = await Promise.all([loadLocations(), items.get(), logQuery.get()]);
    return {
      items: itemSnap.docs.map(d => publicItem(d.id, d.data())).sort(byCreated),
      log: logSnap.docs.map(d => publicLog(d.id, d.data())).reverse(),
      locations: l.locations, groups: l.groups
    };
  }

  const itemsForPlanning = async () => ({ items: (await items.get()).docs.map(d => ({ id: d.id, ...d.data() })) });
  const requireLocation = async name => {
    if (!(await loadLocations()).locations.includes(name)) throw new HttpError(400, 'Select a valid location.');
  };

  async function stockIn(b, actor) {
    const q = whole(b.qty, 1);
    if (q === null) throw new HttpError(400, 'Enter a whole quantity of at least 1.');
    if (!b.date) throw new HttpError(400, 'Choose a date.');
    if (!validDate(b.date)) throw new HttpError(400, 'Use a valid date.');
    const note = text(b.note, 140, 'Note');
    let fresh = null;
    if (b.itemId === 'new') {
      const name = text(b.name, 80, 'Item name');
      if (!name) throw new HttpError(400, 'Enter an item name.');
      if (!CATS.includes(b.category)) throw new HttpError(400, 'Choose a category.');
      const min = whole(b.min, 0);
      if (min === null) throw new HttpError(400, 'Minimum stock must be a whole number, 0 or more.');
      fresh = { name, category: b.category, min, unit: text(b.unit, 15, 'Unit') || 'pcs', description: text(b.description, 200, 'Description') };
    } else if (!safeId(b.itemId)) throw new HttpError(404, 'Select a valid item.');
    const message = await run(async tx => {
      let ref, it;
      if (fresh) {
        const dup = await tx.get(items.where('nameKey', '==', nameKey(fresh.name)).limit(1));
        if (!dup.empty) throw new HttpError(400, 'An item with this name already exists.');
        const id = newId();
        ref = items.doc(id);
        it = { id, ...fresh, nameKey: nameKey(fresh.name), qty: q, alloc: {}, roomMin: {}, sample: false, createdAt: new Date().toISOString() };
        tx.create(ref, it);
      } else {
        ref = items.doc(b.itemId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpError(404, 'Select a valid item.');
        it = { id: snap.id, ...snap.data() };
        tx.update(ref, { qty: it.qty + q });
      }
      const entry = logEntry('in', it, q, '', note, b.date, actor);
      tx.create(logs.doc(entry.id), entry);
      return `Added ${q} ${it.unit} of ${it.name}.`;
    });
    return { state: await getState(), message };
  }

  async function issue(b, actor) {
    const id = safeId(b.itemId);
    if (!id) throw new HttpError(404, 'Select an item.');
    await requireLocation(b.location);
    const q = whole(b.qty, 1);
    if (q === null) throw new HttpError(400, 'Enter a whole quantity of at least 1.');
    if (!b.date) throw new HttpError(400, 'Choose a date.');
    if (!validDate(b.date)) throw new HttpError(400, 'Use a valid date.');
    const note = text(b.note, 140, 'Note');
    const message = await run(async tx => {
      const ref = items.doc(id), snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(404, 'Select an item.');
      const it = { id, ...snap.data() };
      if (q > it.qty) throw new HttpError(400, `Only ${it.qty} ${it.unit} available in central stock.`);
      const alloc = { ...(it.alloc || {}) };
      alloc[b.location] = (alloc[b.location] || 0) + q;
      tx.update(ref, { qty: it.qty - q, alloc });
      const entry = logEntry('out', it, q, b.location, note, b.date, actor);
      tx.create(logs.doc(entry.id), entry);
      return `Issued ${q} ${it.unit} to ${b.location}.`;
    });
    return { state: await getState(), message };
  }

  /** Remove stock from a location: return it to central stock, or write it off as consumed, damaged or missing. */
  async function roomAction(b, actor) {
    const action = String(b.action || '');
    const type = { return: 'return', consume: 'consume', damage: 'damage', damaged: 'damage', missing: 'missing' }[action];
    if (!type) throw new HttpError(400, 'Choose a valid room action.');
    const bad = type === 'return' ? 'Return quantity exceeds the assigned quantity.' : 'Quantity exceeds the amount assigned to this location.';
    const id = safeId(b.itemId), q = whole(b.qty, 1);
    if (!id || q === null || typeof b.location !== 'string') throw new HttpError(400, bad);
    if (b.date !== undefined && b.date !== '' && !validDate(b.date)) throw new HttpError(400, 'Use a valid date.');
    const date = b.date || today();
    const defaults = { return: 'Returned to central stock', consume: 'Consumed at location', damage: 'Reported damaged', missing: 'Reported missing' };
    const note = text(b.note, 140, 'Note') || defaults[type];
    const message = await run(async tx => {
      const ref = items.doc(id), snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(400, bad);
      const it = { id, ...snap.data() };
      const have = (it.alloc || {})[b.location] || 0;
      if (q > have) throw new HttpError(400, bad);
      const alloc = { ...it.alloc };
      if (have - q > 0) alloc[b.location] = have - q; else delete alloc[b.location];
      tx.update(ref, type === 'return' ? { qty: it.qty + q, alloc } : { alloc });
      const entry = logEntry(type, it, q, b.location, note, date, actor);
      tx.create(logs.doc(entry.id), entry);
      return { return: `Returned ${q} ${it.unit} to central stock.`, consume: `Recorded ${q} ${it.unit} of ${it.name} as consumed at ${b.location}.`, damage: `Recorded ${q} ${it.unit} of ${it.name} as damaged at ${b.location}.`, missing: `Recorded ${q} ${it.unit} of ${it.name} as missing at ${b.location}.` }[type];
    });
    return { state: await getState(), message };
  }

  async function roomMinimum(b, actor) {
    const id = safeId(b.itemId);
    if (!id) throw new HttpError(404, 'Select an item.');
    await requireLocation(b.location);
    const min = whole(b.min, 0);
    if (min === null) throw new HttpError(400, 'Minimum stock must be a whole number, 0 or more.');
    const message = await run(async tx => {
      const ref = items.doc(id), snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(404, 'Item not found.');
      const it = { id, ...snap.data() };
      const roomMin = { ...(it.roomMin || {}) }, before = roomMin[b.location] || 0;
      if (min === 0) delete roomMin[b.location]; else roomMin[b.location] = min;
      tx.update(ref, { roomMin });
      const entry = logEntry('edit', it, Math.abs(min - before), b.location, `Minimum stock for ${b.location} set to ${min}`, today(), actor);
      tx.create(logs.doc(entry.id), entry);
      return `Minimum for ${it.name} at ${b.location} set to ${min}.`;
    });
    return { state: await getState(), message };
  }

  async function updateItem(id, b, actor) {
    if (!safeId(id)) throw new HttpError(404, 'Item not found.');
    const name = text(b.name, 80, 'Item name');
    if (!name) throw new HttpError(400, 'Enter an item name.');
    if (!CATS.includes(b.category)) throw new HttpError(400, 'Choose a category.');
    const q = whole(b.qty, 0), m = whole(b.min, 0);
    if (q === null || m === null) throw new HttpError(400, 'Quantities and minimum stock must be whole numbers, 0 or more.');
    const fields = { name, nameKey: nameKey(name), category: b.category, qty: q, min: m, unit: text(b.unit, 15, 'Unit') || 'pcs', description: text(b.description, 200, 'Description') };
    await run(async tx => {
      const ref = items.doc(id), snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(404, 'Item not found.');
      const dup = await tx.get(items.where('nameKey', '==', fields.nameKey).limit(2));
      if (dup.docs.some(d => d.id !== id)) throw new HttpError(400, 'Another item already uses this name.');
      const it = { id, ...snap.data() }, diff = q - it.qty;
      tx.update(ref, fields);
      const entry = logEntry('edit', { id, name }, Math.abs(diff), '', diff ? `Central stock corrected by ${diff > 0 ? '+' : ''}${diff}` : 'Item details updated', today(), actor);
      tx.create(logs.doc(entry.id), entry);
    });
    return { state: await getState(), message: 'Item updated successfully.' };
  }

  async function deleteItem(id, actor) {
    if (!safeId(id)) throw new HttpError(404, 'Item not found.');
    await run(async tx => {
      const ref = items.doc(id), snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(404, 'Item not found.');
      const it = { id, ...snap.data() };
      tx.delete(ref);
      const entry = logEntry('delete', it, it.qty + issuedOf(it), '', 'Item deleted; allocations removed', today(), actor);
      tx.create(logs.doc(entry.id), entry);
    });
    return { state: await getState(), message: 'Item deleted.' };
  }

  /** Applies a validated import plan in chunked transactions; each chunk re-reads current stock so concurrent edits are not overwritten. */
  async function applyImport(ops, actor) {
    let done = 0;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const chunk = ops.slice(i, i + CHUNK);
      try {
        await run(async tx => {
          const keys = [...new Set(chunk.map(o => nameKey(o.name)))];
          const found = await Promise.all(keys.map(k => tx.get(items.where('nameKey', '==', k).limit(1))));
          const local = new Map(keys.map((k, n) => {
            const d = found[n].docs[0];
            return [k, d ? { ref: d.ref, data: { id: d.id, ...d.data() }, isNew: false } : null];
          }));
          const entries = [], dirty = new Set();
          for (const o of chunk) {
            const k = nameKey(o.name);
            let e = local.get(k);
            if (!e) {
              const id = newId();
              e = { ref: items.doc(id), isNew: true, data: { id, name: o.name, nameKey: k, category: o.category, qty: 0, unit: o.unit, min: o.min, description: o.description, alloc: {}, roomMin: {}, sample: false, createdAt: new Date().toISOString() } };
              local.set(k, e);
            }
            if (o.action === 'set') {
              if (e.data.qty !== o.after) {
                const d = o.after - e.data.qty;
                e.data.qty = o.after;
                entries.push(logEntry('edit', e.data, Math.abs(d), '', `Stock count set via import (${d > 0 ? '+' : ''}${d})`, o.date, actor));
              }
            } else {
              e.data.qty += o.qty;
              entries.push(logEntry('in', e.data, o.qty, '', o.note, o.date, actor));
            }
            dirty.add(k);
          }
          for (const k of dirty) {
            const e = local.get(k);
            if (e.isNew) tx.create(e.ref, e.data); else tx.update(e.ref, { qty: e.data.qty });
          }
          entries.forEach(en => tx.create(logs.doc(en.id), en));
        });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error('Import chunk failed', e);
        throw new HttpError(500, done ? `The import stopped part-way: ${done} of ${ops.length} rows were saved. Review the inventory, then import the remaining rows again.` : 'The import could not be saved. No changes were made.');
      }
      done += chunk.length;
    }
    return done;
  }

  /** Replaces inventory and activity with the original sample data (same behaviour as the JSON backend). */
  async function reset(actor) {
    const [inv, act] = await Promise.all([items.get(), logs.get()]);
    const seed = buildSeed();
    const ops = [
      ...inv.docs.map(d => b => b.delete(d.ref)), ...act.docs.map(d => b => b.delete(d.ref)),
      ...seed.items.map(i => b => b.set(items.doc(i.id), i)), ...seed.log.map(l => b => b.set(logs.doc(l.id), l))
    ];
    await chunked(ops);
    await chunked([b => b.set(config, { seeded: true, inventorySeeded: true, lastResetAt: new Date().toISOString(), lastResetBy: actor?.id || '' }, { merge: true })]);
    return { state: await getState() };
  }

  return { ensureSeeded, getState, itemsForPlanning, stockIn, issue, roomAction, roomMinimum, updateItem, deleteItem, applyImport, reset, loadLocations };
}
