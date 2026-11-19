import crypto from 'node:crypto';
import {
  getDb,
  getMemberByTelegramId,
  getTelegramConfigInternal,
  linkMemberTelegramByCredentials,
  linkMemberTelegramById,
  loadState,
  setTelegramLastUpdateId,
  unlinkMemberTelegram,
} from './db.js';
import { getScope } from './authz.js';

/* =====================================================================
   TELEGRAM BOT MODULE (server/telegram.js)
   1. Send message (sendMessage, callTelegramApi)
   2. Receive message (handleTelegramUpdate, webhook & long-polling)
   3. Declare message & command handlers (onMessage, onCommand)
   4. Member login with bot & auto-save Telegram ID / username in DB
   ===================================================================== */

let _fetchImpl = (...args) => globalThis.fetch(...args);

export function setTelegramFetch(fn) {
  _fetchImpl = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
}

export function resetTelegramFetch() {
  _fetchImpl = (...args) => globalThis.fetch(...args);
}

/* ---------- One-time link codes for easy browser-to-bot login ---------- */
const _pendingLinkCodes = new Map(); // code -> { memberId, expiresAt }
const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function generateTelegramLinkCode(memberId) {
  if (!memberId) return null;
  const now = Date.now();
  for (const [k, v] of _pendingLinkCodes.entries()) {
    if (v.expiresAt <= now || v.memberId === memberId) {
      _pendingLinkCodes.delete(k);
    }
  }
  const code = 'TG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = now + LINK_CODE_TTL_MS;
  _pendingLinkCodes.set(code, { memberId, expiresAt });
  return { code, expiresAt };
}

export function consumeTelegramLinkCode(rawCode) {
  const clean = String(rawCode || '')
    .trim()
    .toUpperCase();
  const entry = _pendingLinkCodes.get(clean);
  if (!entry) return null;
  _pendingLinkCodes.delete(clean);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.memberId;
}

/* ---------- Low-level Telegram Bot API Client ---------- */
export async function callTelegramApi(method, payload = {}, options = {}) {
  const cfg = getTelegramConfigInternal();
  const token = options.token || cfg.botToken;
  if (!token) {
    return { ok: false, status: 400, error: 'Telegram Bot token is not configured' };
  }
  const fetchFn = options.fetchImpl || _fetchImpl;
  const url = `https://api.telegram.org/bot${token}/${method}`;

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data || !data.ok) {
      return {
        ok: false,
        status: res.status || 400,
        error: data?.description || `Telegram API ${method} failed`,
        raw: data,
      };
    }
    return {
      ok: true,
      status: 200,
      result: data.result,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err?.message || `Failed to reach Telegram API (${method})`,
    };
  }
}

export async function getBotInfo(options = {}) {
  return callTelegramApi('getMe', {}, options);
}

/* ---------- 1. Send Message ---------- */
/**
 * Send a message via Telegram Bot API.
 * `target` can be:
 * - `{ chatId, text, parseMode, replyToMessageId, replyMarkup }`
 * - `{ memberId, text, ... }` (looks up member's saved `telegram_id` in DB)
 * - Or called as `sendMessage(chatIdOrMemberId, text, extraOptions)`
 */
