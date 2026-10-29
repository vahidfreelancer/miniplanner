import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { seed } from '../src/data/seed.js';

const DATA_DIR = path.resolve('data');
export const DB_PATH = path.join(DATA_DIR, 'gr8r-studio.sqlite');

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
  _db = db;
  ensureInitialized(db);
  return db;
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
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
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
      view_key TEXT PRIMARY KEY,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      location TEXT NOT NULL,
      active_text TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
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
    );
  }
}

function writeFullStateTx(db, payload, actionName = 'save_state') {
  const tx = db.transaction(() => {
    const d = payload?.data || seed();
    const prefs = Object.assign({}, DEFAULT_PREFS, payload?.prefs || {});
    const views = payload?.views || {};
    const collapsed = payload?.collapsed ? 1 : 0;
    const now = Date.now();

    const ws = d.ws || { name: 'My Workspace', url: 'my-workspace', c: '#1D1C1A', brand: true };

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
      d.me || 'm1',
      d.tfa ? 1 : 0,
      collapsed,
      JSON.stringify(d.notifPrefs || {}),
      JSON.stringify(d.recentSearches || []),
      now,
    );

    // Preferences
    db.prepare('DELETE FROM user_preferences').run();
    const insPref = db.prepare('INSERT INTO user_preferences (key, value_json) VALUES (?, ?)');
    for (const [k, v] of Object.entries(prefs)) {
      insPref.run(k, JSON.stringify(v));
    }

    // UI Views
    db.prepare('DELETE FROM ui_views').run();
    const insUiView = db.prepare('INSERT INTO ui_views (view_key, config_json) VALUES (?, ?)');
    for (const [k, v] of Object.entries(views)) {
      insUiView.run(k, JSON.stringify(v));
    }

    // Workspaces
    db.prepare('DELETE FROM workspaces').run();
    const insWs = db.prepare('INSERT INTO workspaces (id, name, color, brand, sort_order) VALUES (?, ?, ?, ?, ?)');
    (d.workspaces || []).forEach((w, i) => {
      insWs.run(w.id, w.name, w.c || '#1D1C1A', w.brand ? 1 : 0, i);
    });

    // Teams
    db.prepare('DELETE FROM teams').run();
    const insTeam = db.prepare('INSERT INTO teams (id, name, icon, color, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    (d.teams || []).forEach((t, i) => {
      insTeam.run(t.id, t.name, t.icon || 'users', t.c || '#8A867E', t.desc || '', i);
    });

    // Members
    db.prepare('DELETE FROM members').run();
    const insMember = db.prepare(
      'INSERT INTO members (id, name, email, role, team_id, title, color, status, last_active, timezone, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    (d.members || []).forEach((m, i) => {
      insMember.run(
        m.id,
        m.name,
        m.email,
        m.role || 'Member',
        m.team || '',
        m.title || '',
        m.c || '#5A67D8',
        m.status || 'active',
        m.last ?? null,
        m.tz || 'UTC',
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

    // Sessions
    db.prepare('DELETE FROM sessions').run();
    const insSession = db.prepare('INSERT INTO sessions (id, device, location, active_text, is_current, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    (d.sessions || []).forEach((s, i) => {
      insSession.run(s.id, s.dev || 'Browser', s.loc || 'Local', s.at || 'Active now', s.cur ? 1 : 0, i);
    });

    // Audit transaction entry
    db.prepare('INSERT INTO transactions_log (action, created_at, summary) VALUES (?, ?, ?)').run(
      actionName,
      now,
      JSON.stringify({
        projects: (d.projects || []).length,
        tasks: (d.tasks || []).length,
        members: (d.members || []).length,
        teams: (d.teams || []).length,
      }),
    );
  });

  tx();
}

export function loadState() {
  const db = getDb();
  const readTx = db.transaction(() => {
    const wsRow = db.prepare('SELECT * FROM workspace_settings WHERE id = 1').get();
    const prefsRows = db.prepare('SELECT key, value_json FROM user_preferences').all();
    const prefs = { ...DEFAULT_PREFS };
    for (const r of prefsRows) {
      try {
        prefs[r.key] = JSON.parse(r.value_json);
      } catch {
        /* ignore invalid json */
      }
    }

    const uiViewsRows = db.prepare('SELECT view_key, config_json FROM ui_views').all();
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

    const members = db
      .prepare('SELECT * FROM members ORDER BY sort_order ASC')
      .all()
      .map(m => ({
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

    const projMembersRows = db.prepare('SELECT * FROM project_members ORDER BY sort_order ASC').all();
    const projMilestonesRows = db.prepare('SELECT * FROM project_milestones ORDER BY sort_order ASC').all();

    const projRows = db.prepare('SELECT * FROM projects ORDER BY proj_order ASC').all();
    const projects = projRows.map(p => {
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

    const labelRows = db.prepare('SELECT * FROM task_labels ORDER BY sort_order ASC').all();
    const depRows = db.prepare('SELECT * FROM task_dependencies ORDER BY sort_order ASC').all();
    const subRows = db.prepare('SELECT * FROM subtasks ORDER BY sort_order ASC').all();
    const attRows = db.prepare('SELECT * FROM task_attachments ORDER BY sort_order ASC').all();

    const taskRows = db.prepare('SELECT * FROM tasks ORDER BY sort_order ASC').all();
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
      .map(sv => ({
        id: sv.id,
        project: sv.project_id,
        name: sv.name,
        type: sv.type,
        filters: JSON.parse(sv.filters_json || '[]'),
      }));

    const sessions = db
      .prepare('SELECT * FROM sessions ORDER BY sort_order ASC')
      .all()
      .map(s => ({
        id: s.id,
        dev: s.device,
        loc: s.location,
        at: s.active_text,
        ...(s.is_current ? { cur: true } : {}),
      }));

    return {
      data: {
        ws: {
          name: wsRow.name,
          url: wsRow.url,
          c: wsRow.color,
          brand: Boolean(wsRow.brand),
        },
        workspaces,
        me: wsRow.me_id,
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
        tfa: Boolean(wsRow.tfa),
        notifPrefs: JSON.parse(wsRow.notif_prefs_json || '{}'),
      },
      prefs,
      views,
      collapsed: Boolean(wsRow.collapsed),
    };
  });

  return readTx();
}

export function saveState(payload, actionName = 'save_state') {
  const db = getDb();
  writeFullStateTx(db, payload, actionName);
  return { ok: true };
}

export function resetState() {
  const db = getDb();
  const initial = {
    data: seed(),
    prefs: DEFAULT_PREFS,
    views: {},
    collapsed: false,
  };
  writeFullStateTx(db, initial, 'reset_workspace');
  return loadState();
}

export function getTransactions(limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM transactions_log ORDER BY id DESC LIMIT ?').all(limit);
}
