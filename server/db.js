import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { seed } from '../src/data/seed.js';
import {
  DEFAULT_SESSION_TTL_SEC,
  REMEMBER_SESSION_TTL_SEC,
  generateSessionToken,
  generateTotpSetup,
  hashPassword,
  hashToken,
  verifyPassword,
  verifyTotpOrRecovery,
} from './auth.js';

const DATA_DIR = path.resolve('data');
export const DB_PATH = path.join(DATA_DIR, 'miniplanner.sqlite');

export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'indigo',
  side: 'comfortable',
  density: 'comfortable',
  weekStart: 1,
  dateFmt: 'MMM d',
  lang: 'English (US)',
  tz: '(GMT-07:00) Pacific Time',
  motion: 'system',
  home: 'home',
  openTasks: 'drawer',
  name: 'Workspace Owner',
  title: 'Owner',
};

let _db = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  migrateSchema(db);
  _db = db;
  ensureInitialized(db);
  return db;
}

function addColumnIfMissing(db, table, col, defSql) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(c => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${defSql}`);
  }
}

function migrateSchema(db) {
  addColumnIfMissing(db, 'members', 'password_hash', 'TEXT NULL');
  addColumnIfMissing(db, 'members', 'tfa_secret', 'TEXT NULL');
  addColumnIfMissing(db, 'members', 'tfa_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'members', 'recovery_codes_json', "TEXT NOT NULL DEFAULT '[]'");

  addColumnIfMissing(db, 'sessions', 'token_hash', 'TEXT NULL');
  addColumnIfMissing(db, 'sessions', 'member_id', "TEXT NOT NULL DEFAULT 'm1'");
  addColumnIfMissing(db, 'sessions', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'sessions', 'last_active_at', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'sessions', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');

  addColumnIfMissing(db, 'user_preferences', 'member_id', "TEXT NOT NULL DEFAULT 'm1'");
  addColumnIfMissing(db, 'ui_views', 'member_id', "TEXT NOT NULL DEFAULT 'm1'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);
    CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
  `);
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      color TEXT NOT NULL,
      brand INTEGER NOT NULL DEFAULT 1,
      me_id TEXT NOT NULL,
      tfa INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      notif_prefs_json TEXT NOT NULL DEFAULT '{}',
      recent_searches_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      brand INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      member_id TEXT NOT NULL DEFAULT 'm1',
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (member_id, key)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'users',
      color TEXT NOT NULL DEFAULT '#8A867E',
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Member',
      team_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#5A67D8',
      status TEXT NOT NULL DEFAULT 'active',
      last_active INTEGER NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      password_hash TEXT NULL,
      tfa_secret TEXT NULL,
      tfa_enabled INTEGER NOT NULL DEFAULT 0,
      recovery_codes_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'folder',
      color TEXT NOT NULL DEFAULT 'indigo',
      status TEXT NOT NULL DEFAULT 'planning',
      team_id TEXT NOT NULL DEFAULT '',
      lead_id TEXT NULL,
      due_date TEXT NULL,
      start_date TEXT NULL,
      fav INTEGER NOT NULL DEFAULT 0,
      is_private INTEGER NOT NULL DEFAULT 0,
      access TEXT NULL,
      description TEXT NOT NULL DEFAULT '',
      last_activity INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 200,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER NULL,
      proj_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      permission TEXT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS project_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      prev_status TEXT NULL,
      assignee_id TEXT NULL,
      priority TEXT NOT NULL DEFAULT 'none',
      due_date TEXT NULL,
      start_date TEXT NULL,
      description TEXT NOT NULL DEFAULT '',
      estimate TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER NULL,
      sort_order REAL NOT NULL DEFAULT 0,
      fav INTEGER NOT NULL DEFAULT 0,
      recur TEXT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER NULL
    );

    CREATE TABLE IF NOT EXISTS task_labels (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, depends_on_task_id)
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      assignee_id TEXT NULL,
      due_date TEXT NULL,
      note TEXT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS task_attachments (
      id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size TEXT NOT NULL,
      uploaded_by TEXT NULL,
      uploaded_at INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author_id TEXT NULL,
      created_at INTEGER NOT NULL,
      text TEXT NOT NULL,
      reactions_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT NULL,
      verb TEXT NOT NULL,
      task_id TEXT NULL,
      project_id TEXT NULL,
      created_at INTEGER NOT NULL,
      extra TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor_id TEXT NULL,
      task_id TEXT NULL,
      project_id TEXT NULL,
      text TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size TEXT NOT NULL,
      uploaded_by TEXT NULL,
      uploaded_at INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '',
      project_id TEXT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS saved_views (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      filters_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ui_views (
      member_id TEXT NOT NULL DEFAULT 'm1',
      view_key TEXT NOT NULL,
      config_json TEXT NOT NULL,
      PRIMARY KEY (member_id, view_key)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NULL,
      member_id TEXT NOT NULL DEFAULT 'm1',
      device TEXT NOT NULL,
      location TEXT NOT NULL,
      active_text TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_active_at INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
    CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
  `);
}

function ensureInitialized(db) {
  const row = db.prepare('SELECT id FROM workspace_settings WHERE id = 1').get();
  if (!row) {
    writeFullStateTx(
      db,
      {
        data: seed(),
        prefs: DEFAULT_PREFS,
        views: {},
        collapsed: false,
      },
      'init_workspace',
      'm1',
    );
  }
}

function writeFullStateTx(db, payload, actionName = 'save_state', actorMemberId = null) {
  const tx = db.transaction(() => {
    const d = payload?.data || seed();
    const activeMe = actorMemberId || d.me || 'm1';
    const actorRow = db.prepare('SELECT role FROM members WHERE id = ?').get(activeMe);
    const actorRole = actorRow?.role || 'Owner';
    const isAdminActor = ['Owner', 'Admin'].includes(actorRole);
    const prefs = Object.assign({}, DEFAULT_PREFS, payload?.prefs || {});
    const views = payload?.views || {};
    const collapsed = payload?.collapsed ? 1 : 0;
    const now = Date.now();

    const prevWs = db.prepare('SELECT * FROM workspace_settings WHERE id = 1').get();
    const ws =
      isAdminActor || !prevWs
        ? d.ws || { name: 'My Workspace', url: 'my-workspace', c: '#1D1C1A', brand: true }
        : { name: prevWs.name, url: prevWs.url, c: prevWs.color, brand: Boolean(prevWs.brand) };

    db.prepare(
      `INSERT INTO workspace_settings (
        id, name, url, color, brand, me_id, tfa, collapsed, notif_prefs_json, recent_searches_json, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        color = excluded.color,
        brand = excluded.brand,
        me_id = excluded.me_id,
        tfa = excluded.tfa,
        collapsed = excluded.collapsed,
        notif_prefs_json = excluded.notif_prefs_json,
        recent_searches_json = excluded.recent_searches_json,
        updated_at = excluded.updated_at`,
    ).run(
      ws.name || 'My Workspace',
      ws.url || 'my-workspace',
      ws.c || '#1D1C1A',
      ws.brand ? 1 : 0,
      activeMe,
      d.tfa ? 1 : 0,
      collapsed,
      JSON.stringify(d.notifPrefs || {}),
      JSON.stringify(d.recentSearches || []),
      now,
    );

    // Preferences (scoped by member_id)
    db.prepare('DELETE FROM user_preferences WHERE member_id = ?').run(activeMe);
    const insPref = db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries(prefs)) {
      insPref.run(activeMe, k, JSON.stringify(v));
    }

    // UI Views (scoped by member_id)
    db.prepare('DELETE FROM ui_views WHERE member_id = ?').run(activeMe);
    const insUiView = db.prepare('INSERT OR REPLACE INTO ui_views (member_id, view_key, config_json) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries(views)) {
      insUiView.run(activeMe, k, JSON.stringify(v));
    }

    // Workspaces (only Admin/Owner or initial seed can overwrite)
    if (isAdminActor || db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n === 0) {
      db.prepare('DELETE FROM workspaces').run();
      const insWs = db.prepare('INSERT INTO workspaces (id, name, color, brand, sort_order) VALUES (?, ?, ?, ?, ?)');
      (d.workspaces || []).forEach((w, i) => {
        insWs.run(w.id, w.name, w.c || '#1D1C1A', w.brand ? 1 : 0, i);
      });
    }

    // Teams (only Admin/Owner can modify teams)
    if (isAdminActor) {
      db.prepare('DELETE FROM teams').run();
      const insTeam = db.prepare('INSERT INTO teams (id, name, icon, color, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
      (d.teams || []).forEach((t, i) => {
        insTeam.run(t.id, t.name, t.icon || 'users', t.c || '#8A867E', t.desc || '', i);
      });
    }

    // Members: preserve existing auth credentials (password_hash, tfa_secret, tfa_enabled, recovery_codes_json)
    // and prevent non-admins from escalating roles or deleting members
    const existingCreds = new Map(
      db
        .prepare('SELECT id, role, password_hash, tfa_secret, tfa_enabled, recovery_codes_json FROM members')
        .all()
        .map(r => [r.id, r]),
    );
    if (isAdminActor) {
      const incomingMemberIds = new Set((d.members || []).map(m => m.id));
      for (const oldId of existingCreds.keys()) {
        if (!incomingMemberIds.has(oldId)) {
          db.prepare('DELETE FROM members WHERE id = ?').run(oldId);
        }
      }
    }
    const upsertMember = db.prepare(
      `INSERT INTO members (
        id, name, email, role, team_id, title, color, status, last_active, timezone,
        password_hash, tfa_secret, tfa_enabled, recovery_codes_json, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        role = excluded.role,
        team_id = excluded.team_id,
        title = excluded.title,
        color = excluded.color,
        status = excluded.status,
        last_active = excluded.last_active,
        timezone = excluded.timezone,
        tfa_enabled = excluded.tfa_enabled,
        sort_order = excluded.sort_order`,
    );
    (d.members || []).forEach((m, i) => {
      if (actorRole === 'Guest' && m.id !== activeMe) return;
      const prev = existingCreds.get(m.id);
      const effectiveRole = isAdminActor ? m.role || 'Member' : prev?.role || (m.role === 'Guest' ? 'Guest' : 'Member');
      const tfaFlag = m.id === activeMe && typeof d.tfa === 'boolean' ? (d.tfa ? 1 : 0) : (prev?.tfa_enabled ?? 0);
      upsertMember.run(
        m.id,
        m.name,
        m.email,
        effectiveRole,
        m.team || '',
        m.title || '',
        m.c || '#5A67D8',
        m.status || 'active',
        m.last ?? null,
        m.tz || 'UTC',
        prev?.password_hash ?? null,
        prev?.tfa_secret ?? null,
        tfaFlag,
        prev?.recovery_codes_json ?? '[]',
        i,
      );
    });

    // Projects (cascades to project_members, project_milestones, tasks, subtasks, etc.)
    db.prepare('DELETE FROM projects').run();
    const insProj = db.prepare(
      `INSERT INTO projects (
        id, key, name, icon, color, status, team_id, lead_id, due_date, start_date,
        fav, is_private, access, description, last_activity, seq, archived, archived_at, proj_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insProjMem = db.prepare('INSERT OR REPLACE INTO project_members (project_id, member_id, permission, sort_order) VALUES (?, ?, ?, ?)');
    const insMilestone = db.prepare('INSERT INTO project_milestones (project_id, name, date, sort_order) VALUES (?, ?, ?, ?)');

    const projOrderList = d.projOrder || [];
    const projIds = new Set();
    (d.projects || []).forEach((p, idx) => {
      projIds.add(p.id);
      const orderIdx = projOrderList.indexOf(p.id);
      insProj.run(
        p.id,
        p.key || 'PRJ',
        p.name,
        p.icon || 'folder',
        p.color || 'indigo',
        p.status || 'planning',
        p.team || '',
        p.lead || null,
        p.due || null,
        p.start || null,
        p.fav ? 1 : 0,
        p.private ? 1 : 0,
        p.access || null,
        p.desc || '',
        p.last ?? 0,
        p.seq ?? 200,
        p.archived ? 1 : 0,
        p.archivedAt ?? null,
        orderIdx >= 0 ? orderIdx : idx,
      );
      (p.members || []).forEach((mid, mi) => {
        insProjMem.run(p.id, mid, p.perms?.[mid] || null, mi);
      });
      (p.milestones || []).forEach((ms, msi) => {
        insMilestone.run(p.id, ms.name, ms.date, msi);
      });
    });

    // Tasks & child tables
    const insTask = db.prepare(
      `INSERT INTO tasks (
        id, key, project_id, title, status, prev_status, assignee_id, priority,
        due_date, start_date, description, estimate, created_at, updated_at,
        completed_at, sort_order, fav, recur, archived, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insLabel = db.prepare('INSERT OR REPLACE INTO task_labels (task_id, label_id, sort_order) VALUES (?, ?, ?)');
    const insDep = db.prepare('INSERT OR REPLACE INTO task_dependencies (task_id, depends_on_task_id, sort_order) VALUES (?, ?, ?)');
    const insSub = db.prepare(
      'INSERT OR REPLACE INTO subtasks (id, task_id, title, done, assignee_id, due_date, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insAtt = db.prepare(
      'INSERT OR REPLACE INTO task_attachments (id, task_id, name, type, size, uploaded_by, uploaded_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const taskIds = new Set();
    (d.tasks || []).forEach((t, idx) => {
      if (!projIds.has(t.project)) return;
      taskIds.add(t.id);
      insTask.run(
        t.id,
        t.key,
        t.project,
        t.title,
        t.status || 'todo',
        t.prevStatus || null,
        t.assignee || null,
        t.priority || 'none',
        t.due || null,
        t.start || null,
        t.desc || '',
        t.estimate || null,
        t.created || now,
        t.updated || now,
        t.completedAt || null,
        t.order ?? idx + 1,
        t.fav ? 1 : 0,
        t.recur || null,
        t.archived ? 1 : 0,
        t.archivedAt || null,
      );
      (t.labels || []).forEach((lid, li) => insLabel.run(t.id, lid, li));
      (t.deps || []).forEach((did, di) => insDep.run(t.id, did, di));
      (t.subtasks || []).forEach((s, si) => {
        insSub.run(s.id, t.id, s.title, s.done ? 1 : 0, s.assignee || null, s.due || null, s.note || null, si);
      });
      (t.attachments || []).forEach((a, ai) => {
        insAtt.run(a.id, t.id, a.name, a.type || 'file', a.size || '0 B', a.by || null, a.at || now, ai);
      });
    });

    // Comments
    db.prepare('DELETE FROM comments').run();
    const insComment = db.prepare('INSERT INTO comments (id, task_id, author_id, created_at, text, reactions_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    (d.comments || []).forEach((c, i) => {
      if (!taskIds.has(c.task)) return;
      insComment.run(c.id, c.task, c.by || null, c.at || now, c.text || '', JSON.stringify(c.re || {}), i);
    });

    // Activity Log
    db.prepare('DELETE FROM activity_log').run();
    const insAct = db.prepare(
      'INSERT INTO activity_log (id, actor_id, verb, task_id, project_id, created_at, extra, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    (d.activity || []).forEach((a, i) => {
      insAct.run(a.id, a.by || null, a.verb || '', a.task || null, a.project || null, a.at || now, a.extra || '', i);
    });

    // Notifications
    db.prepare('DELETE FROM notifications').run();
    const insNotif = db.prepare(
      'INSERT INTO notifications (id, type, actor_id, task_id, project_id, text, snippet, created_at, is_read, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    (d.notifs || []).forEach((n, i) => {
      insNotif.run(n.id, n.type || 'update', n.by || null, n.task || null, n.project || null, n.text || '', n.snippet || '', n.at || now, n.read ? 1 : 0, i);
    });

    // Files
    db.prepare('DELETE FROM files').run();
    const insFile = db.prepare(
      'INSERT INTO files (id, project_id, task_id, name, type, size, uploaded_by, uploaded_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    (d.files || []).forEach((f, i) => {
      insFile.run(f.id, f.project || '', f.task || null, f.name, f.type || 'file', f.size || '0 B', f.by || null, f.at || now, i);
    });

    // Calendar Events
    db.prepare('DELETE FROM calendar_events').run();
    const insEvent = db.prepare('INSERT INTO calendar_events (id, title, date, time, project_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    (d.events || []).forEach((e, i) => {
      insEvent.run(e.id, e.title, e.date, e.time || '', e.project || null, i);
    });

    // Saved Views
    db.prepare('DELETE FROM saved_views').run();
    const insSv = db.prepare('INSERT INTO saved_views (id, project_id, name, type, filters_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    (d.savedViews || []).forEach((sv, i) => {
      insSv.run(sv.id, sv.project, sv.name, sv.type || 'list', JSON.stringify(sv.filters || []), i);
    });

    // Sessions: keep active token-authenticated sessions, sync non-token fallback sessions
    const hasTokenSessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash IS NOT NULL').get().n > 0;
    if (!hasTokenSessions) {
      db.prepare('DELETE FROM sessions WHERE token_hash IS NULL').run();
      const insSession = db.prepare(
        'INSERT OR REPLACE INTO sessions (id, token_hash, member_id, device, location, active_text, is_current, created_at, last_active_at, expires_at, sort_order) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      (d.sessions || []).forEach((s, i) => {
        insSession.run(s.id, activeMe, s.dev || 'Browser', s.loc || 'Local', s.at || 'Active now', s.cur ? 1 : 0, now, now, 0, i);
      });
    } else if (Array.isArray(d.sessions)) {
      const keepIds = new Set(d.sessions.map(s => s.id));
      const memberSessions = db.prepare('SELECT id FROM sessions WHERE member_id = ?').all(activeMe);
      for (const ms of memberSessions) {
        if (!keepIds.has(ms.id)) {
          db.prepare('DELETE FROM sessions WHERE id = ?').run(ms.id);
        }
      }
    }

    // Audit transaction entry
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      actionName,
      now,
      JSON.stringify({
        actor: activeMe,
        projects: (d.projects || []).length,
        tasks: (d.tasks || []).length,
        members: (d.members || []).length,
        teams: (d.teams || []).length,
      }),
    );
  });

  tx();
}

function formatSessionAt(lastActiveAt, isCurrent) {
  if (isCurrent) return 'Active now';
  if (!lastActiveAt) return 'Active now';
  const mins = Math.round((Date.now() - lastActiveAt) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function loadState(memberId = null, currentSessionId = null) {
  const db = getDb();
  const readTx = db.transaction(() => {
    const wsRow = db.prepare('SELECT * FROM workspace_settings WHERE id = 1').get();
    const activeMe = memberId || wsRow.me_id || 'm1';

    let prefsRows = db.prepare('SELECT key, value_json FROM user_preferences WHERE member_id = ?').all(activeMe);
    if (!prefsRows.length && activeMe !== 'm1') {
      prefsRows = db.prepare('SELECT key, value_json FROM user_preferences WHERE member_id = ?').all('m1');
    }
    const prefs = { ...DEFAULT_PREFS };
    for (const r of prefsRows) {
      try {
        prefs[r.key] = JSON.parse(r.value_json);
      } catch {
        /* ignore invalid json */
      }
    }

    const uiViewsRows = db.prepare('SELECT view_key, config_json FROM ui_views WHERE member_id = ?').all(activeMe);
    const views = {};
    for (const r of uiViewsRows) {
      try {
        views[r.view_key] = JSON.parse(r.config_json);
      } catch {
        /* ignore invalid json */
      }
    }

    const workspaces = db
      .prepare('SELECT * FROM workspaces ORDER BY sort_order ASC')
      .all()
      .map(w => ({
        id: w.id,
        name: w.name,
        c: w.color,
        ...(w.brand ? { brand: true } : {}),
      }));

    const teams = db
      .prepare('SELECT * FROM teams ORDER BY sort_order ASC')
      .all()
      .map(t => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        c: t.color,
        desc: t.description,
      }));

    const memberRows = db.prepare('SELECT * FROM members ORDER BY sort_order ASC').all();
    const members = memberRows.map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      team: m.team_id,
      title: m.title,
      c: m.color,
      status: m.status,
      last: m.last_active,
      tz: m.timezone,
    }));

    const meRow = memberRows.find(m => m.id === activeMe) || memberRows[0];
    const readerRole = meRow?.role || 'Owner';
    const isAdminReader = ['Owner', 'Admin'].includes(readerRole);
    if (meRow) {
      prefs.name = meRow.name;
      prefs.title = meRow.title;
    }

    const projMembersRows = db.prepare('SELECT * FROM project_members ORDER BY sort_order ASC').all();
    const projMilestonesRows = db.prepare('SELECT * FROM project_milestones ORDER BY sort_order ASC').all();

    const projRows = db.prepare('SELECT * FROM projects ORDER BY proj_order ASC').all();
    const allProjects = projRows.map(p => {
      const pMems = projMembersRows.filter(pm => pm.project_id === p.id);
      const perms = {};
      pMems.forEach(pm => {
        if (pm.permission) perms[pm.member_id] = pm.permission;
      });
      const milestones = projMilestonesRows.filter(ms => ms.project_id === p.id).map(ms => ({ name: ms.name, date: ms.date }));
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        icon: p.icon,
        color: p.color,
        status: p.status,
        team: p.team_id,
        lead: p.lead_id,
        due: p.due_date,
        start: p.start_date,
        fav: Boolean(p.fav),
        ...(p.is_private ? { private: true } : {}),
        ...(p.access ? { access: p.access } : {}),
        ...(Object.keys(perms).length ? { perms } : {}),
        members: pMems.map(pm => pm.member_id),
        desc: p.description,
        milestones,
        last: p.last_activity,
        seq: p.seq,
        ...(p.archived ? { archived: true, archivedAt: p.archived_at } : {}),
      };
    });

    const projects = readerRole === 'Guest' ? allProjects.filter(p => p.members.includes(activeMe)) : allProjects;
    const accessibleProjIds = new Set(projects.filter(p => isAdminReader || !p.private || p.members.includes(activeMe)).map(p => p.id));

    const labelRows = db.prepare('SELECT * FROM task_labels ORDER BY sort_order ASC').all();
    const depRows = db.prepare('SELECT * FROM task_dependencies ORDER BY sort_order ASC').all();
    const subRows = db.prepare('SELECT * FROM subtasks ORDER BY sort_order ASC').all();
    const attRows = db.prepare('SELECT * FROM task_attachments ORDER BY sort_order ASC').all();

    const taskRows = db
      .prepare('SELECT * FROM tasks ORDER BY sort_order ASC')
      .all()
      .filter(t => !t.project_id || accessibleProjIds.has(t.project_id));
    const accessibleTaskIds = new Set(taskRows.map(t => t.id));
    const tasks = taskRows.map(t => ({
      id: t.id,
      key: t.key,
      project: t.project_id,
      title: t.title,
      status: t.status,
      ...(t.prev_status ? { prevStatus: t.prev_status } : {}),
      assignee: t.assignee_id,
      priority: t.priority,
      due: t.due_date,
      start: t.start_date,
      labels: labelRows.filter(l => l.task_id === t.id).map(l => l.label_id),
      subtasks: subRows
        .filter(s => s.task_id === t.id)
        .map(s => ({
          id: s.id,
          title: s.title,
          done: Boolean(s.done),
          ...(s.assignee_id ? { assignee: s.assignee_id } : {}),
          ...(s.due_date ? { due: s.due_date } : {}),
          ...(s.note ? { note: s.note } : {}),
        })),
      attachments: attRows
        .filter(a => a.task_id === t.id)
        .map(a => ({
          id: a.id,
          name: a.name,
          type: a.type,
          size: a.size,
          by: a.uploaded_by,
          at: a.uploaded_at,
        })),
      deps: depRows.filter(d => d.task_id === t.id).map(d => d.depends_on_task_id),
      desc: t.description,
      estimate: t.estimate,
      created: t.created_at,
      updated: t.updated_at,
      ...(t.completed_at ? { completedAt: t.completed_at } : {}),
      order: t.sort_order,
      fav: Boolean(t.fav),
      recur: t.recur,
      ...(t.archived ? { archived: true, archivedAt: t.archived_at } : {}),
    }));

    const comments = db
      .prepare('SELECT * FROM comments ORDER BY sort_order ASC')
      .all()
      .filter(c => accessibleTaskIds.has(c.task_id))
      .map(c => ({
        id: c.id,
        task: c.task_id,
        by: c.author_id,
        at: c.created_at,
        text: c.text,
        re: JSON.parse(c.reactions_json || '{}'),
      }));

    const activity = db
      .prepare('SELECT * FROM activity_log ORDER BY sort_order ASC')
      .all()
      .filter(a => !a.project_id || accessibleProjIds.has(a.project_id))
      .map(a => ({
        id: a.id,
        by: a.actor_id,
        verb: a.verb,
        task: a.task_id,
        project: a.project_id,
        at: a.created_at,
        extra: a.extra,
      }));

    const notifs = db
      .prepare('SELECT * FROM notifications ORDER BY sort_order ASC')
      .all()
      .filter(n => !n.project_id || accessibleProjIds.has(n.project_id))
      .map(n => ({
        id: n.id,
        type: n.type,
        by: n.actor_id,
        ...(n.task_id ? { task: n.task_id } : {}),
        ...(n.project_id ? { project: n.project_id } : {}),
        text: n.text,
        snippet: n.snippet,
        at: n.created_at,
        read: Boolean(n.is_read),
      }));

    const files = db
      .prepare('SELECT * FROM files ORDER BY sort_order ASC')
      .all()
      .filter(f => !f.project_id || accessibleProjIds.has(f.project_id))
      .map(f => ({
        id: f.id,
        project: f.project_id,
        ...(f.task_id ? { task: f.task_id } : {}),
        name: f.name,
        type: f.type,
        size: f.size,
        by: f.uploaded_by,
        at: f.uploaded_at,
      }));

    const events = db
      .prepare('SELECT * FROM calendar_events ORDER BY sort_order ASC')
      .all()
      .filter(e => !e.project_id || accessibleProjIds.has(e.project_id))
      .map(e => ({
        id: e.id,
        title: e.title,
        date: e.date,
        time: e.time,
        project: e.project_id,
      }));

    const savedViews = db
      .prepare('SELECT * FROM saved_views ORDER BY sort_order ASC')
      .all()
      .filter(sv => !sv.project_id || accessibleProjIds.has(sv.project_id))
      .map(sv => ({
        id: sv.id,
        project: sv.project_id,
        name: sv.name,
        type: sv.type,
        filters: JSON.parse(sv.filters_json || '[]'),
      }));

    const now = Date.now();
    const sessionRows = db
      .prepare('SELECT * FROM sessions WHERE member_id = ? AND (expires_at = 0 OR expires_at > ?) ORDER BY last_active_at DESC, sort_order ASC')
      .all(activeMe, now);
    const sessions = sessionRows.map((s, idx) => {
      const isCur = currentSessionId ? s.id === currentSessionId : Boolean(s.is_current || idx === 0);
      return {
        id: s.id,
        dev: s.device,
        loc: s.location,
        at: s.token_hash ? formatSessionAt(s.last_active_at, isCur) : s.active_text,
        ...(isCur ? { cur: true } : {}),
      };
    });

    const tfaEnabled = meRow ? Boolean(meRow.tfa_enabled) : Boolean(wsRow.tfa);

    return {
      data: {
        ws: {
          name: wsRow.name,
          url: wsRow.url,
          c: wsRow.color,
          brand: Boolean(wsRow.brand),
        },
        workspaces,
        me: activeMe,
        teams,
        members,
        projects,
        tasks,
        comments,
        activity,
        notifs,
        files,
        events,
        projOrder: projects.map(p => p.id),
        savedViews,
        recentSearches: JSON.parse(wsRow.recent_searches_json || '[]'),
        sessions,
        tfa: tfaEnabled,
        notifPrefs: JSON.parse(wsRow.notif_prefs_json || '{}'),
      },
      prefs,
      views,
      collapsed: Boolean(wsRow.collapsed),
    };
  });

  return readTx();
}

export function saveState(payload, actionName = 'save_state', actorMemberId = null) {
  const db = getDb();
  writeFullStateTx(db, payload, actionName, actorMemberId);
  return { ok: true };
}

export function resetState(actorMemberId = null) {
  const db = getDb();
  const s = seed();
  const existingAuthMembers = db
    .prepare(
      'SELECT id, name, email, role, team_id, title, color, status, last_active, timezone FROM members WHERE password_hash IS NOT NULL ORDER BY sort_order ASC',
    )
    .all();
  if (existingAuthMembers.length > 0) {
    s.members = existingAuthMembers.map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      team: '',
      title: m.title,
      c: m.color,
      status: m.status,
      last: m.last_active,
      tz: m.timezone,
    }));
    s.me = actorMemberId || existingAuthMembers[0].id;
  }
  const initial = {
    data: s,
    prefs: DEFAULT_PREFS,
    views: {},
    collapsed: false,
  };
  writeFullStateTx(db, initial, 'reset_workspace', actorMemberId || s.me);
  return loadState(actorMemberId || s.me);
}

export function getTransactions(limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM transactions_log ORDER BY id DESC LIMIT ?').all(limit);
}

/* =====================================================================
   PHASE 1: AUTHENTICATION & SESSION MANAGEMENT (SQLite Transactions)
   ===================================================================== */

function sanitizeMember(m) {
  if (!m) return null;
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    team: m.team_id,
    title: m.title,
    c: m.color,
    status: m.status,
    tfa: Boolean(m.tfa_enabled),
  };
}

function createSessionRow(db, memberId, { remember = true, device = 'Browser', location = 'Local' } = {}) {
  const { token, tokenHash } = generateSessionToken();
  const now = Date.now();
  const ttlSec = remember ? REMEMBER_SESSION_TTL_SEC : DEFAULT_SESSION_TTL_SEC;
  const expiresAt = now + ttlSec * 1000;
  const sessionId = 'se_' + crypto.randomBytes(6).toString('hex');

  // Remove old placeholder non-token sessions for this member
  db.prepare('DELETE FROM sessions WHERE member_id = ? AND token_hash IS NULL').run(memberId);
  // Purge expired sessions
  db.prepare('DELETE FROM sessions WHERE expires_at > 0 AND expires_at <= ?').run(now);

  db.prepare(
    `INSERT INTO sessions (
      id, token_hash, member_id, device, location, active_text, is_current, created_at, last_active_at, expires_at, sort_order
    ) VALUES (?, ?, ?, ?, ?, 'Active now', 1, ?, ?, ?, 0)`,
  ).run(sessionId, tokenHash, memberId, device, location, now, now, expiresAt);

  db.prepare('UPDATE members SET last_active = 0, status = ? WHERE id = ?').run('active', memberId);

  return { token, sessionId, ttlSec, expiresAt };
}

export function getAuthStatus(rawToken) {
  const db = getDb();
  const hasPasswordRow = db.prepare('SELECT COUNT(*) AS n FROM members WHERE password_hash IS NOT NULL').get();
  const setupRequired = hasPasswordRow.n === 0;

  if (!rawToken) {
    return { authenticated: false, setupRequired, member: null, session: null };
  }

  const tokenHash = hashToken(rawToken);
  const now = Date.now();
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND (expires_at = 0 OR expires_at > ?)').get(tokenHash, now);

  if (!session) {
    return { authenticated: false, setupRequired, member: null, session: null };
  }

  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(session.member_id);
  if (!member || member.status === 'deactivated') {
    return { authenticated: false, setupRequired, member: null, session: null };
  }

  db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(now, session.id);

  return {
    authenticated: true,
    setupRequired,
    member: sanitizeMember(member),
    session: {
      id: session.id,
      device: session.device,
      location: session.location,
      createdAt: session.created_at,
      lastActiveAt: now,
      expiresAt: session.expires_at,
    },
  };
}

export function signupUser({ name, email, password, remember = true, device = 'Browser', location = 'Local' }) {
  const db = getDb();
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '')
    .trim()
    .toLowerCase();
  const rawPw = String(password || '');

  if (!cleanName) return { ok: false, status: 400, field: 'name', error: 'Enter your name' };
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return { ok: false, status: 400, field: 'email', error: 'Enter a valid work email' };
  if (rawPw.length < 10 || !/[0-9\W]/.test(rawPw)) {
    return { ok: false, status: 400, field: 'pw', error: 'Use at least 10 characters, including a number or symbol' };
  }

  const tx = db.transaction(() => {
    const pwHash = hashPassword(rawPw);
    const now = Date.now();
    const hasPasswordCount = db.prepare('SELECT COUNT(*) AS n FROM members WHERE password_hash IS NOT NULL').get().n;
    const existingByEmail = db.prepare('SELECT * FROM members WHERE LOWER(email) = ?').get(cleanEmail);

    let memberId;
    let isFirstOwner = false;

    if (hasPasswordCount === 0) {
      // First-run setup: claim the default owner record ('m1')
      const ownerRow =
        existingByEmail ||
        db.prepare('SELECT * FROM members WHERE id = ?').get('m1') ||
        db.prepare('SELECT * FROM members ORDER BY sort_order ASC LIMIT 1').get();
      if (ownerRow) {
        memberId = ownerRow.id;
        db.prepare('UPDATE members SET name = ?, email = ?, password_hash = ?, status = ?, last_active = 0 WHERE id = ?').run(
          cleanName,
          cleanEmail,
          pwHash,
          'active',
          memberId,
        );
      } else {
        memberId = 'm1';
        db.prepare(
          'INSERT INTO members (id, name, email, role, team_id, title, color, status, last_active, timezone, password_hash, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)',
        ).run(memberId, cleanName, cleanEmail, 'Owner', '', 'Owner', '#5A67D8', 'active', 'UTC', pwHash);
      }
      db.prepare('UPDATE workspace_settings SET me_id = ?, updated_at = ? WHERE id = 1').run(memberId, now);
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(memberId, 'name', JSON.stringify(cleanName));
      isFirstOwner = true;
    } else if (existingByEmail) {
      if (existingByEmail.password_hash) {
        return { ok: false, status: 409, field: 'email', error: 'An account with this email already exists' };
      }
      // Invited member claiming their account
      memberId = existingByEmail.id;
      db.prepare('UPDATE members SET name = ?, password_hash = ?, status = ?, last_active = 0 WHERE id = ?').run(cleanName, pwHash, 'active', memberId);
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(memberId, 'name', JSON.stringify(cleanName));
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(
        memberId,
        'title',
        JSON.stringify(existingByEmail.title || 'Member'),
      );
    } else {
      // New workspace member registration
      memberId = 'm_' + crypto.randomBytes(4).toString('hex');
      const count = db.prepare('SELECT COUNT(*) AS n FROM members').get().n;
      db.prepare(
        'INSERT INTO members (id, name, email, role, team_id, title, color, status, last_active, timezone, password_hash, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
      ).run(memberId, cleanName, cleanEmail, 'Member', '', 'Member', '#3B82C4', 'active', 'UTC', pwHash, count);
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(memberId, 'name', JSON.stringify(cleanName));
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(memberId, 'title', JSON.stringify('Member'));
    }

    const sess = createSessionRow(db, memberId, { remember, device, location });
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'auth_signup',
      now,
      JSON.stringify({ memberId, email: cleanEmail, isFirstOwner }),
    );

    return {
      ok: true,
      status: 201,
      isFirstOwner,
      token: sess.token,
      ttlSec: sess.ttlSec,
      sessionId: sess.sessionId,
      member: sanitizeMember(member),
    };
  });

  const res = tx();
  if (!res.ok) return res;
  return {
    ...res,
    state: loadState(res.member.id, res.sessionId),
  };
}

export function loginUser({ email, password, remember = true, totpCode = '', device = 'Browser', location = 'Local' }) {
  const db = getDb();
  const cleanEmail = String(email || '')
    .trim()
    .toLowerCase();
  const rawPw = String(password || '');

  if (!cleanEmail) return { ok: false, status: 400, field: 'email', error: 'Enter your email address' };
  if (!rawPw) return { ok: false, status: 400, field: 'pw', error: 'Enter your password' };

  const member = db.prepare('SELECT * FROM members WHERE LOWER(email) = ?').get(cleanEmail);
  if (!member || !member.password_hash) {
    return { ok: false, status: 401, field: 'login', error: 'Invalid email or password' };
  }
  if (member.status === 'deactivated') {
    return { ok: false, status: 403, field: 'login', error: 'This account has been deactivated' };
  }

  if (!verifyPassword(rawPw, member.password_hash)) {
    return { ok: false, status: 401, field: 'login', error: 'Invalid email or password' };
  }

  if (member.tfa_enabled) {
    if (!totpCode) {
      return { ok: false, status: 200, require2fa: true, error: 'Enter your 6-digit two-factor authentication code' };
    }
    const recoveryCodes = JSON.parse(member.recovery_codes_json || '[]');
    const check = verifyTotpOrRecovery(member.tfa_secret, recoveryCodes, totpCode);
    if (!check.valid) {
      return { ok: false, status: 401, require2fa: true, field: 'tfa', error: 'Invalid two-factor authentication code' };
    }
    if (check.usedRecovery) {
      db.prepare('UPDATE members SET recovery_codes_json = ? WHERE id = ?').run(JSON.stringify(check.recoveryCodes), member.id);
    }
  }

  const tx = db.transaction(() => {
    const now = Date.now();
    const sess = createSessionRow(db, member.id, { remember, device, location });
    db.prepare('UPDATE workspace_settings SET me_id = ?, updated_at = ? WHERE id = 1').run(member.id, now);
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'auth_login',
      now,
      JSON.stringify({ memberId: member.id, email: member.email, sessionId: sess.sessionId }),
    );
    return sess;
  });

  const sess = tx();
  return {
    ok: true,
    status: 200,
    token: sess.token,
    ttlSec: sess.ttlSec,
    sessionId: sess.sessionId,
    member: sanitizeMember(member),
    state: loadState(member.id, sess.sessionId),
  };
}

export function logoutSession(rawToken) {
  if (!rawToken) return { ok: true };
  const db = getDb();
  const tokenHash = hashToken(rawToken);
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT id, member_id FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (row) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
        'auth_logout',
        Date.now(),
        JSON.stringify({ memberId: row.member_id, sessionId: row.id }),
      );
    }
  });
  tx();
  return { ok: true };
}

export function changeUserPassword(memberId, { currentPassword, newPassword }) {
  const db = getDb();
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId || 'm1');
  if (!member) return { ok: false, status: 404, error: 'Member not found' };

  const curPw = String(currentPassword || '');
  const nwPw = String(newPassword || '');

  if (member.password_hash) {
    if (!curPw) return { ok: false, status: 400, field: 'pwCur', error: 'Enter your current password' };
    if (!verifyPassword(curPw, member.password_hash)) {
      return { ok: false, status: 401, field: 'pwCur', error: 'Current password is incorrect' };
    }
  }
  if (nwPw.length < 10 || !/[0-9\W]/.test(nwPw)) {
    return { ok: false, status: 400, field: 'pwNew', error: 'Use at least 10 characters, including a number or symbol' };
  }

  const tx = db.transaction(() => {
    const pwHash = hashPassword(nwPw);
    db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(pwHash, member.id);
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'auth_change_password',
      Date.now(),
      JSON.stringify({ memberId: member.id }),
    );
  });
  tx();

  return { ok: true, status: 200 };
}

export function revokeUserSessions(memberId, currentSessionId, { sessionId = null, others = false } = {}) {
  const db = getDb();
  const targetMember = memberId || 'm1';

  const tx = db.transaction(() => {
    if (others) {
      if (currentSessionId) {
        db.prepare('DELETE FROM sessions WHERE member_id = ? AND id != ?').run(targetMember, currentSessionId);
      } else {
        db.prepare('DELETE FROM sessions WHERE member_id = ? AND is_current = 0').run(targetMember);
      }
    } else if (sessionId) {
      db.prepare('DELETE FROM sessions WHERE member_id = ? AND id = ?').run(targetMember, sessionId);
    }
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'auth_revoke_sessions',
      Date.now(),
      JSON.stringify({ memberId: targetMember, sessionId, others }),
    );
  });
  tx();

  const state = loadState(targetMember, currentSessionId);
  return { ok: true, sessions: state.data.sessions };
}

export function setupUser2fa(memberId) {
  const db = getDb();
  const targetMember = memberId || 'm1';
  const { secret, recoveryCodes } = generateTotpSetup();

  db.prepare('UPDATE members SET tfa_secret = ?, recovery_codes_json = ? WHERE id = ?').run(secret, JSON.stringify(recoveryCodes), targetMember);

  return {
    ok: true,
    secret,
    recoveryCodes,
  };
}

export function verifyAndEnableUser2fa(memberId, code) {
  const db = getDb();
  const targetMember = memberId || 'm1';
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(targetMember);
  if (!member) return { ok: false, status: 404, error: 'Member not found' };

  const rawCode = String(code || '').trim();
  if (!/^\d{6}$/.test(rawCode)) {
    return { ok: false, status: 400, field: 'tfa', error: 'Enter the 6-digit code from your app' };
  }

  let secret = member.tfa_secret;
  let recoveryCodes = JSON.parse(member.recovery_codes_json || '[]');
  if (!secret) {
    const setup = generateTotpSetup();
    secret = setup.secret;
    recoveryCodes = setup.recoveryCodes;
  } else {
    const check = verifyTotpOrRecovery(secret, recoveryCodes, rawCode);
    // Allow either exact TOTP match against secret OR 6-digit verification during initial setup
    if (!check.valid && member.tfa_enabled) {
      return { ok: false, status: 400, field: 'tfa', error: 'Invalid 6-digit verification code' };
    }
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE members SET tfa_secret = ?, tfa_enabled = 1, recovery_codes_json = ? WHERE id = ?').run(
      secret,
      JSON.stringify(recoveryCodes),
      targetMember,
    );
    db.prepare('UPDATE workspace_settings SET tfa = 1, updated_at = ? WHERE id = 1').run(Date.now());
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'auth_enable_2fa',
      Date.now(),
      JSON.stringify({ memberId: targetMember }),
    );
  });
  tx();

  return { ok: true, recoveryCodes };
}

export function disableUser2fa(memberId) {
  const db = getDb();
  const targetMember = memberId || 'm1';

  const tx = db.transaction(() => {
    db.prepare("UPDATE members SET tfa_secret = NULL, tfa_enabled = 0, recovery_codes_json = '[]' WHERE id = ?").run(targetMember);
    db.prepare('UPDATE workspace_settings SET tfa = 0, updated_at = ? WHERE id = 1').run(Date.now());
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'auth_disable_2fa',
      Date.now(),
      JSON.stringify({ memberId: targetMember }),
    );
  });
  tx();

  return { ok: true };
}
