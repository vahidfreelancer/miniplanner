import { clearSessionCookie, parseDevice, parseSessionToken, serializeSessionCookie } from './auth.js';
import {
  DB_PATH,
  changeUserPassword,
  createCommentResource,
  createProjectResource,
  createTaskResource,
  deleteProjectResource,
  deleteTaskResource,
  disableUser2fa,
  getAdminIsolationReport,
  getAdminMemberProjects,
  getAdminProjectMembers,
  getAuthStatus,
  getProjectResource,
  getTransactions,
  loadState,
  loginUser,
  logoutSession,
  patchProjectResource,
  patchTaskResource,
  resetState,
  revokeUserSessions,
  saveState,
  setupUser2fa,
  signupUser,
  updateAdminMemberProjects,
  updateAdminProjectMembers,
  verifyAndEnableUser2fa,
} from './db.js';

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

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function getQueryParams(rawUrl = '') {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return new URLSearchParams();
  return new URLSearchParams(rawUrl.slice(qIdx + 1));
}

export function apiMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url || '';
    const url = rawUrl.split('?')[0];
    if (!url.startsWith('/api/')) {
      if (next) return next();
      return false;
    }

    try {
      const token = parseSessionToken(req);

      /* =========================================================
         AUTH ENDPOINTS (/api/auth/*)
         ========================================================= */
      if (req.method === 'GET' && url === '/api/auth/me') {
        const auth = getAuthStatus(token);
        sendJson(res, 200, auth);
        return true;
      }

      if (req.method === 'POST' && url === '/api/auth/signup') {
        const body = await readJsonBody(req);
        const device = parseDevice(req.headers['user-agent'] || '');
        const result = signupUser({
          name: body.name,
          email: body.email,
          password: body.password,
          remember: body.remember !== false,
          device,
          location: 'Local',
        });

        if (!result.ok) {
          sendJson(res, result.status || 400, {
            ok: false,
            field: result.field,
            error: result.error,
          });
          return true;
        }

        if (result.pendingApproval) {
          sendJson(res, result.status || 201, {
            ok: true,
            pendingApproval: true,
            isFirstOwner: false,
            member: result.member,
          });
          return true;
        }

        sendJson(
          res,
          result.status || 201,
          {
            ok: true,
            pendingApproval: false,
            isFirstOwner: result.isFirstOwner,
            member: result.member,
            state: result.state,
          },
          { 'Set-Cookie': serializeSessionCookie(result.token, result.ttlSec) },
        );
        return true;
      }

      if (req.method === 'POST' && url === '/api/auth/login') {
        const body = await readJsonBody(req);
        const device = parseDevice(req.headers['user-agent'] || '');
        const result = loginUser({
          email: body.email,
          password: body.password,
          remember: body.remember !== false,
          totpCode: body.totpCode || '',
          device,
          location: 'Local',
        });

        if (!result.ok) {
          sendJson(res, result.status || 401, {
            ok: false,
            require2fa: Boolean(result.require2fa),
            field: result.field,
            error: result.error,
          });
          return true;
        }

        sendJson(
          res,
          200,
          {
            ok: true,
            member: result.member,
            state: result.state,
          },
          { 'Set-Cookie': serializeSessionCookie(result.token, result.ttlSec) },
        );
        return true;
      }

      if (req.method === 'POST' && url === '/api/auth/logout') {
        logoutSession(token);
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
        return true;
      }

      if (req.method === 'POST' && url === '/api/auth/password') {
        const auth = getAuthStatus(token);
        if (!auth.authenticated) {
          sendJson(res, 401, { ok: false, error: 'Authentication required' });
          return true;
        }
        const body = await readJsonBody(req);
        const result = changeUserPassword(auth.member?.id || 'm1', {
          currentPassword: body.currentPassword,
          newPassword: body.newPassword,
        });
        sendJson(res, result.status || (result.ok ? 200 : 400), result);
        return true;
      }

      if (req.method === 'DELETE' && url === '/api/auth/sessions') {
        const auth = getAuthStatus(token);
        if (!auth.authenticated) {
          sendJson(res, 401, { ok: false, error: 'Authentication required' });
          return true;
        }
        const qp = getQueryParams(rawUrl);
        const result = revokeUserSessions(auth.member?.id || 'm1', auth.session?.id || null, {
          sessionId: qp.get('id'),
          others: qp.get('others') === '1' || qp.get('others') === 'true',
        });
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'POST' && url === '/api/auth/2fa/setup') {
        const auth = getAuthStatus(token);
        if (!auth.authenticated) {
          sendJson(res, 401, { ok: false, error: 'Authentication required' });
          return true;
        }
        const result = setupUser2fa(auth.member?.id || 'm1');
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'POST' && url === '/api/auth/2fa/verify') {
        const auth = getAuthStatus(token);
        if (!auth.authenticated) {
          sendJson(res, 401, { ok: false, error: 'Authentication required' });
          return true;
        }
        const body = await readJsonBody(req);
        const result = verifyAndEnableUser2fa(auth.member?.id || 'm1', body.code);
        sendJson(res, result.status || (result.ok ? 200 : 400), result);
        return true;
      }

      if (req.method === 'DELETE' && url === '/api/auth/2fa') {
        const auth = getAuthStatus(token);
        if (!auth.authenticated) {
          sendJson(res, 401, { ok: false, error: 'Authentication required' });
          return true;
        }
        const result = disableUser2fa(auth.member?.id || 'm1');
        sendJson(res, 200, result);
        return true;
      }

      /* =========================================================
         STATE, RESET & TRANSACTIONS ENDPOINTS
         ========================================================= */
      const auth = getAuthStatus(token);
      if (!auth.authenticated) {
        sendJson(res, 401, { error: 'Authentication required', setupRequired: Boolean(auth.setupRequired) });
        return true;
      }

      const memberId = auth.member?.id || null;
      const sessionId = auth.session?.id || null;

      if (req.method === 'GET' && url === '/api/state') {
        sendJson(res, 200, loadState(memberId, sessionId));
        return true;
      }

      if ((req.method === 'PUT' || req.method === 'POST') && url === '/api/state') {
        const body = await readJsonBody(req);
        const result = saveState(body, body.action || 'save_state', memberId);
        sendJson(res, 200, result);
        return true;
      }

      if (req.method === 'POST' && url === '/api/reset') {
        if (auth.authenticated && auth.member?.role !== 'Owner') {
          sendJson(res, 403, { error: 'Only workspace owners can reset the workspace' });
          return true;
        }
        const fresh = resetState(memberId);
        sendJson(res, 200, fresh);
        return true;
      }

      if (req.method === 'GET' && url === '/api/transactions') {
        if (auth.authenticated && !['Owner', 'Admin'].includes(auth.member?.role)) {
          sendJson(res, 403, { error: 'Only workspace owners and admins can view audit transactions' });
          return true;
        }
        sendJson(res, 200, { dbPath: DB_PATH, transactions: getTransactions(100) });
        return true;
      }

      /* =========================================================
         ADMIN PROJECT MEMBERSHIP & ISOLATION ENDPOINTS
         ========================================================= */
      if (req.method === 'GET' && url === '/api/admin/isolation-report') {
        const result = getAdminIsolationReport(memberId);
        sendJson(res, result.status || 200, result);
        return true;
      }

      const projMemMatch = url.match(/^\/api\/admin\/projects\/([^/]+)\/members$/);
      if (projMemMatch) {
        const pid = decodeURIComponent(projMemMatch[1]);
        if (req.method === 'GET') {
          const result = getAdminProjectMembers(memberId, pid);
          sendJson(res, result.status || 200, result);
          return true;
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = updateAdminProjectMembers(memberId, pid, body);
          sendJson(res, result.status || 200, result);
          return true;
        }
      }

      const memProjMatch = url.match(/^\/api\/admin\/members\/([^/]+)\/projects$/);
      if (memProjMatch) {
        const targetMid = decodeURIComponent(memProjMatch[1]);
        if (req.method === 'GET') {
          const result = getAdminMemberProjects(memberId, targetMid);
          sendJson(res, result.status || 200, result);
          return true;
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = updateAdminMemberProjects(memberId, targetMid, body);
          sendJson(res, result.status || 200, result);
          return true;
        }
      }

      /* =========================================================
         GRANULAR RESOURCE ENDPOINTS (/api/projects, /api/tasks)
         ========================================================= */
      if (req.method === 'POST' && url === '/api/projects') {
        const body = await readJsonBody(req);
        const result = createProjectResource(memberId, body);
        sendJson(res, result.status || 201, result);
        return true;
      }

      const projItemMatch = url.match(/^\/api\/projects\/([^/]+)$/);
      if (projItemMatch) {
        const pid = decodeURIComponent(projItemMatch[1]);
        if (req.method === 'GET') {
          const result = getProjectResource(memberId, pid);
          sendJson(res, result.status || 200, result);
          return true;
        }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const result = patchProjectResource(memberId, pid, body);
          sendJson(res, result.status || 200, result);
          return true;
        }
        if (req.method === 'DELETE') {
          const result = deleteProjectResource(memberId, pid);
          sendJson(res, result.status || 200, result);
          return true;
        }
      }

      if (req.method === 'POST' && url === '/api/tasks') {
        const body = await readJsonBody(req);
        const result = createTaskResource(memberId, body);
        sendJson(res, result.status || 201, result);
        return true;
      }

      const taskItemMatch = url.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskItemMatch) {
        const tid = decodeURIComponent(taskItemMatch[1]);
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const result = patchTaskResource(memberId, tid, body);
          sendJson(res, result.status || 200, result);
          return true;
        }
        if (req.method === 'DELETE') {
          const result = deleteTaskResource(memberId, tid);
          sendJson(res, result.status || 200, result);
          return true;
        }
      }

      const taskCommentMatch = url.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentMatch && req.method === 'POST') {
        const tid = decodeURIComponent(taskCommentMatch[1]);
        const body = await readJsonBody(req);
        const result = createCommentResource(memberId, tid, body);
        sendJson(res, result.status || 201, result);
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
