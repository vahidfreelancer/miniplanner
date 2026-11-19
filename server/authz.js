/* =====================================================================
   CENTRAL PROJECT-SCOPED AUTHORIZATION MODULE (server/authz.js)
   ===================================================================== */

const PERM_RANK = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  lead: 4,
};

/**
 * Normalize legacy or UI permission labels into canonical project roles:
 *   'lead' | 'editor' | 'commenter' | 'viewer'
 */
export function normalizeProjectPermission(rawPerm, isLead = false) {
  if (isLead) return 'lead';
  const s = String(rawPerm || '')
    .trim()
    .toLowerCase();
  if (s === 'lead' || s === 'full access' || s === 'full' || s === 'owner' || s === 'admin') return 'lead';
  if (s === 'editor' || s === 'can edit' || s === 'edit' || s === 'write') return 'editor';
  if (s === 'commenter' || s === 'can comment' || s === 'comment') return 'commenter';
  if (s === 'viewer' || s === 'can view' || s === 'view' || s === 'read') return 'viewer';
  return 'editor';
}

/**
 * Convert canonical permission back to UI label for client compatibility
 * while accepting either canonical or UI values.
 */
export function toUiPermission(perm) {
  const norm = normalizeProjectPermission(perm);
  if (norm === 'lead') return 'Full access';
  if (norm === 'commenter') return 'Can comment';
  if (norm === 'viewer') return 'Can view';
  return 'Can edit';
}

/**
 * Build the complete authorization scope for a member against the database.
 *
 * Rules:
 * - Workspace 'Owner' and 'Admin' are super-users (isAdmin = true).
 * - 'Member' and 'Guest' only have access to projects where they are listed
 *   in `project_members` (or as `projects.lead_id`).
 * - Visible members for a non-admin:
 *     1. The user themselves
 *     2. Any member who shares at least one accessible project with them
 *     3. Workspace Owners/Admins (name + avatar only; email redacted unless co-member)
 */
export function getScope(db, memberId) {
  const memberRow = memberId ? db.prepare('SELECT * FROM members WHERE id = ?').get(memberId) : null;
  const role = memberRow?.role || 'Guest';
  const isAdmin = role === 'Owner' || role === 'Admin';

  const allProjects = db.prepare('SELECT id, lead_id FROM projects').all();
  const allProjMembers = db.prepare('SELECT project_id, member_id, permission FROM project_members').all();

  const projectIds = new Set();
  const projectRole = new Map(); // projectId -> 'lead' | 'editor' | 'commenter' | 'viewer'
  const projectMemberMap = new Map(); // projectId -> Set<memberId>

  for (const p of allProjects) {
    const set = new Set();
    if (p.lead_id) set.add(p.lead_id);
    projectMemberMap.set(p.id, set);
  }
  for (const pm of allProjMembers) {
    let set = projectMemberMap.get(pm.project_id);
    if (!set) {
      set = new Set();
      projectMemberMap.set(pm.project_id, set);
    }
    set.add(pm.member_id);
  }

  if (isAdmin) {
    for (const p of allProjects) {
      projectIds.add(p.id);
      projectRole.set(p.id, 'lead');
    }
  } else if (memberId) {
    for (const p of allProjects) {
      if (p.lead_id === memberId) {
        projectIds.add(p.id);
        projectRole.set(p.id, 'lead');
      }
    }
    for (const pm of allProjMembers) {
      if (pm.member_id !== memberId) continue;
      if (!projectMemberMap.has(pm.project_id)) continue;
      projectIds.add(pm.project_id);
      const isLead = projectRole.get(pm.project_id) === 'lead';
      const defaultRole = role === 'Guest' && !pm.permission ? 'viewer' : pm.permission;
      projectRole.set(pm.project_id, normalizeProjectPermission(defaultRole, isLead));
    }
  }

  const coMemberIds = new Set();
  const visibleMemberIds = new Set();

  if (memberId) {
    coMemberIds.add(memberId);
    visibleMemberIds.add(memberId);
  }

  const allMemberRows = db.prepare('SELECT id, role FROM members').all();
  const adminIds = new Set();

  for (const m of allMemberRows) {
    if (m.role === 'Owner' || m.role === 'Admin') {
      adminIds.add(m.id);
      // Owners/Admins are visible to everyone (name + avatar only; email redacted unless co-member)
      visibleMemberIds.add(m.id);
    }
    if (isAdmin) {
      coMemberIds.add(m.id);
      visibleMemberIds.add(m.id);
    }
  }

  if (!isAdmin) {
    for (const pid of projectIds) {
      const mset = projectMemberMap.get(pid);
      if (!mset) continue;
      for (const mid of mset) {
        coMemberIds.add(mid);
        visibleMemberIds.add(mid);
      }
    }
  }

  return {
    memberId: memberId || null,
    role,
    isAdmin,
    projectIds,
    projectRole,
    projectMemberMap,
    coMemberIds,
    visibleMemberIds,
    adminIds,
  };
}

export function canReadProject(scope, projectId) {
  if (!scope || !projectId) return false;
  if (scope.isAdmin) return true;
  return scope.projectIds.has(projectId);
}

/**
 * Check if actor has at least `level` ('view' | 'comment' | 'edit' | 'manage') on `projectId`.
 * Note: 'manage' (creating/deleting projects, modifying project members/permissions) is Admin-only.
 */
export function canWriteProject(scope, projectId, level = 'edit') {
  if (!scope || !projectId) return false;
  if (scope.isAdmin) return true;
  if (level === 'manage') return false;
  if (!scope.projectIds.has(projectId)) return false;

  const pRole = scope.projectRole.get(projectId) || 'viewer';
  const rank = PERM_RANK[pRole] || 0;

  if (level === 'view') return rank >= PERM_RANK.viewer;
  if (level === 'comment') return rank >= PERM_RANK.commenter;
  if (level === 'edit') return rank >= PERM_RANK.editor;
  return false;
}

export function canManageMembership(scope) {
  return Boolean(scope && scope.isAdmin);
}

/**
 * Shape a member DB row for a given viewer scope:
 * - Admins see full member record.
 * - Non-admins only see members in `scope.visibleMemberIds`.
 * - Non-admins have `email` redacted ('') for everyone except themselves.
 */
export function redactMemberForScope(scope, mRow) {
  if (!mRow) return null;
  if (!scope.isAdmin && !scope.visibleMemberIds.has(mRow.id)) return null;
  const isSelf = mRow.id === scope.memberId;
  const showSensitive = scope.isAdmin || isSelf;
  return {
    id: mRow.id,
    name: mRow.name,
    email: showSensitive ? mRow.email : '',
    role: mRow.role,
    team: scope.isAdmin ? mRow.team_id : '',
    title: mRow.title,
    c: mRow.color,
    status: mRow.status,
    last: mRow.last_active,
    tz: mRow.timezone,
    ...(showSensitive && mRow.telegram_id ? { telegramId: String(mRow.telegram_id) } : {}),
    ...(showSensitive && mRow.telegram_username ? { telegramUsername: String(mRow.telegram_username) } : {}),
    ...(showSensitive && mRow.telegram_linked_at ? { telegramLinkedAt: mRow.telegram_linked_at } : {}),
  };
}
