# 05 — Authentication & Authorization 3-Phase Implementation Plan

This document defines the 3-phase engineering plan to implement server-enforced authentication, session management, and role-based access control (RBAC) in **MiniPlanner** using Node.js (`node:crypto`) and SQLite (`better-sqlite3`).

> For the full audit of endpoints, UI flows, and user-scoped operations, see **[04 — Authentication & Authorization Audit](./04-authentication-audit-and-implementation-plan.md)**.

---

## Architecture Overview

```mermaid
sequenceDiagram
    participant Browser as Browser (SPA)
    participant API as Server API (server/api.js)
    participant Auth as Crypto & Session (server/auth.js)
    participant DB as SQLite (server/db.js)

    Browser->>API: POST /api/auth/login { email, password }
    API->>DB: Lookup member by email
    API->>Auth: verifyPassword(password, member.password_hash)
    Auth-->>API: Valid
    API->>Auth: generateSessionToken() -> { token, tokenHash }
    API->>DB: INSERT INTO sessions (token_hash, member_id, ...)
    API-->>Browser: Set-Cookie: miniplanner_sid=<token>; HttpOnly + { member, state }
    Browser->>API: GET /api/state (Cookie: miniplanner_sid=<token>)
    API->>DB: authenticateSession(tokenHash)
    DB-->>API: { member, session }
    API->>DB: loadState(member.id, session.id)
    DB-->>API: User-scoped workspace state
    API-->>Browser: 200 OK { data, prefs, views }
```

---

## Phase 1: SQLite Credential & Session Schema + Backend Auth API (`server/`)

**Objective:** Build the zero-dependency cryptographic layer (`server/auth.js`), upgrade the SQLite schema (`server/db.js`) to store password hashes, 2FA secrets, per-user preferences, and hashed session tokens, and expose `/api/auth/*` endpoints (`server/api.js`).

### 1.1 Zero-Dependency Cryptography (`server/auth.js`)

- **Password Hashing (`node:crypto` `scryptSync`):**
  - `hashPassword(password)` — Generates a 16-byte cryptographic salt (`randomBytes(16)`), derives a 64-byte key using `scryptSync(password, salt, 64)`, and stores as `scrypt$<saltHex>$<hashHex>`.
  - `verifyPassword(password, storedHash)` — Recomputes the `scrypt` key and compares using `timingSafeEqual` to prevent timing attacks.
- **Session Tokens & Cookies:**
  - `generateSessionToken()` — Generates a 32-byte random token (`base64url`) and its SHA-256 hex digest (`tokenHash`). Only `tokenHash` is stored in SQLite.
  - `parseSessionToken(req)` — Reads `miniplanner_sid` from `Cookie` header or Bearer token from `Authorization` header.
  - `serializeSessionCookie(token, maxAgeSec)` / `clearSessionCookie()` — Formats `HttpOnly; Path=/; SameSite=Lax` cookie headers.
  - `parseDevice(userAgent)` — Extracts OS and browser name (e.g., `Windows · Chrome`, `macOS · Safari`) for the session list UI.
- **Two-Factor Authentication (TOTP & Recovery Codes):**
  - `generateTotpSetup()` — Generates a Base32 secret and 6 single-use recovery codes (`XXXX-XXXX`).
  - `verifyTotpOrRecovery(secret, recoveryCodes, code)` — Validates RFC 6238 TOTP codes (±1 time window) or consumes a recovery code.

### 1.2 SQLite Schema Upgrades (`server/db.js`)

- **`members` table additions:**
  - `password_hash TEXT NULL`
  - `tfa_secret TEXT NULL`
  - `tfa_enabled INTEGER NOT NULL DEFAULT 0`
  - `recovery_codes_json TEXT NOT NULL DEFAULT '[]'`
- **`sessions` table additions:**
  - `token_hash TEXT NULL`
  - `member_id TEXT NOT NULL DEFAULT 'm1'`
  - `created_at INTEGER NOT NULL DEFAULT 0`
  - `last_active_at INTEGER NOT NULL DEFAULT 0`
  - `expires_at INTEGER NOT NULL DEFAULT 0`