export async function sendMessage(targetOrChatId, textArg, extraOptions = {}) {
  let chatId = null;
  let memberId = null;
  let text = '';
  let opts = {};

  if (targetOrChatId && typeof targetOrChatId === 'object') {
    chatId = targetOrChatId.chatId ?? targetOrChatId.telegramId ?? null;
    memberId = targetOrChatId.memberId ?? null;
    text = String(targetOrChatId.text ?? '');
    opts = targetOrChatId;
  } else {
    const rawTarget = String(targetOrChatId ?? '').trim();
    text = String(textArg ?? '');
    opts = extraOptions || {};
    // Determine if rawTarget is a workspace member ID or a Telegram chat_id
    const db = getDb();
    const memberRow = rawTarget ? db.prepare('SELECT id, telegram_id FROM members WHERE id = ?').get(rawTarget) : null;
    if (memberRow) {
      memberId = memberRow.id;
      chatId = memberRow.telegram_id;
    } else {
      chatId = rawTarget;
    }
  }

  if (!chatId && memberId) {
    const db = getDb();
    const mRow = db.prepare('SELECT id, name, telegram_id FROM members WHERE id = ?').get(memberId);
    if (!mRow) {
      return { ok: false, status: 404, error: 'Recipient member not found' };
    }
    if (!mRow.telegram_id) {
      return { ok: false, status: 400, error: `${mRow.name || 'Member'} has not linked their Telegram account yet` };
    }
    chatId = mRow.telegram_id;
  }

  if (!chatId) {
    return { ok: false, status: 400, error: 'Telegram chatId or linked memberId is required' };
  }
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return { ok: false, status: 400, error: 'Message text is required' };
  }

  // Optional scope check when an actorMemberId is passed
  if (opts.actorMemberId) {
    const db = getDb();
    const scope = getScope(db, opts.actorMemberId);
    if (!scope.isAdmin) {
      // Non-admins can only message themselves or visible co-members
      const recipientRow = memberId
        ? db.prepare('SELECT id FROM members WHERE id = ?').get(memberId)
        : db.prepare('SELECT id FROM members WHERE telegram_id = ?').get(String(chatId));
      if (!recipientRow || !scope.coMemberIds.has(recipientRow.id)) {
        return { ok: false, status: 403, error: 'You can only send Telegram messages to members in your projects' };
      }
    }
  }

  const apiPayload = {
    chat_id: String(chatId),
    text: cleanText,
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    ...(opts.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
  };

  const resp = await callTelegramApi('sendMessage', apiPayload, {
    token: opts.token,
    fetchImpl: opts.fetchImpl,
  });

  if (resp.ok) {
    const db = getDb();
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'telegram_send_message',
      Date.now(),
      JSON.stringify({
        actor: opts.actorMemberId || 'bot',
        chatId: String(chatId),
        memberId: memberId || null,
        preview: cleanText.slice(0, 80),
      }),
    );
  }

  return resp;
}

/* ---------- 3. Declarative Message & Command Handler Registry ---------- */
const _messageHandlers = []; // Array<{ id, filter, handler }>
const _commandHandlers = new Map(); // commandName (without /) -> Array<{ id, handler }>
let _handlerSeq = 0;

/**
 * Declare a handler for incoming Telegram messages.
 * Usage:
 *   onMessage(async (ctx) => { ... })
 *   onMessage((ctx) => ctx.text.includes('urgent'), async (ctx) => { ... })
 *   onMessage(/ticket-\d+/i, async (ctx) => { ... })
 * Returns an unsubscribe function `() => void`.
 */
export function onMessage(filterOrHandler, maybeHandler) {
  let filter = null;
  let handler = null;

  if (typeof filterOrHandler === 'function' && typeof maybeHandler === 'function') {
    filter = filterOrHandler;
    handler = maybeHandler;
  } else if (filterOrHandler instanceof RegExp && typeof maybeHandler === 'function') {
    const regex = filterOrHandler;
    filter = ctx => regex.test(ctx.text || '');
    handler = maybeHandler;
  } else if (typeof filterOrHandler === 'string' && typeof maybeHandler === 'function') {
    const needle = filterOrHandler.toLowerCase();
    filter = ctx => (ctx.text || '').toLowerCase().includes(needle);
    handler = maybeHandler;
  } else if (typeof filterOrHandler === 'function') {
    handler = filterOrHandler;
  } else {
    throw new TypeError('onMessage requires a handler function');
  }

  const id = `mh_${++_handlerSeq}`;
  const entry = { id, filter, handler };
  _messageHandlers.push(entry);

  return () => {
    const idx = _messageHandlers.findIndex(h => h.id === id);
    if (idx !== -1) _messageHandlers.splice(idx, 1);
  };
}

/**
 * Alias for `onMessage` so callers can use either name.
 */
export const declareMessageHandler = onMessage;

/**
 * Declare a handler for a `/command` (e.g. `onCommand('ping', ctx => ctx.reply('pong'))`).
 * Returns an unsubscribe function `() => void`.
 */
