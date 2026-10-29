/* ---------- clean initial workspace state (no sample/demo data) ---------- */
export function seed() {
  const members = [
    {
      id: 'm1',
      name: 'Workspace Owner',
      email: 'owner@workspace.local',
      role: 'Owner',
      team: '',
      title: 'Owner',
      c: '#5A67D8',
      status: 'active',
      last: 0,
      tz: 'UTC',
    },
  ];
  return {
    ws: { name: 'My Workspace', url: 'my-workspace', c: '#1D1C1A', brand: true },
    workspaces: [{ id: 'w1', name: 'My Workspace', c: '#1D1C1A', brand: true }],
    me: 'm1',
    teams: [],
    members,
    projects: [],
    tasks: [],
    comments: [],
    activity: [],
    notifs: [],
    files: [],
    events: [],
    projOrder: [],
    savedViews: [],
    recentSearches: [],
    sessions: [{ id: 'se1', dev: 'Current Browser', loc: 'Local', at: 'Active now', cur: true }],
    tfa: false,
    notifPrefs: {
      email_mention: true,
      email_assign: true,
      email_digest: true,
      email_comment: false,
      push_mention: true,
      push_assign: true,
      push_comment: true,
      push_due: true,
      mention_all: true,
      assign_self: true,
    },
  };
}
