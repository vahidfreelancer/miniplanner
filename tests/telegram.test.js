import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiMiddleware } from '../server/api.js';
import { closeDb, getDb, loadState, loginUser, saveState, signupUser } from '../server/db.js';
import {
  clearMessageHandlers,
  declareMessageHandler,
  handleTelegramUpdate,
  onCommand,
  onMessage,
  pollTelegramUpdates,
  resetTelegramFetch,
  sendMessage,
  setTelegramFetch,
  stopTelegramPolling,
} from '../server/telegram.js';

function createTestServer() {
  const handleApi = apiMiddleware();
  const server = http.createServer(async (req, res) => {
    const handled = await handleApi(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function apiReq(baseUrl, method, urlPath, { token = null, body = null, headers: extraHeaders = {} } = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('Telegram Bot Module: Settings, Send, Receive, Handler Declaration, and Member Bot Login', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniplanner-tg-'));
  const dbFile = path.join(tmpDir, 'tg-test.sqlite');
  process.env.MINIPLANNER_DB_PATH = dbFile;
  closeDb();
  getDb(dbFile);

  const outboundCalls = [];
  let queuedUpdates = [];

  setTelegramFetch(async (url, init) => {
    const payload = init?.body ? JSON.parse(init.body) : {};
    outboundCalls.push({ url, payload });
    if (url.endsWith('/getMe')) {
      return {
        status: 200,
        json: async () => ({
          ok: true,
          result: { id: 999000, is_bot: true, first_name: 'MiniPlanner Bot', username: 'miniplanner_test_bot' },
        }),
      };
    }
    if (url.endsWith('/sendMessage')) {
      return {
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: outboundCalls.length,
            chat: { id: payload.chat_id },
            text: payload.text,
          },
        }),
      };
    }
    if (url.endsWith('/getUpdates')) {
      const batch = queuedUpdates.filter(u => !payload.offset || u.update_id >= payload.offset);
      queuedUpdates = [];
      return {
        status: 200,
        json: async () => ({
          ok: true,
          result: batch,
        }),
      };
    }
    return {
      status: 400,
      json: async () => ({ ok: false, description: 'Unknown Telegram method' }),
    };
  });

  const srv = await createTestServer();
  t.after(async () => {
    stopTelegramPolling();
    resetTelegramFetch();
    clearMessageHandlers();
    await srv.close();
    closeDb();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error on Windows */
    }
  });

  let adminToken;
  let adminId;
  let aliceToken;
  let aliceId;
  let bobToken;
  let bobId;

  await t.test('1. Setup workspace members (Owner, Alice, Bob) and verify Admin-only Telegram Bot settings', async () => {
    const owner = signupUser({
      name: 'Workspace Admin',
      email: 'admin@company.com',
      password: 'Password123!',
    });
    assert.equal(owner.ok, true);
    adminToken = owner.token;
    adminId = owner.member.id;

    const aliceSignup = signupUser({
      name: 'Alice Member',
      email: 'alice@company.com',
      password: 'AlicePassword123!',
    });
    assert.equal(aliceSignup.ok, true);
    aliceId = aliceSignup.member.id;

    const bobSignup = signupUser({
      name: 'Bob Member',
      email: 'bob@company.com',
      password: 'BobPassword123!',
    });
    assert.equal(bobSignup.ok, true);
    bobId = bobSignup.member.id;

    // Activate Alice and Bob, assign Alice to project p1, Bob to project p2
    const st = loadState(adminId);
    for (const m of st.data.members) {
      if (m.id === aliceId || m.id === bobId) m.status = 'active';
    }
    st.data.projects = [
      {
        id: 'p1',
        key: 'ALPHA',
        name: 'Project Alpha',
        icon: 'folder',
        color: 'indigo',
        status: 'progress',
        lead: aliceId,
        members: [adminId, aliceId],
        perms: { [aliceId]: 'Can edit' },
      },
      {
        id: 'p2',
        key: 'OMEGA',
        name: 'Project Omega',
        icon: 'folder',
        color: 'crimson',
        status: 'planning',
        lead: bobId,
        members: [adminId, bobId],
        perms: { [bobId]: 'Can edit' },
      },
    ];
    st.data.projOrder = ['p1', 'p2'];
    saveState(st, 'activate_members', adminId);

    const aliceLogin = loginUser({ email: 'alice@company.com', password: 'AlicePassword123!' });
    assert.equal(aliceLogin.ok, true);
    aliceToken = aliceLogin.token;

    const bobLogin = loginUser({ email: 'bob@company.com', password: 'BobPassword123!' });
    assert.equal(bobLogin.ok, true);
    bobToken = bobLogin.token;

    // Non-admin cannot save Telegram Bot settings
    const forbiddenSave = await apiReq(srv.baseUrl, 'PUT', '/api/telegram/settings', {
      token: aliceToken,
      body: { botToken: '123456:FAKE_TOKEN', enabled: true },
    });
    assert.equal(forbiddenSave.status, 403);

    // Admin saves & verifies Telegram Bot settings
    const adminSave = await apiReq(srv.baseUrl, 'PUT', '/api/telegram/settings', {
      token: adminToken,
      body: {
        botToken: '123456789:ABCDEF_TEST_BOT_TOKEN_9876',
        enabled: true,
        mode: 'webhook',
        webhookUrl: 'https://example.com/api/telegram/webhook',
        verify: true,
      },
    });
    assert.equal(adminSave.status, 200);
    assert.equal(adminSave.json.ok, true);
    assert.equal(adminSave.json.settings.enabled, true);
    assert.equal(adminSave.json.settings.hasToken, true);
    assert.equal(adminSave.json.settings.botUsername, 'miniplanner_test_bot');
    assert.ok(adminSave.json.settings.tokenMasked.includes('••••'));

    // Non-admin GET /api/telegram/settings sees public botUsername/enabled, NOT tokenMasked
    const aliceGet = await apiReq(srv.baseUrl, 'GET', '/api/telegram/settings', { token: aliceToken });
    assert.equal(aliceGet.status, 200);
    assert.equal(aliceGet.json.settings.botUsername, 'miniplanner_test_bot');
    assert.equal(aliceGet.json.settings.tokenMasked, undefined);
  });

  await t.test('2. Member logs in via the Telegram bot (/login) and Telegram ID & username are automatically saved in DB', async () => {
    outboundCalls.length = 0;

    // Simulate incoming Telegram update where Alice sends `/login alice@company.com AlicePassword123!`
    const loginUpdate = {
      update_id: 1001,
      message: {
        message_id: 50,
        from: {
          id: 77889900,
          is_bot: false,
          first_name: 'Alice',
          username: 'alice_tg_user',
        },
        chat: {
          id: 77889900,
          type: 'private',
        },
        text: '/login alice@company.com AlicePassword123!',
      },
    };

    const webhookRes = await apiReq(srv.baseUrl, 'POST', '/api/telegram/webhook', {
      body: loginUpdate,
    });
    assert.equal(webhookRes.status, 200);
    assert.equal(webhookRes.json.ok, true);
    assert.equal(webhookRes.json.command, 'login');
    assert.equal(webhookRes.json.member.id, aliceId);
    assert.equal(webhookRes.json.member.telegramId, '77889900');
    assert.equal(webhookRes.json.member.telegramUsername, 'alice_tg_user');

    // Bot replied confirming the login & saved Telegram ID/username
    assert.equal(outboundCalls.length, 1);
    assert.equal(outboundCalls[0].payload.chat_id, '77889900');
    assert.match(outboundCalls[0].payload.text, /Logged in and linked to Alice Member/);

    // Verify SQLite DB has persisted telegram_id and telegram_username on Alice's member row
    const db = getDb();
    const row = db.prepare('SELECT telegram_id, telegram_username, telegram_linked_at FROM members WHERE id = ?').get(aliceId);
    assert.equal(row.telegram_id, '77889900');
    assert.equal(row.telegram_username, 'alice_tg_user');
    assert.ok(row.telegram_linked_at > 0);

    // Verify regular /api/state save preserves telegram_id & telegram_username in DB!
    const aliceState = loadState(aliceId);
    const aliceSelf = aliceState.data.members.find(m => m.id === aliceId);
    assert.equal(aliceSelf.telegramId, '77889900');
    assert.equal(aliceSelf.telegramUsername, 'alice_tg_user');

    saveState(aliceState, 'update_profile', aliceId);
    const rowAfterSave = db.prepare('SELECT telegram_id, telegram_username FROM members WHERE id = ?').get(aliceId);
    assert.equal(rowAfterSave.telegram_id, '77889900');
    assert.equal(rowAfterSave.telegram_username, 'alice_tg_user');

    // Verify isolation: Bob (in a different project) cannot see Alice or her Telegram info
    const bobState = loadState(bobId);
    assert.equal(
      bobState.data.members.find(m => m.id === aliceId),
      undefined,
    );
  });

  await t.test('3. Member can also link via one-time link code (/link <CODE>) and auto-save Telegram ID & username', async () => {
    const codeRes = await apiReq(srv.baseUrl, 'POST', '/api/telegram/link-code', {
      token: bobToken,
    });
    assert.equal(codeRes.status, 200);
    assert.equal(codeRes.json.ok, true);
    const linkCode = codeRes.json.code;
    assert.match(linkCode, /^TG-[A-F0-9]+$/);

    const linkUpdate = {
      update_id: 1002,
      message: {
        message_id: 51,
        from: {
          id: 44556677,
          is_bot: false,
          first_name: 'Bob',
          username: 'bob_telegram',
        },
        chat: {
          id: 44556677,
          type: 'private',
        },
        text: `/link ${linkCode}`,
      },
    };

    const res = await handleTelegramUpdate(linkUpdate);
    assert.equal(res.ok, true);
    assert.equal(res.member.id, bobId);
    assert.equal(res.member.telegramId, '44556677');
    assert.equal(res.member.telegramUsername, 'bob_telegram');
  });

  await t.test('4. Declare custom message and command handlers (onMessage / declareMessageHandler / onCommand)', async () => {
    const receivedByCustomHandler = [];
    const receivedByRegexHandler = [];

    const unsubMsg = declareMessageHandler(async ctx => {
      receivedByCustomHandler.push({
        text: ctx.text,
        memberId: ctx.member?.id || null,
        telegramId: ctx.telegramId,
        telegramUsername: ctx.telegramUsername,
      });
    });

    const unsubRegex = onMessage(/^deploy\s+(.+)/i, async ctx => {
      receivedByRegexHandler.push(ctx.text);
      await ctx.reply(`Deploying for ${ctx.member?.name || 'Guest'}`);
    });

    const unsubCmd = onCommand('ping', async ctx => {
      await ctx.reply(`pong:${ctx.argsText || 'ok'}`);
    });

    outboundCalls.length = 0;

    // 1) Custom command `/ping fast` from linked Alice
    await handleTelegramUpdate({
      update_id: 1003,
      message: {
        message_id: 52,
        from: { id: 77889900, username: 'alice_tg_user' },
        chat: { id: 77889900 },
        text: '/ping fast',
      },
    });

    assert.equal(outboundCalls.length, 1);
    assert.equal(outboundCalls[0].payload.text, 'pong:fast');
    assert.equal(receivedByCustomHandler.length, 1);
    assert.equal(receivedByCustomHandler[0].memberId, aliceId);

    // 2) Regex-filtered message handler via getUpdates polling
    outboundCalls.length = 0;
    queuedUpdates.push({
      update_id: 1004,
      message: {
        message_id: 53,
        from: { id: 77889900, username: 'alice_tg_user' },
        chat: { id: 77889900 },
        text: 'deploy production-v2',
      },
    });

    const pollRes = await pollTelegramUpdates();
    assert.equal(pollRes.ok, true);
    assert.equal(pollRes.processed, 1);
    assert.deepEqual(receivedByRegexHandler, ['deploy production-v2']);
    assert.equal(outboundCalls[outboundCalls.length - 1].payload.text, 'Deploying for Alice Member');

    unsubMsg();
    unsubRegex();
    unsubCmd();
  });

  await t.test('5. Send messages directly via sendMessage() and POST /api/telegram/send with project isolation', async () => {
    outboundCalls.length = 0;

    // Direct module call by memberId (looks up Alice's saved telegram_id = 77889900)
    const directRes = await sendMessage(aliceId, 'Hello Alice from server module!');
    assert.equal(directRes.ok, true);
    assert.equal(outboundCalls.length, 1);
    assert.equal(outboundCalls[0].payload.chat_id, '77889900');
    assert.equal(outboundCalls[0].payload.text, 'Hello Alice from server module!');

    // API call by Admin to Bob
    const apiSendRes = await apiReq(srv.baseUrl, 'POST', '/api/telegram/send', {
      token: adminToken,
      body: { memberId: bobId, text: 'Hello Bob from Admin!' },
    });
    assert.equal(apiSendRes.status, 200);
    assert.equal(apiSendRes.json.ok, true);
    assert.equal(outboundCalls.length, 2);
    assert.equal(outboundCalls[1].payload.chat_id, '44556677');

    // Project isolation check: Alice (in p1) cannot send a Telegram message to Bob (in p2, not a co-member)
    const crossProjectSend = await apiReq(srv.baseUrl, 'POST', '/api/telegram/send', {
      token: aliceToken,
      body: { memberId: bobId, text: 'Trying to message across isolated projects' },
    });
    assert.equal(crossProjectSend.status, 403);
  });
});