export function onCommand(command, handler) {
  if (!command || typeof handler !== 'function') {
    throw new TypeError('onCommand requires a command name and a handler function');
  }
  const cleanCmd = String(command).trim().replace(/^\/+/, '').toLowerCase();
  const id = `ch_${++_handlerSeq}`;
  if (!_commandHandlers.has(cleanCmd)) {
    _commandHandlers.set(cleanCmd, []);
  }
  _commandHandlers.get(cleanCmd).push({ id, handler });

  return () => {
    const list = _commandHandlers.get(cleanCmd);
    if (!list) return;
    const idx = list.findIndex(h => h.id === id);
    if (idx !== -1) list.splice(idx, 1);
  };
}

export function clearMessageHandlers({ includeBuiltIns = false } = {}) {
  _messageHandlers.length = 0;
  _commandHandlers.clear();
  if (!includeBuiltIns) {
    registerBuiltInHandlers();
  }
}

export function getRegisteredHandlersSummary() {
  return {
    commands: [..._commandHandlers.keys()],
    messageHandlerCount: _messageHandlers.length,
  };
}

/* ---------- 4. Built-in Bot Login & Workspace Command Handlers ---------- */
function registerBuiltInHandlers() {
  // /login <email> <password> -> Authenticates registered member and saves telegram_id + telegram_username in DB
  onCommand('login', async ctx => {
    const parts = (ctx.argsText || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return ctx.reply('Usage: /login <email> <password>\nOr generate a one-time link code from your Profile settings and send /link <code>.');
    }
    const email = parts[0];
    const password = parts.slice(1).join(' ');
    const telegramId = String(ctx.from?.id || ctx.chatId || '');
    const telegramUsername = String(ctx.from?.username || '');

    const res = linkMemberTelegramByCredentials({
      email,
      password,
      telegramId,
      telegramUsername,
    });

    if (!res.ok) {
      return ctx.reply(`Login failed: ${res.error}`);
    }

    ctx.member = res.member;
    const handleStr = telegramUsername ? ` (@${telegramUsername})` : '';
    return ctx.reply(
      `Logged in and linked to ${res.member.name} (${res.member.email}).\nYour Telegram ID ${telegramId}${handleStr} has been saved to your profile.`,
    );
  });

  // /link <code> -> Links account via a one-time code generated in web UI
  onCommand('link', async ctx => {
    const code = (ctx.argsText || '').trim();
    if (!code) {
      return ctx.reply('Usage: /link <CODE>\nOr log in directly with /login <email> <password>.');
    }
    const memberId = consumeTelegramLinkCode(code);
    if (!memberId) {
      return ctx.reply('Invalid or expired link code. Please generate a new code in Settings or use /login <email> <password>.');
    }
    const telegramId = String(ctx.from?.id || ctx.chatId || '');
    const telegramUsername = String(ctx.from?.username || '');
    const res = linkMemberTelegramById(memberId, { telegramId, telegramUsername });
    if (!res.ok) {
      return ctx.reply(`Link failed: ${res.error}`);
    }
    ctx.member = res.member;
    const handleStr = telegramUsername ? ` (@${telegramUsername})` : '';
    return ctx.reply(`Account linked to ${res.member.name} (${res.member.email}).\nYour Telegram ID ${telegramId}${handleStr} has been saved to your profile.`);
  });

  // /start [optional_link_code]
  onCommand('start', async ctx => {
    const arg = (ctx.argsText || '').trim();
    if (arg && /^TG-[A-F0-9]+$/i.test(arg)) {
      const memberId = consumeTelegramLinkCode(arg);
      if (memberId) {
        const telegramId = String(ctx.from?.id || ctx.chatId || '');
        const telegramUsername = String(ctx.from?.username || '');
        const res = linkMemberTelegramById(memberId, { telegramId, telegramUsername });
        if (res.ok) {
          ctx.member = res.member;
          return ctx.reply(`Welcome, ${res.member.name}! Your Telegram account (@${telegramUsername || telegramId}) is now linked.`);
        }
      }
    }
    if (ctx.member) {
      return ctx.reply(`Welcome back, ${ctx.member.name} (${ctx.member.email})!\nCommands: /whoami, /tasks, /logout, /help`);
    }
    return ctx.reply(
      'Welcome to MiniPlanner Telegram Bot!\nTo link your workspace account, send:\n/login <email> <password>\nOr use a one-time link code from your profile: /link <CODE>',
    );
  });

  // /whoami -> Shows linked member details
  onCommand('whoami', async ctx => {
    if (!ctx.member) {
      return ctx.reply('You are not logged in. Send /login <email> <password> to link your account.');
    }
    const tgUser = ctx.member.telegramUsername ? `@${ctx.member.telegramUsername}` : 'none';
    return ctx.reply(
      `Linked Member: ${ctx.member.name}\nEmail: ${ctx.member.email}\nRole: ${ctx.member.role}\nTelegram ID: ${ctx.member.telegramId}\nTelegram Username: ${tgUser}`,
    );
  });

  // /logout or /unlink -> Unlinks Telegram ID from member
  const handleUnlink = async ctx => {
    if (!ctx.member) {
      return ctx.reply('No linked workspace account found for this Telegram user.');
    }
    const name = ctx.member.name;
    unlinkMemberTelegram(ctx.member.id, ctx.member.id);
    ctx.member = null;
    return ctx.reply(`Unlinked Telegram from ${name}. You can re-link anytime with /login <email> <password>.`);
  };
  onCommand('logout', handleUnlink);
  onCommand('unlink', handleUnlink);

  // /tasks -> Lists open tasks assigned to the linked member (strictly within their project scope)
  onCommand('tasks', async ctx => {
    if (!ctx.member) {
      return ctx.reply('Please log in first with /login <email> <password> to view your tasks.');
    }
    const state = loadState(ctx.member.id);
    const myTasks = (state.data.tasks || []).filter(t => t.assignee === ctx.member.id && t.status !== 'done' && t.status !== 'canceled' && !t.archived);
    if (!myTasks.length) {
      return ctx.reply('You have no open assigned tasks.');
    }
    const lines = myTasks.slice(0, 10).map(t => `• [${t.key}] ${t.title} (${t.status})`);
    return ctx.reply(`Your open tasks (${myTasks.length}):\n${lines.join('\n')}`);
  });

  // /help
  onCommand('help', async ctx => {
    return ctx.reply(
      'Available commands:\n' +
        '/login <email> <password> — Log in & save your Telegram ID/username\n' +
        '/link <CODE> — Link using a one-time code from Settings\n' +
        '/whoami — Show your linked member account\n' +
        '/tasks — List your open assigned tasks\n' +
        '/logout — Unlink your Telegram account',
    );
  });
}

