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
   4. Interactive member login & on-screen menu keyboards + auto-save
      Telegram ID / username in DB
   ===================================================================== */

let _fetchImpl = (...args) => globalThis.fetch(...args);

export function setTelegramFetch(fn) {
  _fetchImpl = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
}

export function resetTelegramFetch() {
  _fetchImpl = (...args) => globalThis.fetch(...args);
}

/* ---------- On-Screen Menu Keyboards (ReplyKeyboard + InlineKeyboard) ---------- */
export const MENU_BTN = {
  LOGIN: '🔑 Log in',
  LINK_CODE: '🔗 Enter Link Code',
  MY_ACCOUNT: '👤 My Account',
  MY_TASKS: '📋 My Tasks',
  HELP: '❓ Help',
  LOGOUT: '🚪 Log out',
  CANCEL: '❌ Cancel',
};

const BUTTON_TO_COMMAND = new Map([
  [MENU_BTN.LOGIN.toLowerCase(), 'login'],
  ['log in', 'login'],
  ['login', 'login'],
  [MENU_BTN.LINK_CODE.toLowerCase(), 'link'],
  ['enter link code', 'link'],
  ['link code', 'link'],
  [MENU_BTN.MY_ACCOUNT.toLowerCase(), 'whoami'],
  ['my account', 'whoami'],
  ['whoami', 'whoami'],
  [MENU_BTN.MY_TASKS.toLowerCase(), 'tasks'],
  ['my tasks', 'tasks'],
  ['tasks', 'tasks'],
  [MENU_BTN.HELP.toLowerCase(), 'help'],
  ['help', 'help'],
  ['menu', 'menu'],
  [MENU_BTN.LOGOUT.toLowerCase(), 'logout'],
  ['log out', 'logout'],
  ['logout', 'logout'],
  [MENU_BTN.CANCEL.toLowerCase(), 'cancel'],
  ['cancel', 'cancel'],
]);

