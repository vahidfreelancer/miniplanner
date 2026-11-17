/* ---------- MEMBERS / PROFILE / TEAMS ---------- */
import { ago, esc, minsAgo } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { ROLES } from '../core/constants.js';
import { D, S, TM, allTasks, canInvite, canSee, isAdmin, isOver, mem, progressOf, team, teamsList, visibleMembers, visibleProjects } from '../core/store.js';
import { av, avStack, empty, pIcon, pStatus, progBar } from '../ui/helpers.js';
import { sortTasks } from '../shell/view-engine.js';
import { actHtml, miniRow } from '../components/task-list.js';
import { page404 } from './errors.js';
import { PERMS } from '../overlays/modals.js';

export function pageMembers() {
  const u = S.ui;
  const q = (u.memQ || '').toLowerCase();
  const role = u.memRole || 'all';
  const admin = isAdmin();
  const pool = admin ? D().members : visibleMembers();
  const ms = pool.filter(m => (role === 'all' || m.role === role) && (!q || m.name.toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q)));
  const pendingCount = pool.filter(m => m.status === 'invited' || m.status === 'deactivated').length;
  const tab = !admin && u.membersTab === 'teams' ? 'members' : u.membersTab;
  const tabList = [['members', 'Members'], ...(admin ? [['teams', 'Teams']] : []), ['roles', 'Roles & permissions']];
  return `<div class="page wide" style="max-width:1200px">
    <div class="ph"><div><h1>Members</h1><p>${pool.length} ${admin ? `people in ${esc(D().ws.name)} · ${pendingCount} pending / deactive` : 'people in your projects'}</p></div><div class="acts">${canInvite() ? `<button class="btn btn-primary" data-a="invite">${ic('user-plus', 14)}Invite member</button>` : ''}</div></div>
    <div class="tabs" style="margin-bottom:14px">${tabList
      .map(([k, n]) => `<button class="tab ${tab === k ? 'on' : ''}" data-a="set" data-k="membersTab" data-v="${k}">${n}</button>`)
      .join('')}</div>
    ${
      tab === 'teams' && admin
        ? `<div class="row" style="margin-bottom:12px"><span class="muted" style="font-size:13px">${teamsList().length} teams</span><span class="sp"></span><button class="btn btn-secondary btn-sm" data-a="newTeam">${ic('plus', 13)}New team</button></div>${teamsGrid()}`
        : tab === 'roles'
          ? permsTable()
          : `
    <div class="row" style="margin-bottom:12px;gap:8px;flex-wrap:wrap"><div class="inwrap">${ic('search', 13)}<input class="input search-sm" id="mem-q" data-in="memQ" placeholder="Search by name${admin ? ' or email' : ''}" value="${esc(u.memQ || '')}" aria-label="Search members"></div>
      <div class="seg">${['all', ...ROLES].map(r => `<button class="${role === r ? 'on' : ''}" data-a="set" data-k="memRole" data-v="${r}">${r === 'all' ? 'All' : r}</button>`).join('')}</div></div>
    <div class="panel" style="overflow-x:auto">${
      ms.length
        ? `<table class="perm-t" style="min-width:880px"><thead><tr><th style="padding-left:14px">Member</th><th style="text-align:left">Role</th>${admin ? '<th style="text-align:left">Team</th>' : ''}<th>Active projects</th><th>Tasks</th><th style="text-align:left">Last active</th><th style="text-align:left">Status</th><th></th></tr></thead><tbody>
    ${ms
      .map(m => {
        const ap = visibleProjects().filter(p => p.members.includes(m.id) && p.status !== 'complete').length;
        const ot = allTasks().filter(t => t.assignee === m.id && t.status !== 'done').length;
        return `<tr data-ctx="member" data-id="${m.id}"><td style="padding-left:14px"><button class="row" data-a="go" data-r="member" data-id="${m.id}" style="gap:10px;text-align:left">${av(m.id, 'md', false)}<span class="col"><b style="font-weight:500">${esc(m.name)}${m.id === D().me ? ' <span class="faint" style="font-weight:400">(you)</span>' : ''}</b>${m.email ? `<span class="faint" style="font-size:12px">${esc(m.email)}</span>` : `<span class="faint" style="font-size:12px">${esc(m.title || m.role)}</span>`}</span></button></td>
      <td style="text-align:left">${admin && m.role !== 'Owner' ? `<button class="pillbtn bordered" data-a="pop" data-pop="role" data-id="${m.id}">${m.role}${ic('chevron-down', 12)}</button>` : `<span class="pillbtn">${m.role === 'Owner' ? ic('crown', 13) : ''}${m.role}</span>`}</td>
      ${admin ? `<td style="text-align:left"><span class="row">${ic(TM[m.team].icon, 13)}${TM[m.team].name}</span></td>` : ''}<td class="num">${ap}</td><td class="num">${ot}</td>
      <td style="text-align:left" class="muted">${m.last == null ? '—' : m.last < 5 ? '<span style="color:var(--green)">Online</span>' : ago(minsAgo(m.last))}</td>
      <td style="text-align:left"><div class="row" style="gap:6px">${m.status === 'invited' ? '<span class="badge amber"><span class="dot"></span>Invited</span>' : m.status === 'deactivated' ? '<span class="badge gray">Deactive</span>' : '<span class="badge green"><span class="dot"></span>Active</span>'}${admin && m.status === 'deactivated' && m.role !== 'Owner' ? `<button class="btn btn-primary btn-sm" data-a="toggleMemberStatus" data-id="${m.id}">${ic('user-check', 13)}Confirm</button>` : ''}</div></td>
      <td><button class="ibtn ibtn-sm" data-a="ctxBtn" data-ctx="member" data-id="${m.id}" aria-label="Member options">${ic('ellipsis', 14)}</button></td></tr>`;
      })
      .join('')}
    </tbody></table>`
        : empty('search-x', 'No results found', 'No members match that search.', '', 'sm')
    }</div>`
    }
  </div>`;
}
export function permsTable() {
  const rows = [
    ['View assigned projects & tasks', 1, 1, 1, 1],
    ['Comment on project tasks', 1, 1, 1, 1],
    ['Create and edit tasks in assigned projects', 1, 1, 1, 0],
    ['Create & delete projects', 1, 1, 0, 0],
    ['Assign members to projects', 1, 1, 0, 0],
    ['Invite members & manage roles', 1, 1, 0, 0],
    ['Workspace & team settings', 1, 1, 0, 0],
    ['Delete workspace', 1, 0, 0, 0],
  ];
  return `<div class="panel" style="overflow-x:auto"><table class="perm-t" style="min-width:560px"><thead><tr><th style="padding-left:14px">Permission</th>${ROLES.map(r => `<th>${r}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      r =>
        `<tr><td style="padding-left:14px">${r[0]}</td>${r
          .slice(1)
          .map(
            v =>
              `<td>${v ? `<span style="color:var(--green);display:inline-flex" aria-label="Allowed">${ic('check', 15)}</span>` : `<span class="faint" style="display:inline-flex" aria-label="Not allowed">${ic('minus', 15)}</span>`}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}