registerBuiltInHandlers();

/* ---------- 2. Receive Message (Update Processor + Polling + Webhook) ---------- */
const _recentInboundMessages = [];
const MAX_RECENT_MESSAGES = 50;

export function getRecentTelegramMessages() {
  return [..._recentInboundMessages];
}

/**
 * Process a single incoming Telegram Update object (from webhook or getUpdates).
 */
export async function handleTelegramUpdate(update, options = {}) {
  if (!update || typeof update !== 'object') {
    return { ok: false, status: 400, error: 'Invalid Telegram update payload' };
  }

  const updateId = Number(update.update_id || 0);
  if (updateId > 0) {
    const cfg = getTelegramConfigInternal();
    if (updateId > cfg.lastUpdateId) {
      setTelegramLastUpdateId(updateId);
    }
  }

  const message = update.message || update.edited_message || update.callback_query?.message || null;
  if (!message) {
    return { ok: true, status: 200, handled: false, reason: 'no_message' };
  }

  const from = update.callback_query?.from || message.from || {};
  const chat = message.chat || {};
  const chatId = String(chat.id ?? from.id ?? '');
  const telegramId = String(from.id ?? chat.id ?? '');
  const telegramUsername = String(from.username || chat.username || '')
    .trim()
    .replace(/^@+/, '');
  const text = String(update.callback_query?.data ?? message.text ?? message.caption ?? '').trim();

  // Resolve linked member from DB; if already linked and username changed on Telegram, sync it automatically
  let member = telegramId ? getMemberByTelegramId(telegramId) : null;
  if (member && telegramUsername && member.telegramUsername !== telegramUsername) {
    const synced = linkMemberTelegramById(member.id, { telegramId, telegramUsername });
    if (synced.ok) member = synced.member;
  }

  const replies = [];
  const ctx = {
    update,
    updateId,
    message,
    from,
    chat,
    chatId,
    telegramId,
    telegramUsername,
    text,
    member,
    command: null,
    argsText: '',
    reply: async (replyText, replyOpts = {}) => {
      const r = await sendMessage(
        {
          chatId,
          text: replyText,
          ...replyOpts,
        },
        undefined,
        options,
      );
      replies.push({ text: replyText, response: r });
      return r;
    },
  };

  const results = [];

  // Check if message starts with a /command (e.g. "/login alice@company.com secret" or "/start@botname arg")
  const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (cmdMatch) {
    const cmdName = cmdMatch[1].toLowerCase();
    const argsText = (cmdMatch[2] || '').trim();
    ctx.command = cmdName;
    ctx.argsText = argsText;

    const cmdList = _commandHandlers.get(cmdName) || [];
    for (const entry of cmdList) {
      const out = await entry.handler(ctx);
      results.push(out);
    }
  }

  // Execute declared message handlers matching ctx
  for (const entry of _messageHandlers) {
    if (entry.filter && !entry.filter(ctx)) continue;
    const out = await entry.handler(ctx);
    results.push(out);
  }

  // Record in recent inbound log (redact password in /login logs!)
  const safeLogText = ctx.command === 'login' ? '/login [REDACTED]' : text.slice(0, 200);
  const logEntry = {
    updateId,
    messageId: message.message_id || null,
    chatId,
    telegramId,
    telegramUsername,
    memberId: ctx.member?.id || null,
    memberName: ctx.member?.name || null,
    text: safeLogText,
    receivedAt: Date.now(),
  };
  _recentInboundMessages.unshift(logEntry);
  if (_recentInboundMessages.length > MAX_RECENT_MESSAGES) {
    _recentInboundMessages.length = MAX_RECENT_MESSAGES;
  }

  return {
    ok: true,
    status: 200,
    handled: results.length > 0,
    command: ctx.command,
    member: ctx.member,
    replies,
    results,
  };
}

