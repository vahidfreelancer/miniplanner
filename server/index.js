import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { apiMiddleware } from './api.js';
import { DB_PATH, getDb } from './db.js';

const PORT = Number(process.env.PORT || 5173);
const DIST_DIR = path.resolve('dist');
const handleApi = apiMiddleware();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

getDb();

const server = http.createServer(async (req, res) => {
  const handled = await handleApi(req, res);
  if (handled) return;

  const urlPath = (req.url || '/').split('?')[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(DIST_DIR, safePath === '/' || safePath === '\\' ? 'index.html' : safePath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Build not found. Run `npm run build` first, or use `npm run dev` in development.');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`MiniPlanner server listening on http://localhost:${PORT} (SQLite: ${DB_PATH})`);
});
