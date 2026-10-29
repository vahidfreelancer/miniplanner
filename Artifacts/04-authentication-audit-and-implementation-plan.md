# 04 — Authentication & Authorization Audit

This document catalogues every API endpoint, UI screen, client action, and data lookup across **MiniPlanner** that requires an authenticated user.

> For the 3-phase implementation plan, see **[05 — Authentication & Authorization 3-Phase Implementation Plan](./05-authentication-3-phase-plan.md)**.

---

## Part 1: Platform Authentication Audit

### 1.1 Current State (Prototype Mode)

- **Boot Behavior (`src/main.js`):** On startup, `S.ui.auth` defaults to `null`, rendering the main workspace shell immediately unless the URL hash is `#login`, `#signup`, `#forgot`, `#reset`, `#verify`, or `#onboarding`, or the user clicks **Sign out** (`A.signOut`).
- **Static Active User (`src/core/store.js`):** `D().me` is stored in workspace settings (defaulting to `'m1'`), and `me()` resolves to that member record without verifying a session cookie or token.
- **Unauthenticated Server API (`server/api.js`):** All `/api/*` endpoints currently accept requests without verifying an `Authorization` header or `HttpOnly` session cookie.

---

### 1.2 Server API Endpoints Requiring Authentication (`server/api.js`)

| Endpoint            | Method         | Handler (`server/db.js`) | Required Access Level                       | Purpose                                                                                                                       |
| :------------------ | :------------- | :----------------------- | :------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------- |
| `/api/state`        | `GET`          | `loadState()`            | **Authenticated Member / Guest**            | Loads workspace metadata, members, projects, tasks, comments, notifications, and personal preferences (`S.prefs`, `S.views`). |
| `/api/state`        | `PUT` / `POST` | `saveState()`            | **Authenticated Member** (filtered by role) | Persists workspace, project, task, comment, team, and preference mutations in an atomic SQLite transaction.                   |
| `/api/reset`        | `POST`         | `resetState()`           | **Owner only**                              | Wipes and resets the workspace SQLite database back to a clean initial state.                                                 |
| `/api/transactions` | `GET`          | `getTransactions()`      | **Owner / Admin**                           | Returns the audit log of database write transactions (`transactions_log`).                                                    |

#### New Auth API Endpoints Required

| Endpoint             | Method            | Access Level          | Purpose                                                                                                                                                            |
| :------------------- | :---------------- | :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/login`    | `POST`            | Public                | Verifies email + password (and 2FA code if enabled), creates a session row in `sessions`, sets an `HttpOnly` session cookie, and returns the user + initial state. |
| `/api/auth/signup`   | `POST`            | Public / Invite Token | Registers a new account (or claims an invited member record), hashes password, and starts a session.                                                               |
| `/api/auth/logout`   | `POST`            | Authenticated         | Revokes the current session in SQLite and clears the session cookie.                                                                                               |
| `/api/auth/me`       | `GET`             | Authenticated         | Validates the current session cookie/token and returns the authenticated member identity (`me`).                                                                   |
| `/api/auth/password` | `POST`            | Authenticated         | Verifies current password hash and updates to a new password hash.                                                                                                 |
| `/api/auth/sessions` | `DELETE`          | Authenticated         | Revokes a specific session (`?id=...`) or all other sessions for the current user.                                                                                 |
| `/api/auth/2fa`      | `POST` / `DELETE` | Authenticated         | Generates/verifies TOTP secret and recovery codes, or disables 2FA.                                                                                                |

---

### 1.3 Authentication & Account Security UI Flows

#### Public -> Authenticated Flows (`src/pages/auth.js`, `src/actions/actions.js`)

- **`A.doLogin`** (`src/actions/actions.js`) — Email & password sign-in form (`#l-email`, `#l-pw`, `#l-rem`).
- **`A.socialAuth`** (`src/actions/actions.js`) — OAuth provider sign-in (`Google`, `Microsoft`, `Apple`).
- **`A.doSignup` & `A.verified`** (`src/actions/actions.js`) — Account registration (`#s-name`, `#s-email`, `#s-pw`) and email verification step.
- **`A.doForgot`, `A.resend`, `A.doReset`** (`src/actions/actions.js`) — Password reset request and new password submission (`#r-pw`, `#r-pw2`).
- **Onboarding (`renderOnboarding` in `src/pages/auth.js`, `A.onbNext`, `A.onbFinish` in `src/actions/actions.js`)** — Initial workspace name/URL, default project view, first project creation, and team email invites.