/* ---------- Long-Polling Support (getUpdates) ---------- */
let _pollTimer = null;
let _isPolling = false;

export async function pollTelegramUpdates(options = {}) {
  if (_isPolling) {
    return { ok: true, status: 200, processed: 0, skipped: true };
  }
  const cfg = getTelegramConfigInternal();
  const token = options.token || cfg.botToken;
  if (!token) {
    return { ok: false, status: 400, error: 'Telegram Bot token is not configured' };
  }

  _isPolling = true;
  try {
    const offset = cfg.lastUpdateId > 0 ? cfg.lastUpdateId + 1 : 0;
    const resp = await callTelegramApi(
      'getUpdates',
      {
        offset,
        limit: options.limit || 25,
        timeout: options.timeout ?? 0,
      },
      { token, fetchImpl: options.fetchImpl },
    );

    if (!resp.ok) {
      return resp;
    }

    const updates = Array.isArray(resp.result) ? resp.result : [];
    const outcomes = [];
    for (const upd of updates) {
      const out = await handleTelegramUpdate(upd, options);
      outcomes.push(out);
    }

    return {
      ok: true,
      status: 200,
      processed: outcomes.length,
      outcomes,
    };
  } finally {
    _isPolling = false;
  }
}

export function startTelegramPolling(intervalMs = 4000) {
  stopTelegramPolling();
  const cfg = getTelegramConfigInternal();
  if (!cfg.enabled || !cfg.botToken || cfg.mode !== 'polling') {
    return false;
  }
  _pollTimer = setInterval(() => {
    const current = getTelegramConfigInternal();
    if (!current.enabled || !current.botToken || current.mode !== 'polling') {
      stopTelegramPolling();
      return;
    }
    pollTelegramUpdates().catch(() => {
      /* ignore background poll network error */
    });
  }, intervalMs);
  if (_pollTimer.unref) _pollTimer.unref();
  return true;
}

export function stopTelegramPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