export function buildMainMenuKeyboard(member = null) {
  if (member) {
    return {
      keyboard: [
        [{ text: MENU_BTN.MY_TASKS }, { text: MENU_BTN.MY_ACCOUNT }],
        [{ text: MENU_BTN.HELP }, { text: MENU_BTN.LOGOUT }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }
  return {
    keyboard: [[{ text: MENU_BTN.LOGIN }, { text: MENU_BTN.LINK_CODE }], [{ text: MENU_BTN.HELP }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function buildCancelKeyboard() {
  return {
    keyboard: [[{ text: MENU_BTN.CANCEL }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

export function buildInlineMenuMarkup(member = null) {
  if (member) {
    return {
      inline_keyboard: [
        [
          { text: MENU_BTN.MY_TASKS, callback_data: '/tasks' },
          { text: MENU_BTN.MY_ACCOUNT, callback_data: '/whoami' },
        ],
        [
          { text: MENU_BTN.HELP, callback_data: '/help' },
          { text: MENU_BTN.LOGOUT, callback_data: '/logout' },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: MENU_BTN.LOGIN, callback_data: '/login' },
        { text: MENU_BTN.LINK_CODE, callback_data: '/link' },
      ],
      [{ text: MENU_BTN.HELP, callback_data: '/help' }],
    ],
  };
}

/* ---------- Interactive Login / Link Session State (per chatId) ---------- */
const _chatSessions = new Map(); // chatId -> { step: 'await_email' | 'await_password' | 'await_link_code', email?: string, updatedAt: number }
const CHAT_SESSION_TTL_MS = 15 * 60 * 1000;

function getChatSession(chatId) {
  const s = _chatSessions.get(String(chatId));
  if (!s) return null;
  if (Date.now() - s.updatedAt > CHAT_SESSION_TTL_MS) {
    _chatSessions.delete(String(chatId));
    return null;
  }
  return s;
}

function setChatSession(chatId, data) {
  if (!data) {
    _chatSessions.delete(String(chatId));
    return;
  }
  _chatSessions.set(String(chatId), { ...data, updatedAt: Date.now() });
}

export function clearChatSessions() {
  _chatSessions.clear();
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

  if (opts.actorMemberId) {
    const db = getDb();
    const scope = getScope(db, opts.actorMemberId);
    if (!scope.isAdmin) {
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

export const declareMessageHandler = onMessage;

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
  _chatSessions.clear();
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

/* ---------- 4. Built-in Interactive Bot Login & On-Screen Menu Handlers ---------- */
function registerBuiltInHandlers() {
  // /cancel -> Aborts any active interactive step and shows the main on-screen menu keyboard
  onCommand('cancel', async ctx => {
    setChatSession(ctx.chatId, null);
    return ctx.reply('Cancelled. Choose an action from the menu below:', {
      replyMarkup: buildMainMenuKeyboard(ctx.member),
    });
  });

  // /login [email] [password] -> Supports both interactive step-by-step login and one-line `/login email password`
  onCommand('login', async ctx => {
    const parts = (ctx.argsText || '').trim().split(/\s+/).filter(Boolean);

    // Interactive mode when user taps "🔑 Log in" button or sends `/login` without arguments
    if (parts.length === 0) {
      setChatSession(ctx.chatId, { step: 'await_email' });
      return ctx.reply('Please enter your workspace email address (or tap ❌ Cancel):', {
        replyMarkup: buildCancelKeyboard(),
      });
    }

    // If user only provided email (`/login alice@company.com`), ask for password next
    if (parts.length === 1) {
      const candidateEmail = parts[0].trim();
      setChatSession(ctx.chatId, { step: 'await_password', email: candidateEmail });
      return ctx.reply(`Email: ${candidateEmail}\nNow please enter your password (or tap ❌ Cancel):`, {
        replyMarkup: buildCancelKeyboard(),
      });
    }

    // Direct `/login <email> <password>`
    setChatSession(ctx.chatId, null);
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
      return ctx.reply(`Login failed: ${res.error}`, {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
    }

    ctx.member = res.member;
    const handleStr = telegramUsername ? ` (@${telegramUsername})` : '';
    return ctx.reply(
      `Logged in and linked to ${res.member.name} (${res.member.email}).\nYour Telegram ID ${telegramId}${handleStr} has been saved to your profile.`,
      { replyMarkup: buildMainMenuKeyboard(ctx.member) },
    );
  });

  // /link [code] -> Supports interactive prompt when tapped from menu button or direct `/link <CODE>`
  onCommand('link', async ctx => {
    const code = (ctx.argsText || '').trim();
    if (!code) {
      setChatSession(ctx.chatId, { step: 'await_link_code' });
      return ctx.reply('Please send your one-time link code (e.g. TG-1A2B3C4D) generated in Settings → Personal → Profile (or tap ❌ Cancel):', {
        replyMarkup: buildCancelKeyboard(),
      });
    }
    setChatSession(ctx.chatId, null);
    const memberId = consumeTelegramLinkCode(code);
    if (!memberId) {
      return ctx.reply('Invalid or expired link code. Please generate a new code in Settings or tap 🔑 Log in.', {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
    }
    const telegramId = String(ctx.from?.id || ctx.chatId || '');
    const telegramUsername = String(ctx.from?.username || '');
    const res = linkMemberTelegramById(memberId, { telegramId, telegramUsername });
    if (!res.ok) {
      return ctx.reply(`Link failed: ${res.error}`, {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
    }
    ctx.member = res.member;
    const handleStr = telegramUsername ? ` (@${telegramUsername})` : '';
    return ctx.reply(
      `Account linked to ${res.member.name} (${res.member.email}).\nYour Telegram ID ${telegramId}${handleStr} has been saved to your profile.`,
      { replyMarkup: buildMainMenuKeyboard(ctx.member) },
    );
  });

  // /start [optional_link_code] and /menu
  const handleStartOrMenu = async ctx => {
    setChatSession(ctx.chatId, null);
    const arg = (ctx.argsText || '').trim();
    if (arg && /^TG-[A-F0-9]+$/i.test(arg)) {
      const memberId = consumeTelegramLinkCode(arg);
      if (memberId) {
        const telegramId = String(ctx.from?.id || ctx.chatId || '');
        const telegramUsername = String(ctx.from?.username || '');
        const res = linkMemberTelegramById(memberId, { telegramId, telegramUsername });
        if (res.ok) {
          ctx.member = res.member;
          return ctx.reply(`Welcome, ${res.member.name}! Your Telegram account (@${telegramUsername || telegramId}) is now linked.`, {
            replyMarkup: buildMainMenuKeyboard(ctx.member),
          });
        }
      }
    }
    if (ctx.member) {
      return ctx.reply(`Welcome back, ${ctx.member.name} (${ctx.member.email})!\nUse the menu buttons below to view your tasks or account:`, {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
    }
    return ctx.reply(
      'Welcome to MiniPlanner Telegram Bot!\nTap "🔑 Log in" on the menu below to sign in with your workspace email and password, or tap "🔗 Enter Link Code":',
      { replyMarkup: buildMainMenuKeyboard(null) },
    );
  };
  onCommand('start', handleStartOrMenu);
  onCommand('menu', handleStartOrMenu);

  // /whoami -> Shows linked member details
  onCommand('whoami', async ctx => {
    setChatSession(ctx.chatId, null);
    if (!ctx.member) {
      return ctx.reply('You are not logged in. Tap "🔑 Log in" below to link your workspace account.', {
        replyMarkup: buildMainMenuKeyboard(null),
      });
    }
    const tgUser = ctx.member.telegramUsername ? `@${ctx.member.telegramUsername}` : 'none';
    return ctx.reply(
      `Linked Member: ${ctx.member.name}\nEmail: ${ctx.member.email}\nRole: ${ctx.member.role}\nTelegram ID: ${ctx.member.telegramId}\nTelegram Username: ${tgUser}`,
      { replyMarkup: buildMainMenuKeyboard(ctx.member) },
    );
  });

  // /logout or /unlink -> Unlinks Telegram ID from member
  const handleUnlink = async ctx => {
    setChatSession(ctx.chatId, null);
    if (!ctx.member) {
      return ctx.reply('No linked workspace account found for this Telegram user.', {
        replyMarkup: buildMainMenuKeyboard(null),
      });
    }
    const name = ctx.member.name;
    unlinkMemberTelegram(ctx.member.id, ctx.member.id);
    ctx.member = null;
    return ctx.reply(`Unlinked Telegram from ${name}. You can log in again anytime using the menu below.`, {
      replyMarkup: buildMainMenuKeyboard(null),
    });
  };
  onCommand('logout', handleUnlink);
  onCommand('unlink', handleUnlink);

  // /tasks -> Lists open tasks assigned to the linked member (strictly within their project scope)
  onCommand('tasks', async ctx => {
    setChatSession(ctx.chatId, null);
    if (!ctx.member) {
      return ctx.reply('Please log in first using "🔑 Log in" on the menu below to view your tasks.', {
        replyMarkup: buildMainMenuKeyboard(null),
      });
    }
    const state = loadState(ctx.member.id);
    const myTasks = (state.data.tasks || []).filter(t => t.assignee === ctx.member.id && t.status !== 'done' && t.status !== 'canceled' && !t.archived);
    if (!myTasks.length) {
      return ctx.reply('You have no open assigned tasks.', {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
    }
    const lines = myTasks.slice(0, 10).map(t => `• [${t.key}] ${t.title} (${t.status})`);
    return ctx.reply(`Your open tasks (${myTasks.length}):\n${lines.join('\n')}`, {
      replyMarkup: buildMainMenuKeyboard(ctx.member),
    });
  });

  // /help
  onCommand('help', async ctx => {
    setChatSession(ctx.chatId, null);
    return ctx.reply(
      'MiniPlanner Telegram Bot Menu:\n' +
        '• 🔑 Log in (/login) — Interactive login with your email & password\n' +
        '• 🔗 Enter Link Code (/link) — Link using a one-time code from Settings\n' +
        '• 📋 My Tasks (/tasks) — List your open assigned tasks\n' +
        '• 👤 My Account (/whoami) — Show your linked member profile\n' +
        '• 🚪 Log out (/logout) — Unlink your Telegram account',
      { replyMarkup: buildMainMenuKeyboard(ctx.member) },
    );
  });
}

registerBuiltInHandlers();

/* ---------- Interactive Step Processor (Multi-step login & link code) ---------- */
async function processInteractiveStep(ctx) {
  const session = getChatSession(ctx.chatId);
  if (!session) return { handled: false };

  const input = ctx.text.trim();
  const telegramId = String(ctx.from?.id || ctx.chatId || '');
  const telegramUsername = String(ctx.from?.username || '');

  if (session.step === 'await_email') {
    if (!input.includes('@')) {
      const r = await ctx.reply('That does not look like a valid email address. Please enter your workspace email (or tap ❌ Cancel):', {
        replyMarkup: buildCancelKeyboard(),
      });
      return { handled: true, out: r };
    }
    setChatSession(ctx.chatId, { step: 'await_password', email: input });
    const r = await ctx.reply(`Email: ${input}\nNow please enter your password (or tap ❌ Cancel):`, {
      replyMarkup: buildCancelKeyboard(),
    });
    return { handled: true, out: r };
  }

  if (session.step === 'await_password') {
    const email = session.email;
    setChatSession(ctx.chatId, null);

    // Best-effort: delete the user's password message from the chat so it doesn't stay visible
    if (ctx.message?.message_id) {
      callTelegramApi(
        'deleteMessage',
        { chat_id: String(ctx.chatId), message_id: ctx.message.message_id },
        { token: ctx._options?.token, fetchImpl: ctx._options?.fetchImpl },
      ).catch(() => {});
    }

    const res = linkMemberTelegramByCredentials({
      email,
      password: input,
      telegramId,
      telegramUsername,
    });

    if (!res.ok) {
      const r = await ctx.reply(`Login failed: ${res.error}\nTap "🔑 Log in" to try again.`, {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
      return { handled: true, out: r, redactLog: true };
    }

    ctx.member = res.member;
    const handleStr = telegramUsername ? ` (@${telegramUsername})` : '';
    const r = await ctx.reply(
      `Logged in and linked to ${res.member.name} (${res.member.email}).\nYour Telegram ID ${telegramId}${handleStr} has been saved to your profile.`,
      { replyMarkup: buildMainMenuKeyboard(ctx.member) },
    );
    return { handled: true, out: r, redactLog: true };
  }

  if (session.step === 'await_link_code') {
    setChatSession(ctx.chatId, null);
    const memberId = consumeTelegramLinkCode(input);
    if (!memberId) {
      const r = await ctx.reply('Invalid or expired link code. Please generate a new code in Settings or tap "🔑 Log in".', {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
      return { handled: true, out: r };
    }
    const res = linkMemberTelegramById(memberId, { telegramId, telegramUsername });
    if (!res.ok) {
      const r = await ctx.reply(`Link failed: ${res.error}`, {
        replyMarkup: buildMainMenuKeyboard(ctx.member),
      });
      return { handled: true, out: r };
    }
    ctx.member = res.member;
    const handleStr = telegramUsername ? ` (@${telegramUsername})` : '';
    const r = await ctx.reply(
      `Account linked to ${res.member.name} (${res.member.email}).\nYour Telegram ID ${telegramId}${handleStr} has been saved to your profile.`,
      { replyMarkup: buildMainMenuKeyboard(ctx.member) },
    );
    return { handled: true, out: r };
  }

  return { handled: false };
}

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

  // Acknowledge inline keyboard callback_query if present
  if (update.callback_query?.id) {
    callTelegramApi('answerCallbackQuery', { callback_query_id: update.callback_query.id }, { token: options.token, fetchImpl: options.fetchImpl }).catch(
      () => {},
    );
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
    _options: options,
    reply: async (replyText, replyOpts = {}) => {
      const r = await sendMessage(
        {
          chatId,
          text: replyText,
          replyMarkup: replyOpts.replyMarkup !== undefined ? replyOpts.replyMarkup : buildMainMenuKeyboard(ctx.member),
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
  let redactLog = false;

  // 1. Check if message matches a slash command (`/login ...`) OR an on-screen menu button (`🔑 Log in`, `📋 My Tasks`, etc.)
  const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  const mappedButtonCmd = !cmdMatch ? BUTTON_TO_COMMAND.get(text.toLowerCase()) || null : null;

  if (cmdMatch || mappedButtonCmd) {
    const cmdName = cmdMatch ? cmdMatch[1].toLowerCase() : mappedButtonCmd;
    const argsText = cmdMatch ? (cmdMatch[2] || '').trim() : '';
    ctx.command = cmdName;
    ctx.argsText = argsText;

    const cmdList = _commandHandlers.get(cmdName) || [];
    for (const entry of cmdList) {
      const out = await entry.handler(ctx);
      results.push(out);
    }
  } else {
    // 2. If not a command or menu button, check if chat is in an interactive multi-step login/link flow
    const stepRes = await processInteractiveStep(ctx);
    if (stepRes.handled) {
      results.push(stepRes.out);
      if (stepRes.redactLog) redactLog = true;
    }
  }

  // 3. Execute declared custom message handlers matching ctx
  for (const entry of _messageHandlers) {
    if (entry.filter && !entry.filter(ctx)) continue;
    const out = await entry.handler(ctx);
    results.push(out);
  }

  // 4. Default interactive menu response when an unrecognized message wasn't handled by any command, step, or custom handler
  if (results.length === 0 && text) {
    const welcomeText = ctx.member
      ? `Hi ${ctx.member.name}! Choose an option from the menu keys below:`
      : 'Welcome to MiniPlanner Bot! You are not logged in yet.\nTap "🔑 Log in" on the menu below to sign in with your workspace email and password:';
    const fallbackOut = await ctx.reply(welcomeText, {
      replyMarkup: buildMainMenuKeyboard(ctx.member),
    });
    results.push(fallbackOut);
  }

  // Record in recent inbound log (redact password in /login or interactive password step!)
  const safeLogText = ctx.command === 'login' && ctx.argsText ? '/login [REDACTED]' : redactLog ? '[PASSWORD REDACTED]' : text.slice(0, 200);
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
let _webhookClearedForToken = null;

export async function configureTelegramBotCommands(options = {}) {
  const cfg = getTelegramConfigInternal();
  const token = options.token || cfg.botToken;
  if (!token) return { ok: false, error: 'No token' };
  await callTelegramApi(
    'setMyCommands',
    {
      commands: [
        { command: 'start', description: 'Open main menu' },
        { command: 'login', description: 'Log in with your workspace account' },
        { command: 'link', description: 'Link account with one-time code' },
        { command: 'tasks', description: 'View your open assigned tasks' },
        { command: 'whoami', description: 'View your linked account info' },
        { command: 'help', description: 'Show help & menu' },
        { command: 'logout', description: 'Unlink your Telegram account' },
      ],
    },
    { token, fetchImpl: options.fetchImpl },
  ).catch(() => {});
  return { ok: true };
}

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
    // Ensure any active webhook is removed when running in polling mode so getUpdates does not fail with 409 Conflict
    if (cfg.mode === 'polling' && _webhookClearedForToken !== token) {
      await callTelegramApi('deleteWebhook', { drop_pending_updates: false }, { token, fetchImpl: options.fetchImpl }).catch(() => {});
      _webhookClearedForToken = token;
    }

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

export function startTelegramPolling(intervalMs = 2500) {
  stopTelegramPolling();
  const cfg = getTelegramConfigInternal();
  if (!cfg.botToken || cfg.mode !== 'polling') {
    return false;
  }
  // If a bot token is already configured in polling mode, ensure tg_enabled is turned on so polling works immediately
  if (!cfg.enabled) {
    try {
      const db = getDb();
      db.prepare('UPDATE workspace_settings SET tg_enabled = 1 WHERE id = 1 AND tg_bot_token != ?').run('');
    } catch {
      /* ignore */
    }
  }
  configureTelegramBotCommands().catch(() => {});
  pollTelegramUpdates().catch(() => {});

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