#### Authenticated Account Security (`src/pages/settings.js`, `src/actions/actions.js`)

- **`A.signOut`** — Clears client UI overlays and transitions to `S.ui.auth = 'login'`.
- **`A.savePassword`** (`Settings -> Security -> Password`) — Validates current password (`#pw-cur`), new password strength (`#pw-new`), and confirmation (`#pw-conf`).
- **`A.revokeSession` & `A.revokeAll`** (`Settings -> Security -> Sessions`) — Lists active sessions (`D().sessions`) and signs out individual or all other devices.
- **`A.setup2fa`, `A.verify2fa`, `A.disable2fa`** (`Settings -> Security -> Two-factor authentication`) — Enrolls or disables 2FA (`D().tfa`) and displays recovery codes.

---

### 1.4 User-Scoped Views & Operations (`D().me` / `me()`)

Every operation below depends on the currently authenticated user (`D().me` / `me()`):

1. **Personal Dashboards & Navigation:**
   - **Home (`src/pages/home.js` -> `pageHome()`):** Greets `S.prefs.name`, computes `mineAll` (`t.assignee === D().me`), and shows personal Upcoming / Overdue / Completed tabs.
   - **My Tasks (`src/pages/my-tasks.js` -> `pageMyTasks()`):** Displays tasks assigned to `D().me`; inline composer (`A.commitComposer`) auto-assigns created tasks to `D().me`.
   - **Sidebar & Topbar (`src/shell/layout.js` -> `renderSidebar()`, `renderTopbar()`):** Displays active user avatar (`av(D().me)`), name (`S.prefs.name`), unread notification badges, and count of open tasks assigned to `D().me` due today/overdue.
   - **Inbox & Notifications (`src/pages/inbox.js`, `src/pages/notifications.js`):** Filters and mutates read/unread state (`A.selNotif`, `A.toggleRead`, `A.markAllRead`, `A.openNotif`) and per-user notification settings (`IN.npToggle`).
2. **Personal Profile & Preferences (`src/pages/settings.js`, `src/actions/actions.js`):**
   - **Profile (`A.saveProfile`, `A.avColor`):** Updates `me().name`, `me().title`, `me().c`, and `S.prefs.name` / `S.prefs.title`.
   - **Preferences (`A.setTheme`, `A.toggleDark`, `A.setPref`, `IN.prefToggle`, `IN.prefSel`):** Persists per-user theme, accent color, sidebar/task density, motion, language, timezone, date/time format, and launch page (`S.prefs`, `S.views`, `S.ui.collapsed`).
3. **Actor Attribution on Data Mutations (`src/actions/actions.js`, `src/core/store.js`):**
   - **Activity Log (`logAct` in `src/core/store.js`):** Records `by: D().me` on task/subtask/project mutations.
   - **Task Creation (`A.newTask`, `A.submitTask`, `createTask`):** Defaults `assignee` to `D().me` and tags task attachments with `by: D().me`.
   - **Project Creation (`A.newProject`, `createProject`):** Defaults project `lead` to `D().me` and `team` to `me().team`, adds `D().me` to `p.members`, and assigns the first starter task to `D().me`.
   - **Comments & Reactions (`A.postComment`, `A.react`):** Creates comments with `by: D().me` and toggles emoji reaction membership (`c.re[emoji]`) for `D().me`.
   - **Files (`handleFiles`, `A.dupFile`):** Records `by: D().me` on uploaded and duplicated files.

---

### 1.5 Role-Based & Project-Scoped Access Control (Authorization)

The platform defines four roles in `src/core/constants.js` (`ROLES = ['Owner', 'Admin', 'Member', 'Guest']`) and a permission matrix in `src/pages/members.js` (`permsTable()`):