- **Per-User Preferences & Views:**
  - Scope `user_preferences` and `ui_views` by `member_id` so each signed-in member has independent theme, density, language, and view filter states.
- **Safe State Persistence (`writeFullStateTx`):**
  - Preserve `password_hash`, `tfa_secret`, `tfa_enabled`, and `recovery_codes_json` when syncing `members` from client state.
  - Preserve active authenticated rows in `sessions` so workspace state saves never overwrite live login sessions.

### 1.3 Backend Auth Endpoints (`server/api.js`)

| Endpoint               | Method   | Description                                                                                                                                     |
| :--------------------- | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/me`         | `GET`    | Returns `{ authenticated, setupRequired, member, sessionId }`.                                                                                  |
| `/api/auth/signup`     | `POST`   | Sets password & profile for initial `Owner` (first-run) or activates an invited member; creates session and sets `miniplanner_sid` cookie.      |
| `/api/auth/login`      | `POST`   | Validates email + password (+ optional 2FA code), creates session in SQLite, sets `miniplanner_sid` cookie, and returns user + workspace state. |
| `/api/auth/logout`     | `POST`   | Deletes current session from SQLite and clears `miniplanner_sid` cookie.                                                                        |
| `/api/auth/password`   | `POST`   | Verifies `currentPassword` and updates `password_hash` for the authenticated member.                                                            |
| `/api/auth/sessions`   | `DELETE` | Revokes a single session (`?id=<sid>`) or all other sessions (`?others=1`) for the authenticated member.                                        |
| `/api/auth/2fa/setup`  | `POST`   | Generates a pending TOTP secret and recovery codes for the authenticated member.                                                                |
| `/api/auth/2fa/verify` | `POST`   | Verifies the 6-digit code and enables 2FA (`tfa_enabled = 1`).                                                                                  |
| `/api/auth/2fa`        | `DELETE` | Disables 2FA (`tfa_enabled = 0`) for the authenticated member.                                                                                  |

---

## Phase 2: Frontend Auth Lifecycle & Session Integration (`src/`)

**Objective:** Wire all authentication, onboarding, password, 2FA, and session screens in the SPA to the Phase 1 `/api/auth/*` endpoints and enforce authentication on boot.

### 2.1 Boot & Session Hydration (`src/core/store.js`, `src/main.js`)

- Update `hydrate()` in `src/core/store.js`:
  - Call `GET /api/state` (or `GET /api/auth/me`).
  - If `401 Unauthorized` is returned:
    - Set `S.ui.auth = res.setupRequired ? 'signup' : 'login'`.
  - If authenticated:
    - Set `D().me` to the authenticated member ID (`j.data.me`), sync `S.prefs.name` and `S.prefs.title` with `me()`, and render the workspace shell.

### 2.2 Auth & Security Action Wiring (`src/actions/actions.js`, `src/pages/auth.js`, `src/pages/settings.js`)

- **`A.doLogin`:** `POST /api/auth/login` with `{ email, password, remember }`; handle `require2fa` prompt if 2FA is active; hydrate `S` and call `enterApp()`.
- **`A.doSignup`:** `POST /api/auth/signup` with `{ name, email, password }`; hydrate `S` and transition to onboarding (`S.ui.auth = 'onboarding'`) for new workspaces or enter the workspace for invited members.
- **`A.signOut`:** `POST /api/auth/logout`; clear sensitive client state and switch to `S.ui.auth = 'login'`.
- **`A.savePassword`:** `POST /api/auth/password` with `{ currentPassword, newPassword }`; display server validation errors if current password does not match.
- **`A.revokeSession` & `A.revokeAll`:** `DELETE /api/auth/sessions?id=...` / `DELETE /api/auth/sessions?others=1`; refresh `D().sessions` from server response.
- **`A.setup2fa`, `A.verify2fa`, `A.disable2fa`:** Connect to `/api/auth/2fa/setup`, `/api/auth/2fa/verify`, and `DELETE /api/auth/2fa`, displaying server-generated recovery codes.

---

## Phase 3: Server & Client Role-Based Access Control (RBAC)

**Objective:** Enforce role permissions (`Owner`, `Admin`, `Member`, `Guest`) and private project access (`canSee`) across both SQLite queries/mutations and UI controls.

### 3.1 Server-Side Authorization (`server/db.js`, `server/api.js`)

- **Read Filtering (`loadState`):**
  - Filter private projects (`is_private = 1`) and their tasks, comments, and files if the authenticated `member.id` is not in `project_members` (unless `Owner`).
- **Write Guards (`saveState`, `/api/reset`, `/api/transactions`):**
  - `POST /api/reset` and workspace deletion require `role === 'Owner'`.
  - `GET /api/transactions` requires `role IN ('Owner', 'Admin')`.
  - Role changes (`members.role`), member removals, and workspace settings updates require `role IN ('Owner', 'Admin')`.
  - `Guest` role is restricted from creating projects, managing teams, or editing tasks on projects where they only have view/comment access.

### 3.2 Client-Side UI Guards (`src/pages/`, `src/actions/`)

- Conditionally disable or hide admin-only buttons (`Delete workspace`, `Reset workspace`, `New team`, `Delete team`, `Invite member`, role dropdowns) based on `me().role` and workspace permission toggles (`permCreate`, `permGuests`).

---

## Phase 1 Implementation Report (Completed)

**Status:** Completed & Verified

### Deliverables Implemented

1. **Zero-Dependency Cryptography & Session Engine (`server/auth.js`):**
   - `hashPassword(password)` and `verifyPassword(password, storedHash)` using Node.js `node:crypto` (`scryptSync`, `randomBytes`, `timingSafeEqual`).
   - `generateSessionToken()`, `hashToken(token)`, `parseSessionToken(req)`, `serializeSessionCookie(token, maxAgeSec)`, `clearSessionCookie()`, and `parseDevice(userAgent)` for 256-bit random tokens, SHA-256 database hashing, and `HttpOnly; SameSite=Lax` cookie management (`miniplanner_sid`).
   - `generateTotpSetup()`, `computeTotp(secretBase32, counter)`, and `verifyTotpOrRecovery(secret, recoveryCodes, rawCode)` for RFC 6238 HMAC-SHA1 TOTP two-factor verification and single-use recovery codes.

2. **SQLite Schema Upgrades & Auth Transactions (`server/db.js`):**
   - Added automatic in-place schema migration (`migrateSchema(db)`) upgrading:
     - `members`: `password_hash`, `tfa_secret`, `tfa_enabled`, `recovery_codes_json`.
     - `sessions`: `token_hash` (unique index), `member_id`, `created_at`, `last_active_at`, `expires_at`.
     - `user_preferences` & `ui_views`: Composite primary keys `(member_id, key)` and `(member_id, view_key)` for per-user preferences and saved view configurations.
   - Updated `writeFullStateTx` so client state saves preserve member credentials (`password_hash`, `tfa_*`) and active token-backed sessions.
   - Implemented transactional database functions: `getAuthStatus`, `signupUser`, `loginUser`, `logoutSession`, `changeUserPassword`, `revokeUserSessions`, `setupUser2fa`, `verifyAndEnableUser2fa`, and `disableUser2fa`.

3. **Backend Auth API & Session Guard (`server/api.js`):**
   - Exposed `GET /api/auth/me`, `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/password`, `DELETE /api/auth/sessions`, `POST /api/auth/2fa/setup`, `POST /api/auth/2fa/verify`, and `DELETE /api/auth/2fa`.
   - Protected `/api/state`, `/api/reset`, and `/api/transactions` with session verification (`401 Unauthorized` once initial setup is complete unless a valid session cookie/token is presented).

---

## Phase 2 Implementation Report (Completed)

**Status:** Completed & Verified

### Deliverables Implemented

1. **Boot & Session Hydration Guard (`src/core/store.js`, `src/main.js`):**
   - Added `applyServerState(j)` in `src/core/store.js` to consistently hydrate `S.data`, `S.prefs`, `S.views`, and `S.ui.collapsed` from server responses.
   - Updated `hydrate()` in `src/core/store.js` to query `GET /api/auth/me`:
     - When `setupRequired` is `true` (brand-new unconfigured database), routes the user to `S.ui.auth = 'signup'` to create the initial `Owner` account.
     - When `authenticated` is `false`, routes the user to `S.ui.auth = 'login'`.
     - When `authenticated` is `true`, hydrates the user-scoped workspace state from `GET /api/state`.

2. **Authentication & Onboarding UI Flows (`src/pages/auth.js`, `src/actions/actions.js`):**
   - Removed the hardcoded demo email (`hello@miniplanner.com`) from `renderAuth()` in `src/pages/auth.js`.
   - Added two-factor authentication / recovery code input (`#l-totp`) to the login screen when `S.ui.login2fa` is triggered.
   - Connected `A.doLogin` to `POST /api/auth/login` with server-side validation, 2FA challenge support (`require2fa`), session cookie issuance, and full workspace hydration.
   - Connected `A.doSignup` to `POST /api/auth/signup`, launching workspace onboarding (`S.ui.auth = 'onboarding'`) for the first `Owner` and entering the workspace directly for invited/additional members.
   - Connected `A.signOut` to `POST /api/auth/logout`, revoking the SQLite session and clearing the `miniplanner_sid` cookie.

3. **Security Settings Integration (`src/pages/settings.js`, `src/actions/actions.js`):**
   - **Password Update (`A.savePassword`):** Connected to `POST /api/auth/password`, verifying `currentPassword` against the stored `scrypt` hash before updating `password_hash`.
   - **Active Sessions (`A.revokeSession`, `A.revokeAll`):** Connected to `DELETE /api/auth/sessions?id=...` and `DELETE /api/auth/sessions?others=1`, updating `D().sessions` directly from the SQLite `sessions` table.
   - **Two-Factor Authentication (`A.setup2fa`, `A.verify2fa`, `A.disable2fa`):** Connected to `POST /api/auth/2fa/setup`, `POST /api/auth/2fa/verify`, and `DELETE /api/auth/2fa`, displaying the generated Base32 TOTP secret and single-use recovery codes in `src/pages/settings.js`.

---

## Phase 3 Implementation Report (Completed)

**Status:** Completed & Verified

### Deliverables Implemented

1. **Server-Side Role-Based Access Control (`server/api.js`, `server/db.js`):**
   - **Endpoint Role Guards (`server/api.js`):**
     - `POST /api/reset` enforces `auth.member.role === 'Owner'` (`403 Forbidden` for non-owners).
     - `GET /api/transactions` enforces `['Owner', 'Admin'].includes(auth.member.role)` (`403 Forbidden` for `Member` and `Guest` roles).
   - **Read Filtering (`loadState` in `server/db.js`):**
     - `Guest` accounts only receive projects where `p.members.includes(activeMe)`.
     - Private projects (`is_private = 1`) filter out `tasks`, `comments`, `files`, `activity`, `notifications`, `events`, and `savedViews` for non-members unless the user is `Owner` or `Admin`.
   - **Write Guards (`writeFullStateTx` in `server/db.js`):**
     - Prevents non-admins (`Member`, `Guest`) from overwriting `workspace_settings` (`name`, `url`, `color`, `brand`), `workspaces`, `teams`, or escalating `members.role` / deleting workspace members.

2. **Client-Side RBAC Helpers & Action/UI Guards (`src/core/store.js`, `src/actions/`, `src/pages/`, `src/overlays/`):**
   - Exported `isOwner()`, `isAdmin()`, `canCreateProject()`, `canInvite()`, `canEditTask(p)`, and updated `canSee(p)` in `src/core/store.js`.
   - Guarded team management (`A.newTeam`, `A.editTeam`, `A.delTeam` in `src/actions/teams.js`) and member management (`A.removeMember` in `src/actions/actions.js`, `ctxMenu` in `src/overlays/context-menu.js`, `case 'members'` in `src/pages/settings.js`) with `isAdmin()`.
   - Guarded workspace settings (`A.wsColor`, `A.saveWorkspace`) with `isAdmin()` and workspace deletion/reset (`A.delWorkspace`, `A.resetDemo`, `case 'workspace'` in `src/pages/settings.js`) with `isOwner()`.
   - Guarded project creation (`A.newProject`), member invites (`A.invite`), and guest task creation (`A.newTask`) with `canCreateProject()`, `canInvite()`, and `canEditTask()`.
