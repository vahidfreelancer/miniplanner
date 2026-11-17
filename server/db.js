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
import {
  canManageMembership,
  canReadProject,
  canWriteProject,
  getScope,
  normalizeProjectPermission,
  redactMemberForScope,
  toUiPermission,
} from './authz.js';

const DATA_DIR = path.resolve('data');
export const DB_PATH = process.env.MINIPLANNER_DB_PATH || path.join(DATA_DIR, 'miniplanner.sqlite');

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
let _dbPath = null;

export function getDb(customPath = null) {
  const targetPath = customPath || process.env.MINIPLANNER_DB_PATH || DB_PATH;
  if (_db && _dbPath === targetPath) return _db;
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore close errors */
    }
  }
  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }
  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  migrateSchema(db);
  _db = db;
  _dbPath = targetPath;
  ensureInitialized(db);
  return db;
}

export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
    _dbPath = null;
  }
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
  addColumnIfMissing(db, 'notifications', 'recipient_id', 'TEXT NULL');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);
    CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
    CREATE INDEX IF NOT EXISTS idx_pm_member ON project_members(member_id);
    CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_id);
  `);

  // Backfill: ensure every project lead is listed in project_members with 'lead' permission
  const projectsWithLeads = db.prepare('SELECT id, lead_id FROM projects WHERE lead_id IS NOT NULL AND lead_id != ?').all('');
  const upsertLeadMem = db.prepare(
    `INSERT INTO project_members (project_id, member_id, permission, sort_order)
     VALUES (?, ?, 'lead', 0)
     ON CONFLICT(project_id, member_id) DO UPDATE SET permission = 'lead'`,
  );
  for (const p of projectsWithLeads) {
    upsertLeadMem.run(p.id, p.lead_id);
  }

  // Normalize existing project_members.permission values
  const pmRows = db.prepare('SELECT project_id, member_id, permission FROM project_members').all();
  const leadMap = new Map(projectsWithLeads.map(p => [p.id, p.lead_id]));
  const updPerm = db.prepare('UPDATE project_members SET permission = ? WHERE project_id = ? AND member_id = ?');
  for (const pm of pmRows) {
    const isLead = leadMap.get(pm.project_id) === pm.member_id;
    const norm = normalizeProjectPermission(pm.permission, isLead);
    if (pm.permission !== norm) {
      updPerm.run(norm, pm.project_id, pm.member_id);
    }
  }

  // Backfill workspace-level recentSearches and notifPrefs into per-member user_preferences
  const wsRow = db.prepare('SELECT me_id, notif_prefs_json, recent_searches_json FROM workspace_settings WHERE id = 1').get();
  if (wsRow) {
    const ownerId = wsRow.me_id || 'm1';
    const hasNotifPref = db.prepare('SELECT 1 FROM user_preferences WHERE member_id = ? AND key = ?').get(ownerId, '_notifPrefs');
    if (!hasNotifPref && wsRow.notif_prefs_json) {
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(ownerId, '_notifPrefs', wsRow.notif_prefs_json);
    }
    const hasRecentSearches = db.prepare('SELECT 1 FROM user_preferences WHERE member_id = ? AND key = ?').get(ownerId, '_recentSearches');
    if (!hasRecentSearches && wsRow.recent_searches_json) {
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(
        ownerId,
        '_recentSearches',
        wsRow.recent_searches_json,
      );
    }
  }
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

    CREATE TABLE IF NOT EXISTS project_team_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_team_id TEXT NOT NULL DEFAULT '',
      from_team_name TEXT NOT NULL DEFAULT 'No team',
      to_team_id TEXT NOT NULL DEFAULT '',
      to_team_name TEXT NOT NULL DEFAULT 'No team',
      changed_by TEXT NULL,
      changed_at INTEGER NOT NULL DEFAULT 0,
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
      recipient_id TEXT NULL,
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
      { forceAdmin: true },
    );
  }
}

function writeFullStateTx(db, payload, actionName = 'save_state', actorMemberId = null, opts = {}) {
  const tx = db.transaction(() => {
    const d = payload?.data || seed();
    const activeMe = actorMemberId || d.me || 'm1';
    const scope = opts.forceAdmin
      ? {
          memberId: activeMe,
          role: 'Owner',
          isAdmin: true,
          projectIds: new Set(),
          projectRole: new Map(),
          projectMemberMap: new Map(),
          coMemberIds: new Set([activeMe]),
          visibleMemberIds: new Set([activeMe]),
          adminIds: new Set([activeMe]),
        }
      : getScope(db, activeMe);
    const isAdminActor = scope.isAdmin;
    const prefs = Object.assign({}, DEFAULT_PREFS, payload?.prefs || {});
    const views = payload?.views || {};
    const collapsed = payload?.collapsed ? 1 : 0;
    const now = Date.now();

    const prevWs = db.prepare('SELECT * FROM workspace_settings WHERE id = 1').get();
    const ws =
      isAdminActor || !prevWs
        ? d.ws || { name: 'My Workspace', url: 'my-workspace', c: '#1D1C1A', brand: true }
        : { name: prevWs.name, url: prevWs.url, c: prevWs.color, brand: Boolean(prevWs.brand) };
    const nextWsMe = isAdminActor || !prevWs ? activeMe : prevWs.me_id;
    const nextWsTfa = isAdminActor || !prevWs ? (d.tfa ? 1 : 0) : prevWs.tfa;
    const nextWsCollapsed = isAdminActor || !prevWs ? collapsed : prevWs.collapsed;
    const nextWsNotifJson = isAdminActor || !prevWs ? JSON.stringify(d.notifPrefs || {}) : prevWs.notif_prefs_json;
    const nextWsSearchJson = isAdminActor || !prevWs ? JSON.stringify(d.recentSearches || []) : prevWs.recent_searches_json;

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
      nextWsMe,
      nextWsTfa,
      nextWsCollapsed,
      nextWsNotifJson,
      nextWsSearchJson,
      now,
    );

    // Preferences (scoped by member_id, including per-user _notifPrefs, _recentSearches, _collapsed)
    db.prepare('DELETE FROM user_preferences WHERE member_id = ?').run(activeMe);
    const insPref = db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries(prefs)) {
      if (k.startsWith('_')) continue;
      insPref.run(activeMe, k, JSON.stringify(v));
    }
    insPref.run(activeMe, '_notifPrefs', JSON.stringify(d.notifPrefs || {}));
    insPref.run(activeMe, '_recentSearches', JSON.stringify(Array.isArray(d.recentSearches) ? d.recentSearches : []));
    insPref.run(activeMe, '_collapsed', JSON.stringify(Boolean(payload?.collapsed)));

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
    // Non-admins can ONLY update their own profile fields (name, title, color, tz, tfa) and cannot create/delete/modify other members.
    const existingCreds = new Map(
      db
        .prepare('SELECT * FROM members')
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
      if (!isAdminActor && m.id !== activeMe) return;
      const prev = existingCreds.get(m.id);
      if (!isAdminActor && !prev) return;
      const effectiveRole = isAdminActor ? m.role || 'Member' : prev.role;
      const effectiveStatus = isAdminActor ? m.status || 'active' : prev.status;
      const effectiveEmail = isAdminActor ? m.email || prev?.email || '' : prev.email || m.email || '';
      const effectiveTeam = isAdminActor ? m.team || '' : prev.team_id || '';
      const effectiveSort = isAdminActor ? i : (prev.sort_order ?? i);
      const tfaFlag = m.id === activeMe && typeof d.tfa === 'boolean' ? (d.tfa ? 1 : 0) : (prev?.tfa_enabled ?? 0);
      upsertMember.run(
        m.id,
        m.name || prev?.name || 'Member',
        effectiveEmail,
        effectiveRole,
        effectiveTeam,
        m.title ?? prev?.title ?? '',
        m.c || prev?.color || '#5A67D8',
        effectiveStatus,
        m.last ?? prev?.last_active ?? null,
        m.tz || prev?.timezone || 'UTC',
        prev?.password_hash ?? null,
        prev?.tfa_secret ?? null,
        tfaFlag,
        prev?.recovery_codes_json ?? '[]',
        effectiveSort,
      );
      if (effectiveStatus === 'deactivated') {
        db.prepare('DELETE FROM sessions WHERE member_id = ?').run(m.id);
      }
    });

    // Projects: Scoped merge (NEVER delete out-of-scope projects or allow non-admins to create/delete projects or alter membership)
    const existingProjs = new Map(
      db
        .prepare('SELECT * FROM projects')
        .all()
        .map(p => [p.id, p]),
    );
    const incomingProjs = Array.isArray(d.projects) ? d.projects : [];
    const incomingProjIds = new Set(incomingProjs.map(p => p.id));

    if (isAdminActor) {
      for (const oldPid of existingProjs.keys()) {
        if (!incomingProjIds.has(oldPid)) {
          db.prepare('DELETE FROM projects WHERE id = ?').run(oldPid);
        }
      }
    }

    const upsertProj = db.prepare(
      `INSERT INTO projects (
        id, key, name, icon, color, status, team_id, lead_id, due_date, start_date,
        fav, is_private, access, description, last_activity, seq, archived, archived_at, proj_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key = excluded.key,
        name = excluded.name,
        icon = excluded.icon,
        color = excluded.color,
        status = excluded.status,
        team_id = excluded.team_id,
        lead_id = excluded.lead_id,
        due_date = excluded.due_date,
        start_date = excluded.start_date,
        fav = excluded.fav,
        is_private = excluded.is_private,
        access = excluded.access,
        description = excluded.description,
        last_activity = excluded.last_activity,
        seq = excluded.seq,
        archived = excluded.archived,
        archived_at = excluded.archived_at,
        proj_order = excluded.proj_order`,
    );
    const insProjMem = db.prepare('INSERT OR REPLACE INTO project_members (project_id, member_id, permission, sort_order) VALUES (?, ?, ?, ?)');
    const insMilestone = db.prepare('INSERT INTO project_milestones (project_id, name, date, sort_order) VALUES (?, ?, ?, ?)');
    const insTeamHist = db.prepare(
      'INSERT OR REPLACE INTO project_team_history (id, project_id, from_team_id, from_team_name, to_team_id, to_team_name, changed_by, changed_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const projOrderList = d.projOrder || [];
    const editableProjIds = new Set();
    const commentableProjIds = new Set();

    incomingProjs.forEach((p, idx) => {
      if (!p || !p.id) return;
      const prevP = existingProjs.get(p.id);

      if (isAdminActor) {
        editableProjIds.add(p.id);
        commentableProjIds.add(p.id);
        const orderIdx = projOrderList.indexOf(p.id);
        const leadId = p.lead || null;
        upsertProj.run(
          p.id,
          p.key || 'PRJ',
          p.name,
          p.icon || 'folder',
          p.color || 'indigo',
          p.status || 'planning',
          p.team || '',
          leadId,
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

        db.prepare('DELETE FROM project_members WHERE project_id = ?').run(p.id);
        const memList = Array.isArray(p.members) ? [...p.members] : [];
        if (leadId && !memList.includes(leadId)) memList.unshift(leadId);
        memList.forEach((mid, mi) => {
          const isLead = mid === leadId;
          const normPerm = normalizeProjectPermission(p.perms?.[mid], isLead);
          insProjMem.run(p.id, mid, normPerm, mi);
        });

        db.prepare('DELETE FROM project_milestones WHERE project_id = ?').run(p.id);
        (p.milestones || []).forEach((ms, msi) => {
          insMilestone.run(p.id, ms.name, ms.date, msi);
        });

        db.prepare('DELETE FROM project_team_history WHERE project_id = ?').run(p.id);
        (p.teamHistory || []).forEach((th, thi) => {
          insTeamHist.run(
            th.id || `th_${p.id}_${thi}`,
            p.id,
            th.fromTeam || '',
            th.fromName || 'No team',
            th.toTeam || '',
            th.toName || 'No team',
            th.by || activeMe,
            th.at || now,
            thi,
          );
        });
      } else {
        // Non-admin cannot create new projects
        if (!prevP) return;
        if (!canReadProject(scope, p.id)) return;
        if (canWriteProject(scope, p.id, 'comment')) {
          commentableProjIds.add(p.id);
        }
        if (!canWriteProject(scope, p.id, 'edit')) return;

        editableProjIds.add(p.id);
        // Non-admin can update project working fields (status, dates, description, milestones, seq)
        // but CANNOT alter project membership, permissions, access, privacy, team, or lead
        upsertProj.run(
          p.id,
          prevP.key,
          p.name || prevP.name,
          p.icon || prevP.icon,
          p.color || prevP.color,
          p.status || prevP.status,
          prevP.team_id,
          prevP.lead_id,
          p.due !== undefined ? p.due || null : prevP.due_date,
          p.start !== undefined ? p.start || null : prevP.start_date,
          p.fav !== undefined ? (p.fav ? 1 : 0) : prevP.fav,
          prevP.is_private,
          prevP.access,
          p.desc !== undefined ? p.desc : prevP.description,
          p.last ?? prevP.last_activity,
          p.seq ?? prevP.seq,
          prevP.archived,
          prevP.archived_at,
          prevP.proj_order,
        );

        db.prepare('DELETE FROM project_milestones WHERE project_id = ?').run(p.id);
        (p.milestones || []).forEach((ms, msi) => {
          insMilestone.run(p.id, ms.name, ms.date, msi);
        });
      }
    });

    // Also include any in-scope projects that were not in incomingProjs for commentable/editable sets
    if (!isAdminActor) {
      for (const pid of scope.projectIds) {
        if (canWriteProject(scope, pid, 'comment')) commentableProjIds.add(pid);
      }
    }

    // Rebuild current project member map after any admin project updates
    const currentProjMembers = new Map();
    for (const r of db.prepare('SELECT id, lead_id FROM projects').all()) {
      const s = new Set();
      if (r.lead_id) s.add(r.lead_id);
      currentProjMembers.set(r.id, s);
    }
    for (const pm of db.prepare('SELECT project_id, member_id FROM project_members').all()) {
      let s = currentProjMembers.get(pm.project_id);
      if (!s) {
        s = new Set();
        currentProjMembers.set(pm.project_id, s);
      }
      s.add(pm.member_id);
    }

    // Tasks & child tables: Scoped merge per editable project
    const existingTasks = new Map(
      db
        .prepare('SELECT * FROM tasks')
        .all()
        .map(t => [t.id, t]),
    );
    const incomingTasks = Array.isArray(d.tasks) ? d.tasks : [];
    const incomingTaskIdsByProj = new Map();
    for (const t of incomingTasks) {
      if (!t || !t.id || !t.project) continue;
      if (!incomingTaskIdsByProj.has(t.project)) incomingTaskIdsByProj.set(t.project, new Set());
      incomingTaskIdsByProj.get(t.project).add(t.id);
    }

    // Delete removed tasks ONLY within projects that were edited in this payload
    for (const [tid, oldT] of existingTasks.entries()) {
      if (!editableProjIds.has(oldT.project_id)) continue;
      const keepSet = incomingTaskIdsByProj.get(oldT.project_id);
      if (!keepSet || !keepSet.has(tid)) {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(tid);
        existingTasks.delete(tid);
      }
    }

    const upsertTask = db.prepare(
      `INSERT INTO tasks (
        id, key, project_id, title, status, prev_status, assignee_id, priority,
        due_date, start_date, description, estimate, created_at, updated_at,
        completed_at, sort_order, fav, recur, archived, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key = excluded.key,
        project_id = excluded.project_id,
        title = excluded.title,
        status = excluded.status,
        prev_status = excluded.prev_status,
        assignee_id = excluded.assignee_id,
        priority = excluded.priority,
        due_date = excluded.due_date,
        start_date = excluded.start_date,
        description = excluded.description,
        estimate = excluded.estimate,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        sort_order = excluded.sort_order,
        fav = excluded.fav,
        recur = excluded.recur,
        archived = excluded.archived,
        archived_at = excluded.archived_at`,
    );
    const insLabel = db.prepare('INSERT OR REPLACE INTO task_labels (task_id, label_id, sort_order) VALUES (?, ?, ?)');
    const insDep = db.prepare('INSERT OR REPLACE INTO task_dependencies (task_id, depends_on_task_id, sort_order) VALUES (?, ?, ?)');
    const insSub = db.prepare(
      'INSERT OR REPLACE INTO subtasks (id, task_id, title, done, assignee_id, due_date, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insAtt = db.prepare(
      'INSERT OR REPLACE INTO task_attachments (id, task_id, name, type, size, uploaded_by, uploaded_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const pendingDeps = [];
    incomingTasks.forEach((t, idx) => {
      if (!t || !t.id || !t.project) return;
      if (!editableProjIds.has(t.project)) return;
      if (!currentProjMembers.has(t.project)) return;

      const prevT = existingTasks.get(t.id);
      // Prevent hijacking a task from an out-of-scope project into an in-scope project
      if (prevT && !editableProjIds.has(prevT.project_id)) return;

      const projMemSet = currentProjMembers.get(t.project) || new Set();
      const validAssignee = t.assignee && (projMemSet.has(t.assignee) || scope.adminIds.has(t.assignee)) ? t.assignee : null;

      upsertTask.run(
        t.id,
        t.key || 'TSK',
        t.project,
        t.title,
        t.status || 'todo',
        t.prevStatus || null,
        validAssignee,
        t.priority || 'none',
        t.due || null,
        t.start || null,
        t.desc || '',
        t.estimate || null,
        prevT?.created_at || t.created || now,
        t.updated || now,
        t.completedAt || null,
        t.order ?? idx + 1,
        t.fav ? 1 : 0,
        t.recur || null,
        t.archived ? 1 : 0,
        t.archivedAt || null,
      );

      db.prepare('DELETE FROM task_labels WHERE task_id = ?').run(t.id);
      (t.labels || []).forEach((lid, li) => insLabel.run(t.id, lid, li));

      db.prepare('DELETE FROM subtasks WHERE task_id = ?').run(t.id);
      (t.subtasks || []).forEach((s, si) => {
        const validSubAssignee = s.assignee && (projMemSet.has(s.assignee) || scope.adminIds.has(s.assignee)) ? s.assignee : null;
        insSub.run(s.id, t.id, s.title, s.done ? 1 : 0, validSubAssignee, s.due || null, s.note || null, si);
      });

      db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(t.id);
      (t.attachments || []).forEach((a, ai) => {
        insAtt.run(a.id, t.id, a.name, a.type || 'file', a.size || '0 B', a.by || activeMe, a.at || now, ai);
      });

      pendingDeps.push({ taskId: t.id, projectId: t.project, deps: Array.isArray(t.deps) ? t.deps : [] });
    });

    // Validate task dependencies: only allow dependencies within the same project
    const taskProjLookup = new Map(
      db
        .prepare('SELECT id, project_id FROM tasks')
        .all()
        .map(r => [r.id, r.project_id]),
    );
    for (const item of pendingDeps) {
      db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(item.taskId);
      item.deps.forEach((did, di) => {
        if (did !== item.taskId && taskProjLookup.get(did) === item.projectId) {
          insDep.run(item.taskId, did, di);
        }
      });
    }

    // Comments: Scoped merge for tasks in commentable projects
    const existingComments = new Map(
      db
        .prepare('SELECT * FROM comments')
        .all()
        .map(c => [c.id, c]),
    );
    const incomingComments = Array.isArray(d.comments) ? d.comments : [];
    const incomingCommentIds = new Set(incomingComments.map(c => c.id));

    for (const [cid, oldC] of existingComments.entries()) {
      const tProj = taskProjLookup.get(oldC.task_id);
      if (!tProj || !commentableProjIds.has(tProj)) continue;
      if (!incomingCommentIds.has(cid)) {
        if (isAdminActor || oldC.author_id === activeMe || editableProjIds.has(tProj)) {
          db.prepare('DELETE FROM comments WHERE id = ?').run(cid);
          existingComments.delete(cid);
        }
      }
    }

    const upsertComment = db.prepare(
      `INSERT INTO comments (id, task_id, author_id, created_at, text, reactions_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text,
         reactions_json = excluded.reactions_json,
         sort_order = excluded.sort_order`,
    );
    incomingComments.forEach((c, i) => {
      if (!c || !c.id || !c.task) return;
      const tProj = taskProjLookup.get(c.task);
      if (!tProj || !commentableProjIds.has(tProj)) return;
      const prevC = existingComments.get(c.id);
      if (prevC && prevC.task_id !== c.task) return;
      const authorId = prevC ? prevC.author_id : isAdminActor ? c.by || activeMe : activeMe;
      const textVal = !prevC || isAdminActor || prevC.author_id === activeMe ? c.text || '' : prevC.text;
      upsertComment.run(c.id, c.task, authorId, prevC?.created_at || c.at || now, textVal, JSON.stringify(c.re || {}), i);
    });

    // Activity Log: Scoped append/update (never wipe other projects' activity)
    const existingAct = new Map(
      db
        .prepare('SELECT * FROM activity_log')
        .all()
        .map(a => [a.id, a]),
    );
    const incomingAct = Array.isArray(d.activity) ? d.activity : [];
    if (isAdminActor && opts.forceAdmin) {
      db.prepare('DELETE FROM activity_log').run();
      existingAct.clear();
    }
    const upsertAct = db.prepare(
      `INSERT OR IGNORE INTO activity_log (id, actor_id, verb, task_id, project_id, created_at, extra, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    incomingAct.forEach((a, i) => {
      if (!a || !a.id || existingAct.has(a.id)) return;
      const resolvedProj = a.project || (a.task ? taskProjLookup.get(a.task) : null) || null;
      if (!isAdminActor && (!resolvedProj || !commentableProjIds.has(resolvedProj))) return;
      const actorId = isAdminActor ? a.by || activeMe : activeMe;
      upsertAct.run(a.id, actorId, a.verb || '', a.task || null, resolvedProj, a.at || now, a.extra || '', i);
    });

    // Notifications: Scoped per recipient / project
    if (isAdminActor && opts.forceAdmin) {
      db.prepare('DELETE FROM notifications').run();
    }
    const existingNotifs = new Map(
      db
        .prepare('SELECT * FROM notifications')
        .all()
        .map(n => [n.id, n]),
    );
    const incomingNotifs = Array.isArray(d.notifs) ? d.notifs : [];
    const incomingNotifIds = new Set(incomingNotifs.map(n => n.id));

    // Allow user to delete or mark-read their own visible notifications
    for (const [nid, oldN] of existingNotifs.entries()) {
      const isRecipient = oldN.recipient_id === activeMe || (!oldN.recipient_id && isAdminActor);
      const inProjScope = oldN.project_id && (isAdminActor || scope.projectIds.has(oldN.project_id));
      if ((isRecipient || inProjScope) && !incomingNotifIds.has(nid)) {
        if (oldN.recipient_id === activeMe || isAdminActor) {
          db.prepare('DELETE FROM notifications WHERE id = ?').run(nid);
          existingNotifs.delete(nid);
        }
      }
    }

    const upsertNotif = db.prepare(
      `INSERT INTO notifications (id, type, actor_id, recipient_id, task_id, project_id, text, snippet, created_at, is_read, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         is_read = excluded.is_read,
         sort_order = excluded.sort_order`,
    );
    incomingNotifs.forEach((n, i) => {
      if (!n || !n.id) return;
      const prevN = existingNotifs.get(n.id);
      if (prevN) {
        const canTouch = isAdminActor || prevN.recipient_id === activeMe || (!prevN.recipient_id && prevN.project_id && scope.projectIds.has(prevN.project_id));
        if (!canTouch) return;
        upsertNotif.run(
          prevN.id,
          prevN.type,
          prevN.actor_id,
          prevN.recipient_id,
          prevN.task_id,
          prevN.project_id,
          prevN.text,
          prevN.snippet,
          prevN.created_at,
          n.read ? 1 : 0,
          i,
        );
      } else {
        const resolvedProj = n.project || (n.task ? taskProjLookup.get(n.task) : null) || null;
        if (!isAdminActor && (!resolvedProj || !commentableProjIds.has(resolvedProj))) return;
        const recipientId = n.to || n.recipient || null;
        upsertNotif.run(
          n.id,
          n.type || 'update',
          isAdminActor ? n.by || activeMe : activeMe,
          recipientId,
          n.task || null,
          resolvedProj,
          n.text || '',
          n.snippet || '',
          n.at || now,
          n.read ? 1 : 0,
          i,
        );
      }
    });

    // Files: Scoped merge per editable project
    const existingFiles = new Map(
      db
        .prepare('SELECT * FROM files')
        .all()
        .map(f => [f.id, f]),
    );
    const incomingFiles = Array.isArray(d.files) ? d.files : [];
    const incomingFileIds = new Set(incomingFiles.map(f => f.id));

    for (const [fid, oldF] of existingFiles.entries()) {
      const canDel = isAdminActor || (oldF.project_id && editableProjIds.has(oldF.project_id));
      if (canDel && !incomingFileIds.has(fid)) {
        db.prepare('DELETE FROM files WHERE id = ?').run(fid);
        existingFiles.delete(fid);
      }
    }

    const upsertFile = db.prepare(
      `INSERT INTO files (id, project_id, task_id, name, type, size, uploaded_by, uploaded_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         size = excluded.size,
         sort_order = excluded.sort_order`,
    );
    incomingFiles.forEach((f, i) => {
      if (!f || !f.id) return;
      const resolvedProj = f.project || (f.task ? taskProjLookup.get(f.task) : '') || '';
      if (!resolvedProj || !editableProjIds.has(resolvedProj)) return;
      const prevF = existingFiles.get(f.id);
      if (prevF && prevF.project_id !== resolvedProj) return;
      upsertFile.run(
        f.id,
        resolvedProj,
        f.task || null,
        f.name,
        f.type || 'file',
        f.size || '0 B',
        prevF?.uploaded_by || (isAdminActor ? f.by || activeMe : activeMe),
        prevF?.uploaded_at || f.at || now,
        i,
      );
    });

    // Calendar Events: Scoped merge per editable project
    const existingEvents = new Map(
      db
        .prepare('SELECT * FROM calendar_events')
        .all()
        .map(e => [e.id, e]),
    );
    const incomingEvents = Array.isArray(d.events) ? d.events : [];
    const incomingEventIds = new Set(incomingEvents.map(e => e.id));

    for (const [eid, oldE] of existingEvents.entries()) {
      const canDel = isAdminActor || (oldE.project_id && editableProjIds.has(oldE.project_id));
      if (canDel && !incomingEventIds.has(eid)) {
        db.prepare('DELETE FROM calendar_events WHERE id = ?').run(eid);
        existingEvents.delete(eid);
      }
    }

    const upsertEvent = db.prepare(
      `INSERT INTO calendar_events (id, title, date, time, project_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         date = excluded.date,
         time = excluded.time,
         sort_order = excluded.sort_order`,
    );
    incomingEvents.forEach((e, i) => {
      if (!e || !e.id) return;
      let resolvedProj = e.project || null;
      if (!isAdminActor && !resolvedProj && editableProjIds.size === 1) {
        resolvedProj = [...editableProjIds][0];
      }
      if (!isAdminActor && (!resolvedProj || !editableProjIds.has(resolvedProj))) return;
      const prevE = existingEvents.get(e.id);
      if (prevE && prevE.project_id !== resolvedProj && !isAdminActor) return;
      upsertEvent.run(e.id, e.title, e.date, e.time || '', resolvedProj, i);
    });

    // Saved Views: Scoped merge per editable project
    const existingSv = new Map(
      db
        .prepare('SELECT * FROM saved_views')
        .all()
        .map(sv => [sv.id, sv]),
    );
    const incomingSv = Array.isArray(d.savedViews) ? d.savedViews : [];
    const incomingSvIds = new Set(incomingSv.map(sv => sv.id));

    for (const [svid, oldSv] of existingSv.entries()) {
      const canDel = isAdminActor || (oldSv.project_id && editableProjIds.has(oldSv.project_id));
      if (canDel && !incomingSvIds.has(svid)) {
        db.prepare('DELETE FROM saved_views WHERE id = ?').run(svid);
        existingSv.delete(svid);
      }
    }

    const upsertSv = db.prepare(
      `INSERT INTO saved_views (id, project_id, name, type, filters_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         filters_json = excluded.filters_json,
         sort_order = excluded.sort_order`,
    );
    incomingSv.forEach((sv, i) => {
      if (!sv || !sv.id || !sv.project) return;
      if (!editableProjIds.has(sv.project)) return;
      const prevSv = existingSv.get(sv.id);
      if (prevSv && prevSv.project_id !== sv.project) return;
      upsertSv.run(sv.id, sv.project, sv.name, sv.type || 'list', JSON.stringify(sv.filters || []), i);
    });

    // Sessions: keep active token-authenticated sessions, sync non-token fallback sessions
    const hasTokenSessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash IS NOT NULL').get().n > 0;
    if (!hasTokenSessions) {
      db.prepare('DELETE FROM sessions WHERE token_hash IS NULL AND member_id = ?').run(activeMe);
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
    const scope = getScope(db, activeMe);
    const isAdminReader = scope.isAdmin;

    let prefsRows = db.prepare('SELECT key, value_json FROM user_preferences WHERE member_id = ?').all(activeMe);
    if (!prefsRows.length && activeMe !== 'm1') {
      prefsRows = db.prepare("SELECT key, value_json FROM user_preferences WHERE member_id = 'm1' AND key NOT LIKE '\\_%' ESCAPE '\\'").all();
    }
    const prefs = { ...DEFAULT_PREFS };
    let userNotifPrefs = null;
    let userRecentSearches = null;
    let userCollapsed = null;
    for (const r of prefsRows) {
      try {
        const parsed = JSON.parse(r.value_json);
        if (r.key === '_notifPrefs') userNotifPrefs = parsed;
        else if (r.key === '_recentSearches') userRecentSearches = parsed;
        else if (r.key === '_collapsed') userCollapsed = parsed;
        else prefs[r.key] = parsed;
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

    // Teams are hidden completely for non-admins
    const teams = isAdminReader
      ? db
          .prepare('SELECT * FROM teams ORDER BY sort_order ASC')
          .all()
          .map(t => ({
            id: t.id,
            name: t.name,
            icon: t.icon,
            c: t.color,
            desc: t.description,
          }))
      : [];

    const memberRows = db.prepare('SELECT * FROM members ORDER BY sort_order ASC').all();
    const meRow = memberRows.find(m => m.id === activeMe) || (isAdminReader ? memberRows[0] : null);
    if (meRow) {
      prefs.name = meRow.name;
      prefs.title = meRow.title;
    }

    const members = memberRows.map(m => redactMemberForScope(scope, m)).filter(Boolean);

    const projMembersRows = db.prepare('SELECT * FROM project_members ORDER BY sort_order ASC').all();
    const projMilestonesRows = db.prepare('SELECT * FROM project_milestones ORDER BY sort_order ASC').all();
    const projTeamHistRows = db.prepare('SELECT * FROM project_team_history ORDER BY changed_at DESC, sort_order ASC').all();

    const projRows = db.prepare('SELECT * FROM projects ORDER BY proj_order ASC').all();
    const projects = projRows
      .filter(p => canReadProject(scope, p.id))
      .map(p => {
        const pMems = projMembersRows.filter(pm => pm.project_id === p.id);
        const perms = {};
        pMems.forEach(pm => {
          if (pm.permission) perms[pm.member_id] = toUiPermission(pm.permission);
        });
        const memberIds = pMems.map(pm => pm.member_id);
        if (p.lead_id && !memberIds.includes(p.lead_id)) {
          memberIds.unshift(p.lead_id);
        }
        const milestones = projMilestonesRows.filter(ms => ms.project_id === p.id).map(ms => ({ name: ms.name, date: ms.date }));
        const teamHistory = isAdminReader
          ? projTeamHistRows
              .filter(th => th.project_id === p.id)
              .map(th => ({
                id: th.id,
                fromTeam: th.from_team_id,
                fromName: th.from_team_name,
                toTeam: th.to_team_id,
                toName: th.to_team_name,
                by: th.changed_by,
                at: th.changed_at,
              }))
          : [];
        return {
          id: p.id,
          key: p.key,
          name: p.name,
          icon: p.icon,
          color: p.color,
          status: p.status,
          team: isAdminReader ? p.team_id : '',
          lead: p.lead_id,
          due: p.due_date,
          start: p.start_date,
          fav: Boolean(p.fav),
          ...(p.is_private ? { private: true } : {}),
          ...(p.access ? { access: p.access } : {}),
          ...(Object.keys(perms).length ? { perms } : {}),
          members: memberIds,
          desc: p.description,
          milestones,
          teamHistory,
          last: p.last_activity,
          seq: p.seq,
          ...(p.archived ? { archived: true, archivedAt: p.archived_at } : {}),
        };
      });

    const accessibleProjIds = new Set(projects.map(p => p.id));

    const labelRows = db.prepare('SELECT * FROM task_labels ORDER BY sort_order ASC').all();
    const depRows = db.prepare('SELECT * FROM task_dependencies ORDER BY sort_order ASC').all();
    const subRows = db.prepare('SELECT * FROM subtasks ORDER BY sort_order ASC').all();
    const attRows = db.prepare('SELECT * FROM task_attachments ORDER BY sort_order ASC').all();

    // Strict project-scoped filter: drop NULL project_id pass-through for non-admins
    const taskRows = db
      .prepare('SELECT * FROM tasks ORDER BY sort_order ASC')
      .all()
      .filter(t => (isAdminReader && !t.project_id) || (t.project_id && accessibleProjIds.has(t.project_id)));
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
      deps: depRows.filter(d => d.task_id === t.id && accessibleTaskIds.has(d.depends_on_task_id)).map(d => d.depends_on_task_id),
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
      .filter(a => (isAdminReader && !a.project_id) || (a.project_id && accessibleProjIds.has(a.project_id)))
      .map(a => ({
        id: a.id,
        by: a.actor_id,
        verb: a.verb,
        task: a.task_id,
        project: a.project_id,
        at: a.created_at,
        extra: a.extra,
      }));

    // Notifications: recipient-scoped or in-scope project notifications (admin-only for null-project system notifications)
    const notifs = db
      .prepare('SELECT * FROM notifications ORDER BY sort_order ASC')
      .all()
      .filter(n => {
        if (n.recipient_id) {
          return n.recipient_id === activeMe;
        }
        if (n.project_id) {
          return accessibleProjIds.has(n.project_id);
        }
        return isAdminReader;
      })
      .map(n => ({
        id: n.id,
        type: n.type,
        by: n.actor_id,
        ...(n.recipient_id ? { to: n.recipient_id } : {}),
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
      .filter(f => (isAdminReader && !f.project_id) || (f.project_id && accessibleProjIds.has(f.project_id)))
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
      .filter(e => (isAdminReader && !e.project_id) || (e.project_id && accessibleProjIds.has(e.project_id)))
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
      .filter(sv => (isAdminReader && !sv.project_id) || (sv.project_id && accessibleProjIds.has(sv.project_id)))
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
    const resolvedRecentSearches = Array.isArray(userRecentSearches) ? userRecentSearches : isAdminReader ? JSON.parse(wsRow.recent_searches_json || '[]') : [];
    const resolvedNotifPrefs =
      userNotifPrefs && typeof userNotifPrefs === 'object' ? userNotifPrefs : isAdminReader ? JSON.parse(wsRow.notif_prefs_json || '{}') : seed().notifPrefs;
    const resolvedCollapsed = typeof userCollapsed === 'boolean' ? userCollapsed : Boolean(wsRow.collapsed);

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
        recentSearches: resolvedRecentSearches,
        sessions,
        tfa: tfaEnabled,
        notifPrefs: resolvedNotifPrefs,
      },
      prefs,
      views,
      collapsed: resolvedCollapsed,
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
  writeFullStateTx(db, initial, 'reset_workspace', actorMemberId || s.me, { forceAdmin: true });
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
      // Invited member claiming their account — starts as deactivated until admin confirms
      memberId = existingByEmail.id;
      db.prepare('UPDATE members SET name = ?, password_hash = ?, status = ?, last_active = NULL WHERE id = ?').run(cleanName, pwHash, 'deactivated', memberId);
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(memberId, 'name', JSON.stringify(cleanName));
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(
        memberId,
        'title',
        JSON.stringify(existingByEmail.title || 'Member'),
      );
    } else {
      // New workspace member registration — starts as deactivated until admin confirms
      memberId = 'm_' + crypto.randomBytes(4).toString('hex');
      const count = db.prepare('SELECT COUNT(*) AS n FROM members').get().n;
      db.prepare(
        'INSERT INTO members (id, name, email, role, team_id, title, color, status, last_active, timezone, password_hash, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
      ).run(memberId, cleanName, cleanEmail, 'Member', '', 'Member', '#3B82C4', 'deactivated', 'UTC', pwHash, count);
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(memberId, 'name', JSON.stringify(cleanName));
      db.prepare('INSERT OR REPLACE INTO user_preferences (member_id, key, value_json) VALUES (?, ?, ?)').run(memberId, 'title', JSON.stringify('Member'));
    }

    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'auth_signup',
      now,
      JSON.stringify({ memberId, email: cleanEmail, isFirstOwner, status: member.status }),
    );

    if (!isFirstOwner) {
      const adminRows = db.prepare("SELECT id FROM members WHERE role IN ('Owner', 'Admin') AND status = 'active'").all();
      const insSignupNotif = db.prepare(
        'INSERT INTO notifications (id, type, actor_id, recipient_id, task_id, project_id, text, snippet, created_at, is_read, sort_order) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 0, 0)',
      );
      if (adminRows.length > 0) {
        for (const adm of adminRows) {
          insSignupNotif.run(
            'n_' + crypto.randomBytes(4).toString('hex'),
            'update',
            memberId,
            adm.id,
            'registered and is waiting for admin confirmation',
            cleanEmail,
            now,
          );
        }
      } else {
        insSignupNotif.run(
          'n_' + crypto.randomBytes(4).toString('hex'),
          'update',
          memberId,
          null,
          'registered and is waiting for admin confirmation',
          cleanEmail,
          now,
        );
      }

      return {
        ok: true,
        status: 201,
        isFirstOwner: false,
        pendingApproval: true,
        member: sanitizeMember(member),
      };
    }

    const sess = createSessionRow(db, memberId, { remember, device, location });

    return {
      ok: true,
      status: 201,
      isFirstOwner: true,
      pendingApproval: false,
      token: sess.token,
      ttlSec: sess.ttlSec,
      sessionId: sess.sessionId,
      member: sanitizeMember(member),
    };
  });

  const res = tx();
  if (!res.ok || res.pendingApproval) return res;
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
    return {
      ok: false,
      status: 403,
      field: 'login',
      error: 'Your account is deactive and waiting for an administrator to confirm your registration.',
    };
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

/* =====================================================================
   PHASE 3: ADMIN PROJECT MEMBERSHIP & ISOLATION REPORT ENDPOINTS
   ===================================================================== */

export function getAdminProjectMembers(actorMemberId, projectId) {
  const db = getDb();
  const scope = getScope(db, actorMemberId);
  if (!canManageMembership(scope)) {
    return { ok: false, status: 403, error: 'Only workspace owners and admins can manage project members' };
  }
  const projRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!projRow) {
    return { ok: false, status: 404, error: 'Project not found' };
  }
  const rows = db
    .prepare(
      `SELECT pm.member_id, pm.permission, pm.sort_order, m.name, m.email, m.role, m.status, m.color, m.title
       FROM project_members pm
       LEFT JOIN members m ON m.id = pm.member_id
       WHERE pm.project_id = ?
       ORDER BY pm.sort_order ASC`,
    )
    .all(projectId);

  const members = rows.map(r => ({
    id: r.member_id,
    name: r.name || 'Unknown',
    email: r.email || '',
    role: r.role || 'Member',
    status: r.status || 'active',
    c: r.color || '#5A67D8',
    title: r.title || '',
    permission: normalizeProjectPermission(r.permission, projRow.lead_id === r.member_id),
    uiPermission: toUiPermission(normalizeProjectPermission(r.permission, projRow.lead_id === r.member_id)),
    isLead: projRow.lead_id === r.member_id,
  }));

  return { ok: true, status: 200, projectId, leadId: projRow.lead_id, members };
}

export function updateAdminProjectMembers(actorMemberId, projectId, { members = null, add = null, remove = null, leadId = undefined, unassignRemoved = true } = {}) {
  const db = getDb();
  const scope = getScope(db, actorMemberId);
  if (!canManageMembership(scope)) {
    return { ok: false, status: 403, error: 'Only workspace owners and admins can manage project members' };
  }
  const projRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!projRow) {
    return { ok: false, status: 404, error: 'Project not found' };
  }

  const tx = db.transaction(() => {
    const now = Date.now();
    const existingRows = db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY sort_order ASC').all(projectId);
    const currentMap = new Map(existingRows.map(r => [r.member_id, r.permission]));
    if (projRow.lead_id && !currentMap.has(projRow.lead_id)) {
      currentMap.set(projRow.lead_id, 'lead');
    }

    const nextLeadId = leadId !== undefined ? leadId || null : projRow.lead_id;
    const nextMap = new Map();

    if (Array.isArray(members)) {
      for (const item of members) {
        const mid = typeof item === 'string' ? item : item?.memberId || item?.id;
        if (!mid) continue;
        const rawPerm = typeof item === 'object' ? item.permission || item.perm : currentMap.get(mid);
        nextMap.set(mid, normalizeProjectPermission(rawPerm, mid === nextLeadId));
      }
    } else {
      for (const [mid, perm] of currentMap.entries()) {
        nextMap.set(mid, normalizeProjectPermission(perm, mid === nextLeadId));
      }
      if (Array.isArray(add)) {
        for (const item of add) {
          const mid = typeof item === 'string' ? item : item?.memberId || item?.id;
          if (!mid) continue;
          const rawPerm = typeof item === 'object' ? item.permission || item.perm : 'editor';
          nextMap.set(mid, normalizeProjectPermission(rawPerm, mid === nextLeadId));
        }
      }
      if (Array.isArray(remove)) {
        for (const mid of remove) {
          if (mid && mid !== nextLeadId) nextMap.delete(mid);
        }
      }
    }

    if (nextLeadId) {
      nextMap.set(nextLeadId, 'lead');
    }

    if (nextLeadId !== projRow.lead_id) {
      db.prepare('UPDATE projects SET lead_id = ?, last_activity = 0 WHERE id = ?').run(nextLeadId, projectId);
    }

    const removedIds = [...currentMap.keys()].filter(mid => !nextMap.has(mid));
    const addedIds = [...nextMap.keys()].filter(mid => !currentMap.has(mid));

    db.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    const ins = db.prepare('INSERT INTO project_members (project_id, member_id, permission, sort_order) VALUES (?, ?, ?, ?)');
    let idx = 0;
    for (const [mid, perm] of nextMap.entries()) {
      ins.run(projectId, mid, perm, idx++);
    }

    // Unassign open tasks/subtasks for removed members in this project
    let unassignedTasks = 0;
    if (unassignRemoved && removedIds.length > 0) {
      for (const rmid of removedIds) {
        const resT = db
          .prepare("UPDATE tasks SET assignee_id = NULL, updated_at = ? WHERE project_id = ? AND assignee_id = ? AND status != 'done'")
          .run(now, projectId, rmid);
        unassignedTasks += resT.changes;
        db.prepare(
          `UPDATE subtasks SET assignee_id = NULL
           WHERE assignee_id = ? AND done = 0 AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        ).run(rmid, projectId);
      }
    }

    db.prepare('INSERT INTO activity_log (id, actor_id, verb, task_id, project_id, created_at, extra, sort_order) VALUES (?, ?, ?, NULL, ?, ?, ?, 0)').run(
      'a_' + crypto.randomBytes(4).toString('hex'),
      actorMemberId,
      'updated project membership',
      projectId,
      now,
      `+${addedIds.length} / -${removedIds.length}`,
    );

    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'admin_project_members',
      now,
      JSON.stringify({ actor: actorMemberId, projectId, added: addedIds, removed: removedIds, unassignedTasks }),
    );

    return { addedIds, removedIds, unassignedTasks };
  });

  const summary = tx();
  return {
    ...getAdminProjectMembers(actorMemberId, projectId),
    ...summary,
  };
}

export function getAdminMemberProjects(actorMemberId, targetMemberId) {
  const db = getDb();
  const scope = getScope(db, actorMemberId);
  if (!canManageMembership(scope)) {
    return { ok: false, status: 403, error: 'Only workspace owners and admins can view member project assignments' };
  }
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(targetMemberId);
  if (!member) {
    return { ok: false, status: 404, error: 'Member not found' };
  }
  const rows = db
    .prepare(
      `SELECT p.id, p.key, p.name, p.status, p.lead_id, pm.permission
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.member_id = ?
       ORDER BY p.proj_order ASC`,
    )
    .all(targetMemberId);

  return {
    ok: true,
    status: 200,
    memberId: targetMemberId,
    projects: rows.map(r => ({
      id: r.id,
      key: r.key,
      name: r.name,
      status: r.status,
      isLead: r.lead_id === targetMemberId,
      permission: normalizeProjectPermission(r.permission, r.lead_id === targetMemberId),
      uiPermission: toUiPermission(normalizeProjectPermission(r.permission, r.lead_id === targetMemberId)),
    })),
  };
}

export function updateAdminMemberProjects(actorMemberId, targetMemberId, { projects = [], activate = false } = {}) {
  const db = getDb();
  const scope = getScope(db, actorMemberId);
  if (!canManageMembership(scope)) {
    return { ok: false, status: 403, error: 'Only workspace owners and admins can manage member project assignments' };
  }
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(targetMemberId);
  if (!member) {
    return { ok: false, status: 404, error: 'Member not found' };
  }

  const tx = db.transaction(() => {
    const now = Date.now();
    const allProjs = db.prepare('SELECT id, lead_id FROM projects').all();
    const desiredMap = new Map();
    for (const item of projects) {
      const pid = typeof item === 'string' ? item : item?.projectId || item?.id;
      if (!pid) continue;
      const rawPerm = typeof item === 'object' ? item.permission || item.perm : 'editor';
      desiredMap.set(pid, rawPerm);
    }

    for (const p of allProjs) {
      const existing = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND member_id = ?').get(p.id, targetMemberId);
      if (desiredMap.has(p.id)) {
        const isLead = p.lead_id === targetMemberId;
        const normPerm = normalizeProjectPermission(desiredMap.get(p.id), isLead);
        if (existing) {
          db.prepare('UPDATE project_members SET permission = ? WHERE project_id = ? AND member_id = ?').run(normPerm, p.id, targetMemberId);
        } else {
          const cnt = db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').get(p.id).n;
          db.prepare('INSERT INTO project_members (project_id, member_id, permission, sort_order) VALUES (?, ?, ?, ?)').run(
            p.id,
            targetMemberId,
            normPerm,
            cnt,
          );
        }
      } else if (existing && p.lead_id !== targetMemberId) {
        db.prepare('DELETE FROM project_members WHERE project_id = ? AND member_id = ?').run(p.id, targetMemberId);
        db.prepare("UPDATE tasks SET assignee_id = NULL, updated_at = ? WHERE project_id = ? AND assignee_id = ? AND status != 'done'").run(
          now,
          p.id,
          targetMemberId,
        );
      }
    }

    if (activate && member.status !== 'active') {
      db.prepare("UPDATE members SET status = 'active' WHERE id = ?").run(targetMemberId);
    }

    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      'admin_member_projects',
      now,
      JSON.stringify({ actor: actorMemberId, memberId: targetMemberId, projects: [...desiredMap.keys()], activate }),
    );
  });

  tx();
  return getAdminMemberProjects(actorMemberId, targetMemberId);
}

export function getAdminIsolationReport(actorMemberId) {
  const db = getDb();
  const scope = getScope(db, actorMemberId);
  if (!canManageMembership(scope)) {
    return { ok: false, status: 403, error: 'Only workspace owners and admins can view the isolation report' };
  }
  const allProjects = db.prepare('SELECT id, key, name, is_private FROM projects ORDER BY proj_order ASC').all();
  const allMembers = db.prepare('SELECT id, name, email, role, status FROM members ORDER BY sort_order ASC').all();
  const pmRows = db.prepare('SELECT project_id, member_id, permission FROM project_members').all();

  const report = allMembers.map(m => {
    const isAdmin = m.role === 'Owner' || m.role === 'Admin';
    const assignedSet = new Set(pmRows.filter(pm => pm.member_id === m.id).map(pm => pm.project_id));
    const accessibleProjects = isAdmin ? allProjects.map(p => p.id) : allProjects.filter(p => assignedSet.has(p.id)).map(p => p.id);
    const isolatedFromProjects = isAdmin ? [] : allProjects.filter(p => !assignedSet.has(p.id)).map(p => ({ id: p.id, key: p.key, name: p.name }));
    return {
      memberId: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      accessibleProjectIds: accessibleProjects,
      isolatedFromProjects,
    };
  });

  return { ok: true, status: 200, report };
}
