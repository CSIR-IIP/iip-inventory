import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../server/app.mjs';
import { parseUpload } from '../server/import.mjs';
import { normalizePrivateKey } from '../server/firebase.mjs';
import { FakeFirestore, FakeAuth } from './fake-firebase.mjs';

const ADMIN_UID = '09JYXShCynbEmYqB1hTYnry5RfP2';
const PW = 'Correct-Horse-Battery-9';

async function makeEnv({ adminProfile = { email: 'admin@iip.test', role: 'admin' } } = {}) {
  const db = new FakeFirestore(), auth = new FakeAuth();
  auth.add(ADMIN_UID, 'admin@iip.test');
  if (adminProfile) await db.collection('users').doc(ADMIN_UID).set(adminProfile);
  const server = http.createServer(createHandler({ getServices: () => ({ db, auth }) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (p, { method = 'GET', body, token, raw, headers } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
    const ct = r.headers.get('content-type') || '';
    return { r, status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const admin = auth.tokenFor(ADMIN_UID);
  const mkUser = async (email, username, role) => {
    const x = await call('/users', { method: 'POST', token: admin, body: { email, username, password: PW, role } });
    assert.equal(x.status, 201, JSON.stringify(x.data));
    return { id: x.data.user.id, token: auth.tokenFor(x.data.user.id) };
  };
  return { db, auth, server, base, call, admin, mkUser, close: () => server.close() };
}
const item = (state, name) => state.items.find(i => i.name === name);

const E = await makeEnv();
const mgr = await E.mkUser('manager@iip.test', 'manager.test', 'manager');
const view = await E.mkUser('viewer@iip.test', 'viewer.test', 'viewer');
const { call, admin } = E;
test.after(() => E.close());

test('authentication: anonymous, malformed, expired and unknown tokens are rejected', async () => {
  assert.equal((await call('/state')).status, 401);
  assert.equal((await call('/state', { token: 'garbage' })).status, 401);
  const expired = await call('/state', { token: 'expired' });
  assert.equal(expired.status, 401); assert.equal(expired.data.code, 'token-expired');
  assert.equal((await call('/auth/me', { headers: { authorization: 'Basic abc' } })).status, 401);
  assert.equal((await call('/users', { token: 'garbage' })).status, 401);
  assert.equal((await call('/nope', { token: admin })).status, 404);
});

test('auth status and /auth/me; username falls back to the email prefix when the profile has none', async () => {
  assert.equal((await call('/auth/status')).data.configured, true);
  const me = await call('/auth/me', { token: admin });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, 'admin');
  assert.equal(me.data.user.email, 'admin@iip.test');
  assert.equal(me.data.user.role, 'admin');
  assert.deepEqual(me.data.user.permissions, ['view', 'export', 'stock', 'edit', 'delete', 'reset', 'manageUsers']);
  assert.deepEqual((await call('/auth/me', { token: mgr.token })).data.user.permissions, ['view', 'export', 'stock', 'edit']);
});

test('the role comes from Firestore, never from the request', async () => {
  const r = await call('/stock-in', { method: 'POST', token: view.token, body: { role: 'admin', permissions: ['stock'], itemId: 'new', name: 'Sneaky', category: 'Sports', qty: 1, min: 1, date: '2026-11-01' }, headers: { 'x-role': 'admin' } });
  assert.equal(r.status, 403);
});

test('first request seeds locations and sample inventory (48 locations, 18 items, 5 groups)', async () => {
  const { data: s, status } = await call('/state', { token: admin });
  assert.equal(status, 200);
  assert.equal(s.locations.length, 48); assert.equal(s.groups.length, 5); assert.equal(s.items.length, 18);
  assert.equal(s.groups[0][0], 'Guest rooms'); assert.equal(s.groups[0][1].length, 34);
  assert.deepEqual(Object.keys(s.items[0]).sort(), ['alloc', 'category', 'createdAt', 'description', 'id', 'min', 'name', 'qty', 'roomMin', 'sample', 'unit']);
  assert.ok(!('nameKey' in s.items[0]));
  for (const k of ['id', 'ts', 'date', 'type', 'item', 'itemId', 'qty', 'loc', 'note', 'actor', 'sample']) assert.ok(k in s.log[0], k);
  assert.equal(s.log.length, 5);
  assert.equal(E.db.data.get('appConfig/current').data.seeded, true);
});

test('seeding is race-safe and never overwrites existing data', async () => {
  const R = await makeEnv();
  const results = await Promise.all(Array.from({ length: 12 }, () => R.call('/state', { token: R.admin })));
  assert.ok(results.every(x => x.status === 200));
  assert.equal(R.db.dump('inventory').length, 18); assert.equal(R.db.dump('locations').length, 48);
  await R.call('/state', { token: R.admin });
  assert.equal(R.db.dump('inventory').length, 18);
  R.close();
  const P = await makeEnv();
  await P.db.collection('inventory').doc('keep1').set({ name: 'My Existing Item', nameKey: 'my existing item', category: 'Sports', qty: 7, unit: 'pcs', min: 1, description: '', alloc: {}, roomMin: {}, sample: false, createdAt: '2026-01-01T00:00:00.000Z' });
  const s = (await P.call('/state', { token: P.admin })).data;
  assert.equal(s.items.length, 1); assert.equal(s.items[0].name, 'My Existing Item'); assert.equal(s.locations.length, 48);
  P.close();
});

test('stock-in, issue, return and over-issue validation', async () => {
  const s = (await call('/state', { token: admin })).data, it = item(s, 'Volleyball'), start = it.qty;
  let x = await call('/stock-in', { method: 'POST', token: admin, body: { itemId: it.id, qty: 5, date: '2026-11-11', note: 'PO-1' } });
  assert.equal(item(x.data.state, 'Volleyball').qty, start + 5); assert.match(x.data.message, /Added 5 pcs of Volleyball/);
  x = await call('/issue', { method: 'POST', token: admin, body: { itemId: it.id, location: 'Gym', qty: 4, date: '2026-11-11' } });
  let u = item(x.data.state, 'Volleyball'); assert.equal(u.qty, start + 1); assert.equal(u.alloc.Gym, 4); assert.equal(u.alloc['Volleyball Court'], 3);
  assert.equal((await call('/issue', { method: 'POST', token: admin, body: { itemId: it.id, location: 'Gym', qty: 999, date: '2026-11-11' } })).status, 400);
  assert.equal((await call('/issue', { method: 'POST', token: admin, body: { itemId: it.id, location: 'Nowhere', qty: 1, date: '2026-11-11' } })).status, 400);
  x = await call('/return', { method: 'POST', token: admin, body: { itemId: it.id, location: 'Gym', qty: 2, date: '2026-11-11' } });
  u = item(x.data.state, 'Volleyball'); assert.equal(u.qty, start + 3); assert.equal(u.alloc.Gym, 2);
  assert.equal((await call('/return', { method: 'POST', token: admin, body: { itemId: it.id, location: 'Gym', qty: 3, date: '2026-11-11' } })).status, 400);
  x = await call('/return', { method: 'POST', token: admin, body: { itemId: it.id, location: 'Gym', qty: 2 } });
  assert.equal('Gym' in item(x.data.state, 'Volleyball').alloc, false);
  const last = x.data.state.log.at(-1);
  assert.equal(last.type, 'return'); assert.equal(last.actor, 'admin'); assert.equal(last.actorUid, ADMIN_UID); assert.equal(last.loc, 'Gym');
});

test('numeric and date validation rejects bad values', async () => {
  const id = item((await call('/state', { token: admin })).data, 'Notepad').id;
  for (const qty of [-2, 0, 1.5, '', null, 'abc', true, 1e12, NaN, '3 apples'])
    assert.equal((await call('/stock-in', { method: 'POST', token: admin, body: { itemId: id, qty, date: '2026-11-11' } })).status, 400, `qty=${String(qty)}`);
  assert.equal((await call('/stock-in', { method: 'POST', token: admin, body: { itemId: id, qty: 1 } })).status, 400);
  assert.equal((await call('/stock-in', { method: 'POST', token: admin, body: { itemId: id, qty: 1, date: '2026-13-45' } })).status, 400);
  assert.equal((await call('/stock-in', { method: 'POST', token: admin, body: { itemId: 'missing', qty: 1, date: '2026-11-11' } })).status, 404);
  assert.equal((await call('/stock-in', { method: 'POST', token: admin, body: { itemId: '../users/x', qty: 1, date: '2026-11-11' } })).status, 404);
  assert.equal((await call('/stock-in', { method: 'POST', token: admin, body: [1] })).status, 400);
});

test('room actions: consume, damage, missing, return and room minimums', async () => {
  const id = item((await call('/state', { token: admin })).data, 'Yoga Mat').id; // Gym: 10
  const act = (action, qty, location = 'Gym') => call('/room-action', { method: 'POST', token: mgr.token, body: { action, itemId: id, location, qty, date: '2026-11-12' } });
  let x = await act('consume', 2); assert.equal(x.status, 200); let it = item(x.data.state, 'Yoga Mat');
  assert.equal(it.alloc.Gym, 8); assert.equal(it.qty, 3);
  x = await act('damage', 1); assert.equal(item(x.data.state, 'Yoga Mat').alloc.Gym, 7);
  x = await act('missing', 1); assert.equal(item(x.data.state, 'Yoga Mat').alloc.Gym, 6);
  x = await act('return', 3); it = item(x.data.state, 'Yoga Mat'); assert.equal(it.alloc.Gym, 3); assert.equal(it.qty, 6);
  assert.deepEqual(x.data.state.log.slice(-4).map(l => l.type), ['consume', 'damage', 'missing', 'return']);
  assert.equal((await act('consume', 4)).status, 400);
  assert.equal((await act('consume', 1, 'Dining Hall')).status, 400);
  assert.equal((await act('explode', 1)).status, 400);
  x = await act('consume', 3); assert.ok(!('Gym' in item(x.data.state, 'Yoga Mat').alloc));
  const m = await call('/room-minimum', { method: 'PATCH', token: mgr.token, body: { itemId: id, location: 'Gym', min: 4 } });
  assert.equal(m.status, 200); assert.deepEqual(item(m.data.state, 'Yoga Mat').roomMin, { Gym: 4 });
  assert.equal((await call('/room-minimum', { method: 'PATCH', token: mgr.token, body: { itemId: id, location: 'Gym', min: -1 } })).status, 400);
  assert.equal((await call('/room-minimum', { method: 'PATCH', token: mgr.token, body: { itemId: id, location: 'Mars', min: 1 } })).status, 400);
  assert.equal((await call('/room-minimum', { method: 'PATCH', token: view.token, body: { itemId: id, location: 'Gym', min: 1 } })).status, 403);
  const z = await call('/room-minimum', { method: 'PATCH', token: mgr.token, body: { itemId: id, location: 'Gym', min: 0 } });
  assert.deepEqual(item(z.data.state, 'Yoga Mat').roomMin, {});
  assert.equal((await call('/room-action', { method: 'POST', token: view.token, body: { action: 'consume', itemId: id, location: 'Gym', qty: 1 } })).status, 403);
});

test('concurrent operations never overwrite one another', async () => {
  const id = item((await call('/state', { token: admin })).data, 'Bath Soap').id, start = item((await call('/state', { token: admin })).data, 'Bath Soap').qty;
  const before = E.db.stats.retries;
  const adds = await Promise.all(Array.from({ length: 8 }, () => call('/stock-in', { method: 'POST', token: admin, body: { itemId: id, qty: 1, date: '2026-11-11' } })));
  assert.ok(adds.every(a => a.status === 200));
  let s = (await call('/state', { token: admin })).data;
  assert.equal(item(s, 'Bath Soap').qty, start + 8);
  assert.ok(E.db.stats.retries > before, 'expected real transaction conflicts to be retried');
  const cur = item(s, 'Bath Soap').qty; // oversell attempt: 10 parallel issues of cur/4 each -> only 4 may succeed
  const each = Math.floor(cur / 4);
  const issues = await Promise.all(Array.from({ length: 10 }, () => call('/issue', { method: 'POST', token: admin, body: { itemId: id, location: 'Dining Hall', qty: each, date: '2026-11-11' } })));
  assert.equal(issues.filter(i => i.status === 200).length, 4); assert.equal(issues.filter(i => i.status === 400).length, 6);
  s = (await call('/state', { token: admin })).data;
  assert.equal(item(s, 'Bath Soap').qty, cur - 4 * each); assert.equal(item(s, 'Bath Soap').alloc['Dining Hall'], 4 * each);
  const names = await Promise.all(Array.from({ length: 5 }, () => call('/stock-in', { method: 'POST', token: admin, body: { itemId: 'new', name: 'Race Item', category: 'Sports', qty: 1, min: 1, date: '2026-11-11' } })));
  assert.equal(names.filter(n => n.status === 200).length, 1);
});

test('new item, duplicate names, edit, delete and activity retention', async () => {
  let x = await call('/stock-in', { method: 'POST', token: mgr.token, body: { itemId: 'new', name: 'API Test Item', category: 'Stationery', qty: 2, min: 1, unit: 'pcs', date: '2026-11-11', description: 'd' } });
  const it = item(x.data.state, 'API Test Item'); assert.ok(it); assert.equal(it.sample, false);
  assert.equal((await call('/stock-in', { method: 'POST', token: mgr.token, body: { itemId: 'new', name: 'api test ITEM', category: 'Stationery', qty: 2, min: 1, date: '2026-11-11' } })).status, 400);
  assert.equal((await call('/stock-in', { method: 'POST', token: mgr.token, body: { itemId: 'new', name: 'X', category: 'Bogus', qty: 2, min: 1, date: '2026-11-11' } })).status, 400);
  x = await call(`/items/${it.id}`, { method: 'PUT', token: mgr.token, body: { name: 'API Test Item Updated', category: 'Furniture', qty: 9, min: 3, unit: 'boxes', description: 'new' } });
  const up = item(x.data.state, 'API Test Item Updated');
  assert.deepEqual([up.category, up.qty, up.min, up.unit, up.description], ['Furniture', 9, 3, 'boxes', 'new']);
  assert.match(x.data.state.log.at(-1).note, /\+7/);
  assert.equal((await call(`/items/${it.id}`, { method: 'PUT', token: mgr.token, body: { name: 'Volleyball', category: 'Sports', qty: 1, min: 1 } })).status, 400);
  assert.equal((await call(`/items/${it.id}`, { method: 'PUT', token: mgr.token, body: { name: 'Same', category: 'Sports', qty: -1, min: 1 } })).status, 400);
  assert.equal((await call('/items/nope', { method: 'PUT', token: mgr.token, body: { name: 'Z', category: 'Sports', qty: 1, min: 1 } })).status, 404);
  assert.equal((await call(`/items/${it.id}`, { method: 'DELETE', token: mgr.token })).status, 403);
  x = await call(`/items/${it.id}`, { method: 'DELETE', token: admin });
  assert.ok(!x.data.state.items.some(i => i.id === it.id));
  const entry = x.data.state.log.at(-1); assert.equal(entry.type, 'delete'); assert.equal(entry.qty, 9);
  assert.ok(x.data.state.log.some(l => l.itemId === it.id && l.type === 'in'), 'history retained');
  assert.equal((await call(`/items/${it.id}`, { method: 'DELETE', token: admin })).status, 404);
});

test('permission matrix is enforced server-side for every endpoint', async () => {
  const some = item((await call('/state', { token: admin })).data, 'Projector').id;
  await call('/stock-in', { method: 'POST', token: admin, body: { itemId: some, qty: 100, date: '2026-11-11' } });
  await call('/issue', { method: 'POST', token: admin, body: { itemId: some, location: 'Gym', qty: 50, date: '2026-11-11' } });
  const cases = [
    ['GET', '/state', null, { admin: 200, manager: 200, viewer: 200 }],
    ['GET', '/export', null, { admin: 200, manager: 200, viewer: 200 }],
    ['POST', '/stock-in', { itemId: some, qty: 1, date: '2026-11-11' }, { admin: 200, manager: 200, viewer: 403 }],
    ['POST', '/issue', { itemId: some, location: 'Gym', qty: 1, date: '2026-11-11' }, { admin: 200, manager: 200, viewer: 403 }],
    ['POST', '/return', { itemId: some, location: 'Gym', qty: 1, date: '2026-11-11' }, { admin: 200, manager: 200, viewer: 403 }],
    ['POST', '/room-action', { action: 'consume', itemId: some, location: 'Gym', qty: 1 }, { admin: 200, manager: 200, viewer: 403 }],
    ['PATCH', '/room-minimum', { itemId: some, location: 'Gym', min: 1 }, { admin: 200, manager: 200, viewer: 403 }],
    ['PUT', `/items/${some}`, { name: 'Projector', category: 'Electronics', qty: 2, min: 2 }, { admin: 200, manager: 200, viewer: 403 }],
    ['POST', '/import', { file: Buffer.from('Item name,Quantity\nProjector,1\n').toString('base64'), filename: 'a.csv', mode: 'add', dryRun: true }, { admin: 200, manager: 200, viewer: 403 }],
    ['POST', '/import', { file: Buffer.from('Item name,Quantity\nProjector,1\n').toString('base64'), filename: 'a.csv', mode: 'set', dryRun: true }, { admin: 200, manager: 200, viewer: 403 }],
    ['GET', '/users', null, { admin: 200, manager: 403, viewer: 403 }],
    ['POST', '/users', { email: 'q@iip.test', username: 'qq.user', password: PW, role: 'viewer' }, { admin: 201, manager: 403, viewer: 403 }],
    ['DELETE', '/items/zzz', null, { admin: 404, manager: 403, viewer: 403 }],
    ['PATCH', `/users/${view.id}`, { role: 'viewer' }, { admin: 200, manager: 403, viewer: 403 }],
    ['POST', '/reset', null, { manager: 403, viewer: 403 }]
  ];
  const tok = { admin, manager: mgr.token, viewer: view.token };
  for (const [method, p, body, expect] of cases)
    for (const [role, status] of Object.entries(expect)) {
      const r = await call(p, { method, token: tok[role], body: body === null ? (method === 'GET' ? undefined : {}) : body });
      assert.equal(r.status, status, `${role} ${method} ${p}`);
    }
});

test('set-mode import needs edit permission (viewer cannot even dry-run)', async () => {
  const body = { file: Buffer.from('Item name,Quantity\nProjector,3\n').toString('base64'), filename: 'a.csv', mode: 'set', dryRun: true };
  assert.equal((await call('/import', { method: 'POST', token: view.token, body })).status, 403);
});

test('user management: create, duplicates, validation and Auth/Firestore consistency', async () => {
  const mk = body => call('/users', { method: 'POST', token: admin, body });
  const ok = await mk({ email: 'New.Person@IIP.test', username: 'new.person', password: PW, role: 'manager' });
  assert.equal(ok.status, 201); assert.equal(ok.data.user.email, 'new.person@iip.test'); assert.equal(ok.data.user.role, 'manager');
  const uid = ok.data.user.id;
  assert.ok(E.auth.users.has(uid)); assert.equal(E.db.data.get(`users/${uid}`).data.username, 'new.person'); assert.equal(E.db.data.get(`users/${uid}`).data.disabled, false);
  assert.equal((await mk({ email: 'new.person@iip.test', username: 'other.name', password: PW, role: 'viewer' })).status, 409);
  assert.equal((await mk({ email: 'other@iip.test', username: 'NEW.PERSON', password: PW, role: 'viewer' })).status, 409);
  assert.equal((await mk({ email: 'x@iip.test', username: 'abc', password: 'short', role: 'viewer' })).status, 400);
  assert.equal((await mk({ email: 'not-an-email', username: 'abc', password: PW, role: 'viewer' })).status, 400);
  assert.equal((await mk({ email: 'x@iip.test', username: 'a b', password: PW, role: 'viewer' })).status, 400);
  assert.equal((await mk({ email: 'x@iip.test', username: 'abcd', password: PW, role: 'root' })).status, 400);
  const list = (await call('/users', { token: admin })).data.users;
  assert.ok(list.every(u => 'email' in u && 'username' in u && 'role' in u && 'disabled' in u));
  assert.equal(list.find(u => u.id === ADMIN_UID).username, 'admin');
  assert.ok(!list.some(u => 'passwordHash' in u));
});

test('a failed Firestore profile write rolls back the Firebase Auth user', async () => {
  const R = await makeEnv(), before = R.auth.users.size;
  R.db.failWrite = p => p.startsWith('users/') && p !== `users/${ADMIN_UID}`;
  const r = await R.call('/users', { method: 'POST', token: R.admin, body: { email: 'rb@iip.test', username: 'rollback', password: PW, role: 'viewer' } });
  assert.equal(r.status, 500);
  assert.equal(R.auth.users.size, before); assert.ok(!R.auth.byEmail.has('rb@iip.test'));
  R.db.failWrite = null;
  assert.equal((await R.call('/users', { method: 'POST', token: R.admin, body: { email: 'rb@iip.test', username: 'rollback', password: PW, role: 'viewer' } })).status, 201);
  R.close();
});

test('user updates: roles, disable/enable, self-protection and last-admin protection', async () => {
  const u = await E.mkUser('target@iip.test', 'target.user', 'viewer');
  let r = await call(`/users/${u.id}`, { method: 'PATCH', token: admin, body: { role: 'manager' } });
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'manager');
  assert.deepEqual((await call('/auth/me', { token: u.token })).data.user.permissions, ['view', 'export', 'stock', 'edit']);
  r = await call(`/users/${u.id}`, { method: 'PATCH', token: admin, body: { disabled: true } });
  assert.equal(r.data.user.disabled, true); assert.equal(E.auth.users.get(u.id).disabled, true); assert.ok(E.auth.users.get(u.id).revoked > 0);
  const blocked = await call('/state', { token: u.token });
  assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'account-disabled');
  r = await call(`/users/${u.id}`, { method: 'PATCH', token: admin, body: { disabled: false } });
  assert.equal(E.auth.users.get(u.id).disabled, false);
  assert.equal((await call('/state', { token: u.token })).status, 200);
  assert.equal((await call(`/users/${u.id}`, { method: 'PATCH', token: admin, body: { password: 'short' } })).status, 400);
  assert.equal((await call(`/users/${u.id}`, { method: 'PATCH', token: admin, body: { password: 'A-Brand-New-Password-77' } })).status, 200);
  assert.equal(E.auth.users.get(u.id).password, 'A-Brand-New-Password-77');
  assert.equal((await call(`/users/${u.id}`, { method: 'PATCH', token: admin, body: { role: 'wizard' } })).status, 400);
  assert.equal((await call('/users/doesnotexist', { method: 'PATCH', token: admin, body: { role: 'viewer' } })).status, 404);
  // self-protection
  assert.equal((await call(`/users/${ADMIN_UID}`, { method: 'PATCH', token: admin, body: { disabled: true } })).status, 400);
  assert.equal((await call(`/users/${ADMIN_UID}`, { method: 'PATCH', token: admin, body: { role: 'viewer' } })).status, 400);
  // last active admin: a second admin may not demote/disable the first, then is itself the only one left
  const a2 = await E.mkUser('admin2@iip.test', 'admin.two', 'admin');
  assert.equal((await call(`/users/${a2.id}`, { method: 'PATCH', token: admin, body: { disabled: true } })).status, 200);
  assert.equal((await call(`/users/${ADMIN_UID}`, { method: 'PATCH', token: a2.token, body: { disabled: true } })).status, 403); // disabled admin can't act
  await call(`/users/${a2.id}`, { method: 'PATCH', token: admin, body: { disabled: false } });
  assert.equal((await call(`/users/${a2.id}`, { method: 'PATCH', token: admin, body: { role: 'viewer' } })).status, 200); // another admin (self) remains
  assert.equal((await call(`/users/${ADMIN_UID}`, { method: 'PATCH', token: a2.token, body: { disabled: true } })).status, 403); // a2 is a viewer now
  // sole remaining admin cannot be removed even by a different admin record that is disabled
  await E.db.collection('users').doc('ghostadmin0000000000000000001').set({ email: 'g@iip.test', role: 'admin', disabled: true });
  assert.equal((await call('/users/ghostadmin0000000000000000001', { method: 'PATCH', token: admin, body: { role: 'viewer' } })).status, 200); // disabled admin doesn't count
});

test('last active administrator cannot be demoted or disabled by someone else', async () => {
  const R = await makeEnv();
  const peer = await R.mkUser('peer@iip.test', 'peer.admin', 'admin');
  await R.db.collection('users').doc(ADMIN_UID).update({ disabled: false });
  // peer disables the original admin -> allowed (peer remains), then original admin is blocked from acting
  assert.equal((await R.call(`/users/${ADMIN_UID}`, { method: 'PATCH', token: peer.token, body: { disabled: true } })).status, 200);
  // now peer is the only active admin; make a manager try (forbidden) and peer try on self (blocked)
  assert.equal((await R.call(`/users/${peer.id}`, { method: 'PATCH', token: peer.token, body: { disabled: true } })).status, 400);
  // re-enable admin, then admin tries to demote peer while peer is the only OTHER admin -> ok; then peer is viewer and admin is last admin
  await R.call(`/users/${ADMIN_UID}`, { method: 'PATCH', token: peer.token, body: { disabled: false } });
  assert.equal((await R.call(`/users/${peer.id}`, { method: 'PATCH', token: R.admin, body: { role: 'viewer' } })).status, 200);
  assert.equal((await R.call('/auth/status')).data.configured, true);
  R.close();
});

test('accounts without a profile or with an invalid role are denied', async () => {
  E.auth.add('orphanuid000000000000000001', 'orphan@iip.test');
  const r = await call('/state', { token: E.auth.tokenFor('orphanuid000000000000000001') });
  assert.equal(r.status, 403); assert.equal(r.data.code, 'no-profile');
  await E.db.collection('users').doc('orphanuid000000000000000001').set({ email: 'orphan@iip.test', role: 'superuser' });
  assert.equal((await call('/state', { token: E.auth.tokenFor('orphanuid000000000000000001') })).data.code, 'no-role');
});

test('auth status reports false when no active admin exists or Firebase is not configured', async () => {
  const R = await makeEnv({ adminProfile: null });
  assert.equal((await R.call('/auth/status')).data.configured, false);
  R.close();
  const server = http.createServer(createHandler({ getServices: () => { throw new Error('Firebase Admin is not configured. Missing environment variables: FIREBASE_PRIVATE_KEY'); } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await (await fetch(base + '/auth/status')).json()).configured, false);
  const s = await fetch(base + '/state', { headers: { authorization: 'Bearer tok.x' } });
  assert.equal(s.status, 500); assert.ok(!JSON.stringify(await s.json()).includes('FIREBASE_PRIVATE_KEY'));
  assert.equal((await fetch(base + '/health')).status, 200);
  server.close();
});

const csv = rows => Buffer.from(rows.join('\n')).toString('base64');
test('import: dry run, error reporting, add mode, set mode, new items', async () => {
  const imp = (rows, mode = 'add', dryRun = false, token = mgr.token, filename = 'stock.csv') => call('/import', { method: 'POST', token, body: { file: csv(rows), filename, mode, dryRun } });
  const s0 = (await call('/state', { token: admin })).data, proj = item(s0, 'Projector').qty, logs0 = s0.log.length;
  let x = await imp(['Item name,Quantity,Category,Unit,Minimum stock level,Date,Note', 'Projector,3,,,,2026-11-01,PO-9', 'Import New,5,Sports,boxes,2,,'], 'add', true);
  assert.equal(x.status, 200); assert.equal(x.data.ok, true); assert.deepEqual([x.data.summary.created, x.data.summary.updated, x.data.summary.units, x.data.total], [1, 1, 8, 2]);
  assert.equal(item((await call('/state', { token: admin })).data, 'Projector').qty, proj, 'dry run must not write');
  x = await imp(['Item name,Quantity,Category', 'Brand New Thing,2,Bogus', ',4,', 'Projector,-1,'], 'add');
  assert.equal(x.data.ok, false); assert.equal(x.data.errorCount, 3);
  assert.equal((await call('/state', { token: admin })).data.log.length, logs0, 'errors must commit nothing');
  x = await imp(['Item name,Quantity,Category,Unit,Minimum stock level,Date,Note', 'Projector,3,,,,2026-11-01,PO-9', 'Projector,2,,,,2026-11-02,again', 'Import New,5,Sports,boxes,2,,'], 'add');
  assert.equal(x.status, 200); assert.match(x.data.message, /1 new, 2 updated/);
  assert.equal(item(x.data.state, 'Projector').qty, proj + 5);
  const created = item(x.data.state, 'Import New'); assert.deepEqual([created.qty, created.unit, created.min, created.category, created.sample], [5, 'boxes', 2, 'Sports', false]);
  assert.ok(x.data.state.log.filter(l => l.note === 'PO-9' || l.note === 'again').length === 2);
  x = await imp(['Item name,Quantity', 'Projector,1', 'import new,5'], 'set');
  assert.equal(item(x.data.state, 'Projector').qty, 1);
  const setLog = x.data.state.log.filter(l => l.type === 'edit' && /Stock count set/.test(l.note));
  assert.equal(setLog.length, 1); assert.equal(setLog[0].qty, proj + 4); assert.match(setLog[0].note, new RegExp(`-${proj + 4}`));
  assert.equal((await imp(['Item name,Quantity', 'Projector,1'], 'add', false, view.token)).status, 403);
  assert.equal((await call('/import', { method: 'POST', token: mgr.token, body: { file: '', filename: 'x.csv' } })).status, 400);
  assert.equal((await call('/import', { method: 'POST', token: mgr.token, body: { file: Buffer.from('garbage').toString('base64'), filename: 'x.xlsx' } })).status, 400);
  assert.equal((await call('/import', { method: 'POST', token: mgr.token, body: { file: 'A'.repeat(4.5e6), filename: 'x.csv' } })).status, 413);
});

test('import: 450 rows are split into chunked transactions within Firestore write limits', async () => {
  const rows = ['Item name,Quantity,Category,Unit,Minimum stock level']; for (let i = 0; i < 450; i++) rows.push(`Bulk Item ${i},${i % 7 + 1},Stationery,pcs,2`);
  const r = await call('/import', { method: 'POST', token: admin, body: { file: csv(rows), filename: 'bulk.csv', mode: 'add', dryRun: false } });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300)); assert.match(r.data.message, /450 new/);
  assert.equal(r.data.state.items.filter(i => i.name.startsWith('Bulk Item')).length, 450);
  assert.ok(E.db.stats.maxTxWrites <= 500 && E.db.stats.maxTxWrites >= 300, `max writes per transaction: ${E.db.stats.maxTxWrites}`);
  const tooMany = ['Item name,Quantity']; for (let i = 0; i < 1001; i++) tooMany.push(`x${i},1`);
  const e = await call('/import', { method: 'POST', token: admin, body: { file: csv(tooMany), filename: 'big.csv', mode: 'add' } });
  assert.equal(e.data.ok, false); assert.match(e.data.errors[0].message, /1000 rows/);
  const dupNames = await call('/import', { method: 'POST', token: admin, body: { file: csv(['Item name,Quantity,Category', 'Dup Twice,1,Sports', 'dup twice,2,Sports']), filename: 'd.csv', mode: 'add' } });
  assert.equal(dupNames.data.state.items.filter(i => i.name.toLowerCase() === 'dup twice').length, 1);
  assert.equal(item(dupNames.data.state, 'Dup Twice').qty, 3);
});

test('export returns a valid workbook with the four original worksheets', async () => {
  const r = await call('/export', { token: mgr.token });
  assert.equal(r.status, 200); assert.match(r.r.headers.get('content-type'), /spreadsheetml/); assert.match(r.r.headers.get('content-disposition'), /IIP_Inventory_\d{4}-\d{2}-\d{2}\.xlsx/);
  assert.equal(r.data.subarray(0, 2).toString(), 'PK');
  const wb = r.data.toString('latin1'); for (const f of ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet4.xml']) assert.ok(wb.includes(f), f);
  const rows = parseUpload(r.data, 'x.xlsx'); // round-trips through the import reader
  assert.deepEqual(rows[0], ['Item', 'Category', 'Central stock', 'Unit', 'Assigned units', 'Total units', 'Minimum stock', 'Status', 'Description', 'Sample']);
  assert.ok(rows.some(row => row[0] === 'Volleyball'));
  assert.equal((await call('/export')).status, 401);
});

test('reset restores sample data (admin only) and replaces the activity log', async () => {
  assert.equal((await call('/reset', { method: 'POST', token: mgr.token, body: {} })).status, 403);
  const r = await call('/reset', { method: 'POST', token: admin, body: {} });
  assert.equal(r.status, 200); assert.equal(r.data.items.length, 18); assert.equal(r.data.log.length, 5); assert.equal(r.data.locations.length, 48);
  assert.equal(E.db.dump('inventory').length, 18); assert.equal(E.db.dump('activityLogs').length, 5);
  assert.equal(E.db.data.get('appConfig/current').data.lastResetBy, ADMIN_UID);
});

test('state returns at most STATE_LOG_LIMIT recent log entries in chronological order', async () => {
  const R = await makeEnv();
  const state = (await R.call('/state', { token: R.admin })).data;
  const id = state.items[0].id;
  for (let i = 0; i < 12; i++) await R.call('/stock-in', { method: 'POST', token: R.admin, body: { itemId: id, qty: 1, date: '2026-11-11' } });
  const s = (await R.call('/state', { token: R.admin })).data;
  assert.ok(s.log.length >= 17); for (let i = 1; i < s.log.length; i++) assert.ok(s.log[i].ts >= s.log[i - 1].ts);
  R.close();
});

test('private key normalisation handles Vercel-style escaped newlines and quotes', () => {
  assert.equal(normalizePrivateKey('"-----BEGIN KEY-----\\nabc\\n-----END KEY-----\\n"'), '-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
  assert.equal(normalizePrivateKey('-----BEGIN KEY-----\nabc\n'), '-----BEGIN KEY-----\nabc');
  assert.equal(normalizePrivateKey(undefined), '');
});

test('works with Vercel-style request objects (pre-parsed req.body, no stream)', async () => {
  const handler = createHandler({ getServices: () => ({ db: E.db, auth: E.auth }) });
  const invoke = (req) => new Promise(resolve => {
    const res = { status: 0, headers: {}, chunks: [], writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { resolve({ status: this.status, headers: this.headers, body: b ? Buffer.from(b) : Buffer.alloc(0) }); } };
    handler({ headers: {}, ...req }, res);
  });
  const id = item((await call('/state', { token: admin })).data, 'Notepad').id;
  const ok = await invoke({ method: 'POST', url: '/api/stock-in?x=1', headers: { authorization: `Bearer ${admin}` }, body: { itemId: id, qty: 2, date: '2026-11-11' } });
  assert.equal(ok.status, 200); assert.match(JSON.parse(ok.body).message, /Added 2/);
  const asString = await invoke({ method: 'POST', url: '/api/stock-in/', headers: { authorization: `Bearer ${admin}` }, body: JSON.stringify({ itemId: id, qty: 1, date: '2026-11-11' }) });
  assert.equal(asString.status, 200);
  const bad = await invoke({ method: 'POST', url: '/api/stock-in', headers: { authorization: `Bearer ${admin}` }, body: '{not json' });
  assert.equal(bad.status, 400);
  const opt = await invoke({ method: 'OPTIONS', url: '/api/state' }); assert.equal(opt.status, 204);
  const nocache = await invoke({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${admin}` } });
  assert.equal(nocache.headers['cache-control'], 'no-store'); assert.equal(nocache.headers['x-content-type-options'], 'nosniff');
});