export function teamsGrid() {
  return `<div class="pgrid">${teamsList()
    .map(t => {
      const ms = D().members.filter(m => m.team === t.id);
      const ps = visibleProjects().filter(p => p.team === t.id);
      return `<div class="pcard" data-a="go" data-r="team" data-id="${t.id}" role="link" tabindex="0"><div class="row"><span class="picon" style="--c:${t.c}">${ic(t.icon, 15)}</span><b style="font-weight:600;font-size:14px">${t.name}</b></div><div class="desc">${t.desc}</div><div class="foot"><span class="row" style="gap:4px">${ic('users', 12)}${ms.length} members</span><span class="row" style="gap:4px">${ic('folder', 12)}${ps.length} projects</span><span class="sp"></span>${avStack(
        ms.map(m => m.id),
        4,
      )}</div></div>`;
    })
    .join('')}</div>`;
}
export function pageTeams() {
  if (!isAdmin()) return page404();
  return `<div class="page"><div class="ph"><div><h1>Teams</h1><p>Groups of people who work on projects together.</p></div><div class="acts"><button class="btn btn-primary" data-a="newTeam">${ic('plus', 14)}New team</button></div></div>${teamsList().length ? teamsGrid() : `<div class="panel">${empty('users', 'No teams yet', 'Create a team to group people and give projects an owner.', `<button class="btn btn-primary btn-sm" data-a="newTeam">${ic('plus', 14)}New team</button>`)}</div>`}</div>`;
}
export function pageTeam() {
  if (!isAdmin()) return page404();
  const t = team(S.ui.params.id);
  if (!t) return page404();
  const ms = D().members.filter(m => m.team === t.id);
  const ps = visibleProjects().filter(p => p.team === t.id);
  const ts = allTasks().filter(x => ms.some(m => m.id === x.assignee) && x.status !== 'done');
  return `<div class="page">
    <div class="ph"><div class="row" style="gap:12px"><span class="picon lg" style="--c:${t.c}">${ic(t.icon, 18)}</span><div><h1>${t.name}</h1><p style="margin:2px 0 0">${t.desc}</p></div></div><div class="acts"><button class="btn btn-secondary" data-a="editTeam" data-id="${t.id}">${ic('pencil', 14)}Edit team</button><button class="btn btn-secondary" data-a="invite">${ic('user-plus', 14)}Invite to workspace</button></div></div>
    <div class="grid2"><div class="stack">
      <section class="panel"><div class="panel-h"><h2>Projects</h2><span class="faint">${ps.length}</span></div>${ps.map(p => `<div class="mini" data-a="go" data-r="project" data-id="${p.id}">${pIcon(p, '', 14)}<span class="tt">${esc(p.name)}</span>${pStatus(p.status)}<span class="row" style="width:120px">${progBar(progressOf(p.id))}</span></div>`).join('') || '<div class="panel-b faint">No projects</div>'}</section>
      <section class="panel"><div class="panel-h"><h2>Open tasks</h2><span class="faint">${ts.length}</span></div>${sortTasks(ts, { f: 'due', dir: 1 })
        .slice(0, 8)
        .map(x => miniRow(x))
        .join('')}</section>
    </div>
    <section class="panel" style="align-self:start"><div class="panel-h"><h2>Members</h2><span class="faint">${ms.length}</span></div>${ms.map(m => `<div class="mini" style="min-height:48px" data-a="go" data-r="member" data-id="${m.id}">${av(m.id, 'md', false)}<div class="grow"><div style="font-weight:500">${esc(m.name)}</div><div class="faint" style="font-size:12px">${esc(m.title)}</div></div><span class="badge">${m.role}</span></div>`).join('')}</section></div>
  </div>`;
}
export function pageMember() {
  const m = mem(S.ui.params.id);
  if (!m) return page404();
  const admin = isAdmin();
  const ts = allTasks().filter(t => t.assignee === m.id);
  const open = ts.filter(t => t.status !== 'done');
  const done = ts.filter(t => t.status === 'done');
  const allVisProjs = visibleProjects().filter(p => p.status !== 'complete' && canSee(p));
  const ps = allVisProjs.filter(p => p.members.includes(m.id) || p.lead === m.id);
  const acts = D()
    .activity.filter(a => a.by === m.id)
    .slice(0, 8);
  const tab = S.ui.memTab || 'assigned';
  const targetIsAdmin = ['Owner', 'Admin'].includes(m.role);
  return `<div class="page">
    <div class="row" style="gap:18px;margin-bottom:22px;flex-wrap:wrap;align-items:flex-start">
      ${av(m.id, 'xl ' + (m.last != null && m.last < 5 ? 'presence' : ''), false)}
      <div class="grow" style="min-width:220px"><div class="row" style="gap:10px;flex-wrap:wrap"><h1 style="font-size:var(--fs-2xl);margin:0;font-weight:600;letter-spacing:-.02em">${esc(m.name)}</h1><span class="badge">${m.role === 'Owner' ? ic('crown', 11) : ''}${m.role}</span>${m.status === 'invited' ? '<span class="badge amber">Invite pending</span>' : m.status === 'deactivated' ? '<span class="badge gray">Deactive · Awaiting confirmation</span>' : '<span class="badge green"><span class="dot"></span>Active</span>'}</div>
        <div class="muted" style="margin-top:3px">${esc(m.title)}${admin && m.team ? ` · ${TM[m.team].name}` : ''}</div>
        <div class="row faint" style="margin-top:8px;gap:14px;font-size:12.5px;flex-wrap:wrap">${m.email ? `<span class="row" style="gap:5px">${ic('mail', 13)}<span style="user-select:all">${esc(m.email)}</span></span>` : ''}<span class="row" style="gap:5px">${ic('map-pin', 13)}${esc(m.tz)}</span><span class="row" style="gap:5px">${ic('clock', 13)}${m.last == null ? 'Never signed in' : m.last < 5 ? 'Online now' : 'Active ' + ago(minsAgo(m.last))}</span></div></div>
      <div class="row">${admin && m.role !== 'Owner' && m.id !== D().me ? `<button class="btn ${m.status === 'deactivated' ? 'btn-primary' : 'btn-secondary'}" data-a="toggleMemberStatus" data-id="${m.id}">${ic(m.status === 'deactivated' ? 'user-check' : 'user-x', 14)}${m.status === 'deactivated' ? 'Confirm & activate' : 'Deactivate'}</button>` : ''}${m.email ? `<button class="btn btn-secondary" data-a="copyText" data-text="${esc(m.email)}">${ic('copy', 14)}Copy email</button>` : ''}<button class="btn btn-primary" data-a="newTask" data-assignee="${m.id}">${ic('plus', 14)}Assign task</button><button class="ibtn" data-a="ctxBtn" data-ctx="member" data-id="${m.id}" aria-label="More">${ic('ellipsis', 16)}</button></div>
    </div>
    <div class="stats" style="margin-bottom:18px">
      <div class="stat"><span class="k">Active projects</span><span class="v">${ps.length}</span></div>
      <div class="stat"><span class="k">Assigned tasks</span><span class="v">${open.length}</span></div>
      <div class="stat"><span class="k">Completed tasks</span><span class="v">${done.length}</span></div>
      <div class="stat"><span class="k">Overdue</span><span class="v" style="${open.filter(isOver).length ? 'color:var(--red)' : ''}">${open.filter(isOver).length}</span></div>
    </div>
    <div class="grid2"><section class="panel"><div class="tabs" style="padding:0 8px">${[
      ['assigned', `Assigned · ${open.length}`],
      ['completed', `Completed · ${done.length}`],
    ]
      .map(([k, n]) => `<button class="tab ${tab === k ? 'on' : ''}" data-a="set" data-k="memTab" data-v="${k}">${n}</button>`)
      .join('')}</div>
      ${(tab === 'assigned' ? sortTasks(open, { f: 'due', dir: 1 }) : done).map(t => miniRow(t, { av: false })).join('') || empty('list-checks', 'No tasks here', 'Nothing to show in this list.', '', 'sm')}</section>
      <div class="stack">
      ${
        admin
          ? `<section class="panel"><div class="panel-h"><h2>Project access</h2><span class="faint" style="font-size:12px">${targetIsAdmin ? 'Full workspace access' : `${ps.length} of ${allVisProjs.length} assigned`}</span></div>${
              targetIsAdmin
                ? `<div class="panel-b faint" style="font-size:13px">${esc(m.name)} is a workspace ${esc(m.role)} and has automatic access to all projects.</div>`
                : allVisProjs.length
                  ? allVisProjs
                      .map(p => {
                        const assigned = p.members.includes(m.id) || p.lead === m.id;
                        const isLead = p.lead === m.id;
                        const perm = isLead ? 'Full access' : p.perms?.[m.id] || (m.role === 'Guest' ? 'Can view' : 'Can edit');
                        return `<div class="mini" style="min-height:44px;gap:10px"><input type="checkbox" class="check" data-a="toggleMemberProj" data-mid="${m.id}" data-pid="${p.id}" ${assigned ? 'checked' : ''} ${isLead ? 'disabled' : ''} aria-label="Assign ${esc(p.name)}">${pIcon(p, '', 14)}<button class="tt" style="text-align:left;background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit" data-a="go" data-r="project" data-id="${p.id}">${esc(p.name)}</button>${
                          assigned
                            ? isLead
                              ? `<span class="badge">Project lead</span>`
                              : `<select class="select" style="width:auto;height:26px;font-size:12px" data-in="memberProjPerm" data-mid="${m.id}" data-pid="${p.id}" aria-label="Permission for ${esc(p.name)}">${PERMS.map(q => `<option ${q === perm ? 'selected' : ''}>${q}</option>`).join('')}</select>`
                            : `<span class="faint" style="font-size:12px">Isolated</span>`
                        }</div>`;
                      })
                      .join('')
                  : '<div class="panel-b faint">No projects in workspace</div>'
            }</section>`
          : `<section class="panel"><div class="panel-h"><h2>Active projects</h2></div>${ps.map(p => `<div class="mini" data-a="go" data-r="project" data-id="${p.id}">${pIcon(p, '', 14)}<span class="tt">${esc(p.name)}</span><span class="faint" style="font-size:12px">${p.lead === m.id ? 'Lead' : 'Member'}</span></div>`).join('') || '<div class="panel-b faint">No active projects</div>'}</section>`
      }
      <section class="panel"><div class="panel-h"><h2>Recent activity</h2></div><div class="panel-b feed">${acts.map(a => actHtml(a)).join('') || '<span class="faint">No recent activity</span>'}</div></section></div></div>
  </div>`;
}
