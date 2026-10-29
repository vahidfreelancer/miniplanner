/* ---------- store ---------- */
import { TODAY, diffD, iso, parse, uid } from './utils.js';
import { PCOLORS, TEAMS_SEED } from './constants.js';
import { seed } from '../data/seed.js';

export const STORE_KEY = 'gr8r.v2';
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
export async function load() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore storage restrictions */
  }
  try {
    const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const j = await res.json();
      if (j && j.data && Array.isArray(j.data.tasks)) return j;
    }
  } catch {
    /* server unreachable: fall back to clean initial state */
  }
  return null;
}
export const saved = null;
export const S = {
  data: seed(),
  prefs: Object.assign({}, DEFAULT_PREFS),
  views: {},
  ui: {
    fx: {},
    auth: null,
    authStep: 'login',
    onb: 0,
    onbData: { use: 'product', team: 'kanban', size: '2-10', ws: '', proj: '', tmpl: 'blank', invites: '' },
    route: 'home',
    params: {},
    history: [],
    collapsed: false,
    mnav: false,
    expanded: {},
    drawer: null,
    drawerFull: false,
    drawerTab: 'comments',
    modals: [],
    pop: null,
    palette: null,
    loading: false,
    offline: false,
    sel: new Set(),
    composer: null,
    editCell: null,
    openTasks: {},
    collapsedGroups: {},
    calDate: iso(TODAY),
    calMode: 'month',
    tlZoom: 'week',
    tlGroup: 'status',
    fileView: 'grid',
    projView: 'grid',
    homeTab: 'upcoming',
    inboxCat: 'all',
    inboxUnread: false,
    inboxSel: null,
    notifFilter: 'all',
    settings: 'appearance',
    searchQ: '',
    searchCat: 'all',
    myView: 'list',
    membersTab: 'members',
    collapsedCols: {},
    errors: {},
    drafts: {},
  },
};
export async function hydrate() {
  const j = await load();
  if (j) {
    S.data = j.data || seed();
    S.prefs = Object.assign({}, DEFAULT_PREFS, j.prefs || {});
    S.views = j.views || {};
    S.ui.collapsed = !!j.collapsed;
  }
}
export let _saveT;
export function save(action = 'save_state') {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        data: S.data,
        prefs: S.prefs,
        views: S.views,
        collapsed: S.ui.collapsed,
      }),
    }).catch(() => {
      /* keep working in memory if request fails */
    });
  }, 150);
}

/* ---------- lookups ---------- */
export const D = () => S.data;
export const me = () =>
  D().members.find(m => m.id === D().me) ||
  D().members[0] || {
    id: 'm1',
    name: S.prefs?.name || 'Workspace Owner',
    email: 'owner@workspace.local',
    role: 'Owner',
    team: '',
    title: S.prefs?.title || 'Owner',
    c: '#5A67D8',
    status: 'active',
    last: 0,
    tz: 'UTC',
  };
export const mem = id => D().members.find(m => m.id === id);
export const proj = id => D().projects.find(p => p.id === id);
export const task = id => D().tasks.find(t => t.id === id);
export const pColor = p => PCOLORS[p?.color] || PCOLORS.slate;
export const visibleProjects = () =>
  D()
    .projOrder.map(proj)
    .filter(Boolean)
    .filter(p => !p.archived);
export const canSee = p => Boolean(p && (!p.private || p.members.includes(D().me)));
export const tasksOf = pid => D().tasks.filter(t => t.project === pid && !t.archived);
export const allTasks = () => D().tasks.filter(t => !t.archived && canSee(proj(t.project)));
export const isOver = t => t.due && t.status !== 'done' && diffD(parse(t.due), TODAY) < 0;
export const commentsOf = tid => D().comments.filter(c => c.task === tid);
export function progressOf(pid) {
  const ts = tasksOf(pid);
  if (!ts.length) return 0;
  return Math.round((ts.filter(t => t.status === 'done').length / ts.length) * 100);
}
export function taskProg(t) {
  if (t.status === 'done') return 100;
  if (t.subtasks.length) return Math.round((t.subtasks.filter(s => s.done).length / t.subtasks.length) * 100);
  return { backlog: 0, todo: 5, progress: 45, review: 80 }[t.status] || 0;
}

/* ---------- activity + notification helpers ---------- */
export function logAct(verb, t, extra = '') {
  D().activity.unshift({ id: uid('a'), by: D().me, verb, task: t?.id || null, project: t?.project || null, at: Date.now(), extra });
  if (t) t.updated = Date.now();
}

/* ---------- teams (workspace data, seeded on first use) ---------- */
export const NO_TEAM = { id: '', name: 'No team', icon: 'users', c: '#8A867E', desc: '' };
export function teamsList() {
  const d = D();
  if (!d.teams) d.teams = TEAMS_SEED.map(t => ({ ...t }));
  return d.teams;
}
export function team(id) {
  return teamsList().find(t => t.id === id) || null;
}
export const TM = new Proxy({}, { get: (_, k) => team(k) || NO_TEAM });