| Capability                           | Owner | Admin |            Member             |             Guest             | Code Locations                                                                                                                     |
| :----------------------------------- | :---: | :---: | :---------------------------: | :---------------------------: | :--------------------------------------------------------------------------------------------------------------------------------- |
| View accessible projects & tasks     |  Yes  |  Yes  |              Yes              |     Only invited projects     | `canSee(p)` in `src/core/store.js`, `allTasks()`, `pageProject()`, `A.openTask`, `pageSearch()`, `pageActivity()`, `pageArchive()` |
| Comment on tasks                     |  Yes  |  Yes  |              Yes              |              Yes              | `A.postComment`, `A.delComment`, `A.react`                                                                                         |
| Create & edit tasks                  |  Yes  |  Yes  |              Yes              | No (unless given `edit` perm) | `createTask`, `updateTask`, `deleteTasks`, `A.newTask`, `A.submitTask`, `A.bulkSet`, `A.bulkDelete`                                |
| Create projects                      |  Yes  |  Yes  | Configurable (`P.permCreate`) |              No               | `A.newProject`, `A.submitProject`, `createProject`, `A.dupProject`, `A.archiveProject`, `A.delProject`                             |
| Project sharing & member permissions |  Yes  |  Yes  |     Project Lead / Editor     |              No               | `A.share`, `A.shareAdd`, `A.shareInvite`, `IN.sharePerm`, `IN.shareAccess`                                                         |
| Invite workspace members             |  Yes  |  Yes  | Configurable (`P.permGuests`) |              No               | `A.invite`, `A.submitInvite`, `A.resendInvite`, `A.removeMember`                                                                   |
| Manage member roles                  |  Yes  |  Yes  |              No               |              No               | `isAdmin` check in `pageMembers()` (`src/pages/members.js`), `A.popPick` (`type === 'role'`)                                       |
| Manage teams                         |  Yes  |  Yes  |              No               |              No               | `A.newTeam`, `A.editTeam`, `A.submitTeam`, `A.delTeam` (`src/actions/teams.js`)                                                    |
| Workspace settings                   |  Yes  |  Yes  |              No               |              No               | `A.wsColor`, `A.saveWorkspace`                                                                                                     |
| Delete / reset workspace             |  Yes  |  No   |              No               |              No               | `A.delWorkspace`, `A.resetDemo`                                                                                                    |

---

## Part 2: Implementation Status Summary (Phases 1–3)

All 3 phases documented in **[05 — Authentication & Authorization 3-Phase Implementation Plan](./05-authentication-3-phase-plan.md)** have been implemented and verified:

| Phase       | Scope                                                        | Key Files                                                                                                                                                       | Status        |
| :---------- | :----------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------ |
| **Phase 1** | Zero-dependency crypto (`scrypt`, TOTP), SQLite schema & API | `server/auth.js`, `server/db.js`, `server/api.js`                                                                                                               | **Completed** |
| **Phase 2** | Frontend boot guard, login/signup/2FA UI & Security settings | `src/core/store.js`, `src/pages/auth.js`, `src/pages/settings.js`, `src/actions/actions.js`                                                                     | **Completed** |
| **Phase 3** | Server-side & client-side Role-Based Access Control (RBAC)   | `server/api.js`, `server/db.js`, `src/core/store.js`, `src/actions/actions.js`, `src/actions/teams.js`, `src/pages/settings.js`, `src/overlays/context-menu.js` | **Completed** |

---

## Part 2: Implementation Status Summary (Phases 1–3)

All 3 phases documented in **[05 — Authentication & Authorization 3-Phase Implementation Plan](./05-authentication-3-phase-plan.md)** have been implemented and verified:

| Phase       | Scope                                                        | Key Files                                                                                                                                                       | Status        |
| :---------- | :----------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------ |
| **Phase 1** | Zero-dependency crypto (`scrypt`, TOTP), SQLite schema & API | `server/auth.js`, `server/db.js`, `server/api.js`                                                                                                               | **Completed** |
| **Phase 2** | Frontend boot guard, login/signup/2FA UI & Security settings | `src/core/store.js`, `src/pages/auth.js`, `src/pages/settings.js`, `src/actions/actions.js`                                                                     | **Completed** |
| **Phase 3** | Server-side & client-side Role-Based Access Control (RBAC)   | `server/api.js`, `server/db.js`, `src/core/store.js`, `src/actions/actions.js`, `src/actions/teams.js`, `src/pages/settings.js`, `src/overlays/context-menu.js` | **Completed** |
