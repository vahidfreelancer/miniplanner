import { DB_PATH, getTransactions, loadState, resetState, saveState } from './db.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function apiMiddleware() {
  return async (req, res, next) => {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/')) {
      if (next) return next();
      return false;
    }

    try {
      if (req.method === 'GET' && url === '/api/state') {
        sendJson(res, 200, loadState());
        return true;
      }

      if ((req.method === 'PUT' || req.method === 'POST') && url === '/api/state') {
        const body = await readJsonBody(req);
        const result = saveState(body, body.action || 'save_state');
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'POST' && url === '/api/reset') {
        const fresh = resetState();
        sendJson(res, 200, fresh);
        return true;
      }

      if (req.method === 'GET' && url === '/api/transactions') {
        sendJson(res, 200, { dbPath: DB_PATH, transactions: getTransactions(100) });
        return true;
      }

      sendJson(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      sendJson(res, 500, { error: err?.message || 'Internal server error' });
      return true;
    }
  };
}
