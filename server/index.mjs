// Local development / self-hosting server. Runs the exact same API handler that Vercel runs in production
// (Firebase Auth + Firestore via the Admin SDK) and serves the built frontend from /dist when present.
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.mjs';
import { getServices } from './firebase.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3001);
const api = createHandler({ getServices });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (p.startsWith('/api/')) return api(req, res);
  const dist = path.join(ROOT, 'dist');
  try {
    let target = path.resolve(dist, '.' + decodeURIComponent(p));
    if (!target.startsWith(dist + path.sep) && target !== dist) target = path.join(dist, 'index.html');
    let st = await fs.stat(target).catch(() => null);
    if (!st || st.isDirectory()) { target = path.join(st ? target : dist, 'index.html'); st = await fs.stat(target); }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream', 'content-length': st.size, 'x-content-type-options': 'nosniff' });
    fsSync.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found. Run "npm run build" first, or use "npm run dev".');
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`IIP Inventory API listening on port ${PORT}`));
