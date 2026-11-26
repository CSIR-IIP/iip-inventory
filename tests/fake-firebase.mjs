// Minimal in-memory stand-ins for the parts of firebase-admin used by the API.
// Models: optimistic transactions with retry on conflict, the 500-write limit, rejection of `undefined`
// values, create()/update() existence rules, equality queries, orderBy and limit.
import crypto from 'node:crypto';

const tick = () => new Promise(r => setTimeout(r, Math.random() * 4)); // random latency so concurrent transactions truly interleave
const clone = v => (v === undefined ? v : structuredClone(v));
function assertDefined(v, path = '') {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (${path})`);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertDefined(x, `${path}.${k}`);
}

class DocRef {
  constructor(db, col, id) { this.db = db; this.col = col; this.id = id; this.path = `${col}/${id}`; }
  async get() { await tick(); return this.db._snap(this); }
  async set(d, o) { this.db._apply([{ op: 'set', ref: this, data: d, merge: !!o?.merge }]); }
  async update(d) { this.db._apply([{ op: 'update', ref: this, data: d }]); }
  async delete() { this.db._apply([{ op: 'delete', ref: this }]); }
}
class Query {
  constructor(db, col, filters = [], order = null, lim = null) { Object.assign(this, { db, col, filters, order, lim }); }
  where(f, op, v) { if (op !== '==') throw new Error('fake supports == only'); return new Query(this.db, this.col, [...this.filters, [f, v]], this.order, this.lim); }
  orderBy(f, dir = 'asc') { return new Query(this.db, this.col, this.filters, [f, dir], this.lim); }
  limit(n) { return new Query(this.db, this.col, this.filters, this.order, n); }
  _run() {
    let rows = [...this.db.data.entries()].filter(([p]) => p.startsWith(this.col + '/') && !p.slice(this.col.length + 1).includes('/'))
      .map(([p, e]) => ({ id: p.slice(this.col.length + 1), e })).filter(({ e }) => this.filters.every(([f, v]) => e.data[f] === v));
    if (this.order) { const [f, dir] = this.order; rows.sort((a, b) => (a.e.data[f] > b.e.data[f] ? 1 : a.e.data[f] < b.e.data[f] ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
    if (this.lim != null) rows = rows.slice(0, this.lim);
    const docs = rows.map(({ id }) => this.db._snap(new DocRef(this.db, this.col, id)));
    return { docs, empty: !docs.length, size: docs.length };
  }
  async get() { await tick(); return this._run(); }
}
class Col extends Query {
  constructor(db, name) { super(db, name); }
  doc(id) { return new DocRef(this.db, this.col, id); }
}
class Batch {
  constructor(db) { this.db = db; this.w = []; }
  set(ref, data, o) { this.w.push({ op: 'set', ref, data, merge: !!o?.merge }); return this; }
  update(ref, data) { this.w.push({ op: 'update', ref, data }); return this; }
  delete(ref) { this.w.push({ op: 'delete', ref }); return this; }
  async commit() { await tick(); this.db._apply(this.w); }
}
class Tx {
  constructor(db) { this.db = db; this.reads = new Map(); this.colReads = new Map(); this.w = []; }
  async get(x) {
    await tick();
    if (x instanceof DocRef) { this.reads.set(x.path, this.db.data.get(x.path)?.ver || 0); return this.db._snap(x); }
    this.colReads.set(x.col, this.db.colVer.get(x.col) || 0);
    return x._run();
  }
  async getAll(...refs) { return Promise.all(refs.map(r => this.get(r))); }
  create(ref, data) { this.w.push({ op: 'create', ref, data }); return this; }
  set(ref, data, o) { this.w.push({ op: 'set', ref, data, merge: !!o?.merge }); return this; }
  update(ref, data) { this.w.push({ op: 'update', ref, data }); return this; }
  delete(ref) { this.w.push({ op: 'delete', ref }); return this; }
}

export class FakeFirestore {
  constructor() { this.data = new Map(); this.colVer = new Map(); this.stats = { retries: 0, maxTxWrites: 0 }; this.failWrite = null; }
  settings() {}
  collection(n) { return new Col(this, n); }
  batch() { return new Batch(this); }
  _snap(ref) { const e = this.data.get(ref.path); return { id: ref.id, ref, exists: !!e, data: () => (e ? clone(e.data) : undefined) }; }
  _apply(writes) {
    if (writes.length > 500) throw new Error('Firestore limit: at most 500 writes per commit');
    if (this.failWrite) for (const w of writes) if (this.failWrite(w.ref.path)) throw new Error('Injected Firestore failure');
    const seen = new Set();
    for (const w of writes) {
      if (w.op !== 'delete') assertDefined(w.data, w.ref.path);
      const exists = this.data.has(w.ref.path);
      if (w.op === 'create' && exists) throw new Error(`ALREADY_EXISTS: ${w.ref.path}`);
      if (w.op === 'update' && !exists && !seen.has(w.ref.path)) throw new Error(`NOT_FOUND: ${w.ref.path}`);
      seen.add(w.ref.path);
    }
    for (const w of writes) {
      const prev = this.data.get(w.ref.path);
      if (w.op === 'delete') this.data.delete(w.ref.path);
      else if (w.op === 'update' || (w.op === 'set' && w.merge)) this.data.set(w.ref.path, { data: { ...(prev?.data || {}), ...clone(w.data) }, ver: (prev?.ver || 0) + 1 });
      else this.data.set(w.ref.path, { data: clone(w.data), ver: (prev?.ver || 0) + 1 });
      this.colVer.set(w.ref.col, (this.colVer.get(w.ref.col) || 0) + 1);
    }
  }
  async runTransaction(fn, opts = {}) {
    const attempts = opts.maxAttempts ?? 5; // same default as the real Admin SDK
    for (let a = 0; a < attempts; a++) {
      const tx = new Tx(this);
      const result = await fn(tx);
      await tick();
      const stale = [...tx.reads].some(([p, v]) => (this.data.get(p)?.ver || 0) !== v) || [...tx.colReads].some(([c, v]) => (this.colVer.get(c) || 0) !== v);
      if (stale) { this.stats.retries++; continue; }
      this.stats.maxTxWrites = Math.max(this.stats.maxTxWrites, tx.w.length);
      this._apply(tx.w);
      return result;
    }
    throw new Error('Transaction failed after retries');
  }
  doc(path) { const [c, id] = path.split('/'); return new DocRef(this, c, id); }
  dump(col) { return new Query(this, col)._run().docs.map(d => ({ id: d.id, ...d.data() })); }
}

export class FakeAuth {
  constructor() { this.users = new Map(); this.byEmail = new Map(); }
  add(uid, email, password = 'x'.repeat(14)) { this.users.set(uid, { uid, email, password, disabled: false, revoked: 0 }); this.byEmail.set(email, uid); }
  tokenFor(uid) { return `tok.${uid}`; }
  async createUser({ email, password, displayName, disabled }) {
    await tick();
    if (this.byEmail.has(email)) throw Object.assign(new Error('exists'), { code: 'auth/email-already-exists' });
    const uid = crypto.randomBytes(14).toString('hex').slice(0, 28);
    this.add(uid, email, password); Object.assign(this.users.get(uid), { displayName, disabled: !!disabled });
    return { uid, email };
  }
  async updateUser(uid, p) {
    await tick();
    const u = this.users.get(uid);
    if (!u) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
    Object.assign(u, p);
    return u;
  }
  async deleteUser(uid) { const u = this.users.get(uid); if (u) { this.byEmail.delete(u.email); this.users.delete(uid); } }
  async revokeRefreshTokens(uid) { this.users.get(uid).revoked = Date.now(); }
  async verifyIdToken(t) {
    await tick();
    if (t === 'expired') throw Object.assign(new Error('expired'), { code: 'auth/id-token-expired' });
    const m = /^tok\.(.+)$/.exec(t);
    const u = m && this.users.get(m[1]);
    if (!u) throw Object.assign(new Error('bad'), { code: 'auth/argument-error' });
    return { uid: u.uid, email: u.email };
  }
}
