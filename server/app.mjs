import { HttpError, ROLE_PERMISSIONS, CATS, today } from './util.mjs';
import { createStore } from './store.mjs';
import { createUsers } from './users.mjs';
import { parseUpload, planImport } from './import.mjs';
import { buildWorkbook } from './xlsx.mjs';

// Vercel rejects request bodies above 4.5 MB, and base64 inflates files by ~33%, so uploads are capped at ~3 MB.
const IMPORT_BODY_LIMIT = 4.4e6, JSON_BODY_LIMIT = 200_000;

const securityHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...securityHeaders });
  res.end(JSON.stringify(obj));
}

async function readJson(req, limit) {
  let raw = req.body;
  if (raw === undefined || raw === null) {
    let size = 0; const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'This file is too large. Import files up to 3 MB.');
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    if (raw.length > limit) throw new HttpError(413, 'This file is too large. Import files up to 3 MB.');
    try { raw = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'We couldn’t read that request. Try again.'); }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'We couldn’t read that request. Try again.');
  return raw;
}

export function createHandler({ getServices }) {
  let cached = null;
  const services = () => {
    const s = getServices();
    if (!cached || cached.src !== s) cached = { src: s, store: createStore(s.db), users: createUsers(s.db, s.auth), auth: s.auth };
    return cached;
  };

  async function authenticate(req, { users, auth }) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, 'Please sign in to continue.', 'no-token');
    let decoded;
    try { decoded = await auth.verifyIdToken(m[1]); } catch (e) {
      const expired = e?.code === 'auth/id-token-expired';
      throw new HttpError(401, expired ? 'Your session expired. Sign in again to continue.' : 'Please sign in to continue.', expired ? 'token-expired' : 'invalid-token');
    }
    return users.getProfile(decoded.uid, decoded.email);
  }

  const idFrom = p => decodeURIComponent(p.split('/').pop());
  const routes = (s) => [
    ['GET', /^\/api\/auth\/me$/, null, async ({ user }) => [200, { user }]],
    ['GET', /^\/api\/users$/, 'manageUsers', async () => [200, { users: await s.users.list() }]],
    ['POST', /^\/api\/users$/, 'manageUsers', async ({ user, req }) => [201, { user: await s.users.create(user, await readJson(req, JSON_BODY_LIMIT)) }]],
    ['PATCH', /^\/api\/users\/[^/]+$/, 'manageUsers', async ({ user, req, path }) => [200, { user: await s.users.update(user, idFrom(path), await readJson(req, JSON_BODY_LIMIT)) }]],
    ['GET', /^\/api\/state$/, 'view', async () => [200, await s.store.getState()]],
    ['POST', /^\/api\/reset$/, 'reset', async ({ user }) => [200, (await s.store.reset(user)).state]],
    ['POST', /^\/api\/stock-in$/, 'stock', async ({ user, req }) => [200, await s.store.stockIn(await readJson(req, JSON_BODY_LIMIT), user)]],
    ['POST', /^\/api\/issue$/, 'stock', async ({ user, req }) => [200, await s.store.issue(await readJson(req, JSON_BODY_LIMIT), user)]],
    ['POST', /^\/api\/return$/, 'stock', async ({ user, req }) => [200, await s.store.roomAction({ ...(await readJson(req, JSON_BODY_LIMIT)), action: 'return' }, user)]],
    ['POST', /^\/api\/room-action$/, 'stock', async ({ user, req }) => [200, await s.store.roomAction(await readJson(req, JSON_BODY_LIMIT), user)]],
    ['PATCH', /^\/api\/room-minimum$/, 'edit', async ({ user, req }) => [200, await s.store.roomMinimum(await readJson(req, JSON_BODY_LIMIT), user)]],
    ['PUT', /^\/api\/items\/[^/]+$/, 'edit', async ({ user, req, path }) => [200, await s.store.updateItem(idFrom(path), await readJson(req, JSON_BODY_LIMIT), user)]],
    ['DELETE', /^\/api\/items\/[^/]+$/, 'delete', async ({ user, path }) => [200, await s.store.deleteItem(idFrom(path), user)]],
    ['POST', /^\/api\/import$/, 'stock', async ({ user, req }) => [200, await importStock(s, user, await readJson(req, IMPORT_BODY_LIMIT))]],
    ['GET', /^\/api\/export$/, 'export', null]
  ];

  async function importStock(s, user, b) {
    const mode = b.mode === 'set' ? 'set' : 'add';
    if (mode === 'set' && !user.permissions.includes('edit')) throw new HttpError(403, 'Your account does not have permission to set stock counts.');
    const filename = String(b.filename || '');
    let rows;
    try { rows = parseUpload(Buffer.from(String(b.file || ''), 'base64'), filename); } catch (e) { throw new HttpError(400, e.message || 'We couldn’t read this file. Use .xlsx or .csv.'); }
    const plan = planImport(rows, await s.store.itemsForPlanning(), CATS, mode, today(), filename.slice(0, 60));
    const summary = {
      mode, created: plan.ops.filter(o => o.action === 'create').length, updated: plan.ops.filter(o => o.action !== 'create').length,
      units: plan.ops.reduce((a, o) => a + (o.action === 'set' ? o.after - o.before : o.qty), 0)
    };
    if (b.dryRun || plan.errors.length) return { ok: !plan.errors.length, errors: plan.errors.slice(0, 50), errorCount: plan.errors.length, summary, changes: plan.ops.slice(0, 100), total: plan.ops.length };
    await s.store.applyImport(plan.ops, user);
    return { ok: true, state: await s.store.getState(), message: `Import complete: ${summary.created} new, ${summary.updated} updated.` };
  }

  return async function handler(req, res) {
    try {
      
      const requestUrl = new URL(req.url, 'http://localhost');
      let path = requestUrl.pathname.replace(/\/+$/, '') || '/';
      
      // Vercel catch-all routes expose matched segments as req.query['...path'].
      const catchAllPath = req.query?.['...path'];
      if (Array.isArray(catchAllPath) && catchAllPath.length > 0) {
        path = `/api/${catchAllPath.map(String).join('/')}`;
      }
      else if (typeof catchAllPath === 'string' && catchAllPath.length > 0) {
        path = `/api/${catchAllPath}`;
      }
      const method = req.method;
      if (method === 'OPTIONS') { res.writeHead(204, securityHeaders); return res.end(); }
      if (path === '/api/health') return send(res, 200, { ok: true });
      if (!path.startsWith('/api/')) return send(res, 404, { error: 'Endpoint not found.' });
      if (path === '/api/auth/status' && method === 'GET') {
        try { return send(res, 200, { configured: await services().users.hasActiveAdmin() }); } catch (e) { console.error('Auth status check failed:', e?.message); return send(res, 200, { configured: false }); }
      }
      let s;
      try { s = services(); } catch (e) { console.error(e.message); throw new HttpError(500, 'The server is not configured correctly. Contact the administrator.', 'not-configured'); }
      const route = routes(s).find(([m, rx]) => m === method && rx.test(path));
      if (!route) return send(res, 404, { error: 'Endpoint not found.' });
      const user = await authenticate(req, s);
      const [, , perm, run] = route;
      if (perm && !user.permissions.includes(perm)) throw new HttpError(403, 'Your account does not have permission to perform this action.', 'forbidden');
      await s.store.ensureSeeded();
      if (path === '/api/export') {
        const bytes = buildWorkbook(await s.store.getState({ allLogs: true }));
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="IIP_Inventory_${today()}.xlsx"`, 'content-length': bytes.length, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
        return res.end(bytes);
      }
      const [status, body] = await run({ user, req, path });
      return send(res, status, body);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
      console.error('Unhandled API error:', e);
      return send(res, 500, { error: 'Something went wrong on our end. Try again in a moment.' });
    }
  };
}
export { ROLE_PERMISSIONS };
