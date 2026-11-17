import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiMiddleware } from '../server/api.js';
import { closeDb, getDb, loadState, loginUser, saveState, signupUser } from '../server/db.js';

function createTestServer() {
  const handleApi = apiMiddleware();
  const server = http.createServer(async (req, res) => {
    const handled = await handleApi(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function apiReq(baseUrl, method, urlPath, { token = null, body = null } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('Phase 0-2: Project-Scoped Isolation (Read, Write & C3 Data-Loss Prevention)', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniplanner-iso-'));
  const dbFile = path.join(tmpDir, 'test.sqlite');
  process.env.MINIPLANNER_DB_PATH = dbFile;
  closeDb();
  getDb(dbFile);

  const srv = await createTestServer();
  t.after(async () => {
    await srv.close();
    closeDb();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error on Windows */
    }
  });

  // 1. H7: Unauthenticated /api/state during setupRequired is blocked (401)
  await t.test('H7: Unauthenticated GET/PUT /api/state returns 401 even when setupRequired is true', async () => {
    const getRes = await apiReq(srv.baseUrl, 'GET', '/api/state');
    assert.equal(getRes.status, 401);
    assert.equal(getRes.json.setupRequired, true);

    const putRes = await apiReq(srv.baseUrl, 'PUT', '/api/state', { body: { data: {} } });
    assert.equal(putRes.status, 401);
  });

  // Setup: Sign up Owner (AD), Member A (mA), Member B (mB), Guest G (mG)
  let adminToken;
  let adminId;
  let memberAToken;
  let memberAId;
  let memberBToken;
  let memberBId;
  let guestGToken;
  let guestGId;

  await t.test('Setup workspace users and two confidential projects (P1 for A+G, P2 for B)', async () => {
    const ownerSignup = signupUser({
      name: 'Admin Owner',
      email: 'admin@company.com',
      password: 'Password123!',
    });
    assert.equal(ownerSignup.ok, true);
    assert.equal(ownerSignup.isFirstOwner, true);
    adminToken = ownerSignup.token;
    adminId = ownerSignup.member.id;

    // Sign up Member A, Member B, Guest G (they start deactivated until Admin activates them)
    const sigA = signupUser({ name: 'Alice Member', email: 'alice@company.com', password: 'Password123!' });
    const sigB = signupUser({ name: 'Bob Member', email: 'bob@company.com', password: 'Password123!' });
    const sigG = signupUser({ name: 'Gus Guest', email: 'gus@external.com', password: 'Password123!' });
    assert.equal(sigA.pendingApproval, true);
    assert.equal(sigB.pendingApproval, true);
    assert.equal(sigG.pendingApproval, true);
    memberAId = sigA.member.id;
    memberBId = sigB.member.id;
    guestGId = sigG.member.id;

    // Admin activates A, B, G and creates Project P1 (Alice + Gus viewer) and Project P2 (Bob)
    const adminState = loadState(adminId).data;
    adminState.teams = [
      { id: 'team1', name: 'Core Team', icon: 'users', c: '#5A67D8', desc: 'Internal' },
      { id: 'team2', name: 'Secret R&D', icon: 'lock', c: '#E53E3E', desc: 'Top secret' },
    ];
    adminState.members = adminState.members.map(m => {
      if (m.id === memberAId) return { ...m, status: 'active', role: 'Member', team: 'team1' };
      if (m.id === memberBId) return { ...m, status: 'active', role: 'Member', team: 'team2' };
      if (m.id === guestGId) return { ...m, status: 'active', role: 'Guest', team: '' };
      return m;
    });
    adminState.projects = [
      {
        id: 'p1',
        key: 'ALPHA',
        name: 'Project Alpha',
        icon: 'folder',
        color: 'indigo',
        status: 'progress',
        team: 'team1',
        lead: memberAId,
        members: [memberAId, guestGId],
        perms: { [memberAId]: 'Can edit', [guestGId]: 'Can view' },
        desc: 'Alpha confidential description',
        milestones: [{ name: 'Alpha M1', date: '2026-12-01' }],
        teamHistory: [],
        seq: 202,
      },
      {
        id: 'p2',
        key: 'OMEGA',
        name: 'Project Omega',
        icon: 'folder',
        color: 'crimson',
        status: 'planning',
        team: 'team2',
        lead: memberBId,
        members: [memberBId],
        perms: { [memberBId]: 'Full access' },
        desc: 'Omega top-secret description',
        milestones: [{ name: 'Omega Launch', date: '2026-12-15' }],
        teamHistory: [],
        seq: 202,
      },
    ];
    adminState.projOrder = ['p1', 'p2'];
    adminState.tasks = [
      {
        id: 't1',
        key: 'ALPHA-1',
        project: 'p1',
        title: 'Alpha Task 1',
        status: 'todo',
        assignee: memberAId,
        priority: 'high',
        labels: ['bug'],
        subtasks: [{ id: 'sub1', title: 'Alpha Subtask', done: false, assignee: memberAId }],
        attachments: [],
        deps: [],
        desc: 'Alpha task secret details',
      },
      {
        id: 't2',
        key: 'OMEGA-1',
        project: 'p2',
        title: 'Omega Task 1',
        status: 'progress',
        assignee: memberBId,
        priority: 'urgent',
        labels: ['feature'],
        subtasks: [{ id: 'sub2', title: 'Omega Subtask', done: false, assignee: memberBId }],
        attachments: [],
        deps: [],
        desc: 'Omega classified task details',
      },
    ];
    adminState.comments = [
      { id: 'c1', task: 't1', by: memberAId, at: Date.now(), text: 'Alpha comment', re: {} },
      { id: 'c2', task: 't2', by: memberBId, at: Date.now(), text: 'Omega secret comment', re: {} },
    ];
    adminState.activity = [
      { id: 'act1', by: memberAId, verb: 'created', task: 't1', project: 'p1', at: Date.now(), extra: '' },
      { id: 'act2', by: memberBId, verb: 'created', task: 't2', project: 'p2', at: Date.now(), extra: '' },
      { id: 'act_null', by: adminId, verb: 'system', task: null, project: null, at: Date.now(), extra: 'admin only' },
    ];
    adminState.files = [
      { id: 'f1', project: 'p1', task: 't1', name: 'alpha-spec.pdf', type: 'pdf', size: '1 MB', by: memberAId, at: Date.now() },
      { id: 'f2', project: 'p2', task: 't2', name: 'omega-blueprint.pdf', type: 'pdf', size: '2 MB', by: memberBId, at: Date.now() },
    ];
    adminState.events = [
      { id: 'ev1', title: 'Alpha Sync', date: '2026-11-20', time: '10:00', project: 'p1' },
      { id: 'ev2', title: 'Omega Review', date: '2026-11-21', time: '14:00', project: 'p2' },
      { id: 'ev_null', title: 'Global Event', date: '2026-11-22', time: '09:00', project: null },
    ];
    adminState.savedViews = [
      { id: 'sv1', project: 'p1', name: 'Alpha View', type: 'list', filters: [] },
      { id: 'sv2', project: 'p2', name: 'Omega View', type: 'board', filters: [] },
    ];
    adminState.recentSearches = ['omega secret search'];

    saveState({ data: adminState, prefs: {}, views: {}, collapsed: false }, 'admin_setup', adminId);

    const logA = loginUser({ email: 'alice@company.com', password: 'Password123!' });
    const logB = loginUser({ email: 'bob@company.com', password: 'Password123!' });
    const logG = loginUser({ email: 'gus@external.com', password: 'Password123!' });
    assert.equal(logA.ok, true);
    assert.equal(logB.ok, true);
    assert.equal(logG.ok, true);
    memberAToken = logA.token;
    memberBToken = logB.token;
    guestGToken = logG.token;
  });

  // 2. Phase 1: Read Isolation for Member A
  await t.test('C1, C4, C5, H1, H2: Member A GET /api/state is strictly isolated to Project P1', async () => {
    const res = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: memberAToken });
    assert.equal(res.status, 200);
    const d = res.json.data;

    // Projects: only p1
    assert.deepEqual(
      d.projects.map(p => p.id),
      ['p1'],
    );
    assert.deepEqual(d.projOrder, ['p1']);

    // Tasks, comments, files, events, savedViews, activity: only p1 (no p2 and no NULL project rows)
    assert.deepEqual(
      d.tasks.map(t => t.id),
      ['t1'],
    );
    assert.deepEqual(
      d.comments.map(c => c.id),
      ['c1'],
    );
    assert.deepEqual(
      d.files.map(f => f.id),
      ['f1'],
    );
    assert.deepEqual(
      d.events.map(e => e.id),
      ['ev1'],
    );
    assert.deepEqual(
      d.savedViews.map(sv => sv.id),
      ['sv1'],
    );
    assert.deepEqual(
      d.activity.map(a => a.id),
      ['act1'],
    );

    // Teams: completely hidden for non-admins
    assert.deepEqual(d.teams, []);

    // Members: Alice sees herself, co-member Gus, and Admin Owner — NEVER Bob (memberBId)
    const visibleIds = d.members.map(m => m.id);
    assert.ok(visibleIds.includes(memberAId), 'Alice sees herself');
    assert.ok(visibleIds.includes(guestGId), 'Alice sees P1 co-member Gus');
    assert.ok(visibleIds.includes(adminId), 'Alice sees workspace Owner');
    assert.ok(!visibleIds.includes(memberBId), 'Alice MUST NOT see Bob from Project P2');

    // Email redaction: Alice sees her own email, but Admin and Gus emails are redacted ('')
    const meObj = d.members.find(m => m.id === memberAId);
    const admObj = d.members.find(m => m.id === adminId);
    const gusObj = d.members.find(m => m.id === guestGId);
    assert.equal(meObj.email, 'alice@company.com');
    assert.equal(admObj.email, '');
    assert.equal(gusObj.email, '');

    // C5: Signup notifications waiting for admin approval are NOT visible to Alice
    assert.equal(
      d.notifs.some(n => n.text.includes('waiting for admin confirmation')),
      false,
    );

    // H2: Admin's recentSearches are NOT leaked to Alice
    assert.deepEqual(d.recentSearches, []);
  });

  // 3. Phase 2: C3 Data-Loss Regression & Write Isolation
  await t.test('C2 & C3: Member A saving her state does NOT delete Project P2 or its tasks/comments/files/events', async () => {
    const stateARes = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: memberAToken });
    const payloadA = stateARes.json;

    // Alice updates her task t1 title and adds a comment on t1
    payloadA.data.tasks[0].title = 'Alpha Task 1 (Updated by Alice)';
    payloadA.data.comments.push({
      id: 'c_alice_2',
      task: 't1',
      by: memberAId,
      at: Date.now(),
      text: 'Second comment on Alpha',
      re: {},
    });
    payloadA.data.recentSearches = ['alpha search'];

    const saveRes = await apiReq(srv.baseUrl, 'PUT', '/api/state', {
      token: memberAToken,
      body: payloadA,
    });
    assert.equal(saveRes.status, 200);

    // Verify Bob's Project P2 is 100% intact!
    const stateBRes = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: memberBToken });
    const dB = stateBRes.json.data;
    assert.deepEqual(
      dB.projects.map(p => p.id),
      ['p2'],
    );
    assert.deepEqual(
      dB.tasks.map(t => t.id),
      ['t2'],
    );
    assert.equal(dB.tasks[0].title, 'Omega Task 1');
    assert.deepEqual(
      dB.comments.map(c => c.id),
      ['c2'],
    );
    assert.deepEqual(
      dB.files.map(f => f.id),
      ['f2'],
    );
    assert.deepEqual(
      dB.events.map(e => e.id),
      ['ev2'],
    );
    assert.deepEqual(
      dB.savedViews.map(sv => sv.id),
      ['sv2'],
    );
    assert.deepEqual(
      dB.activity.map(a => a.id),
      ['act2'],
    );
    // Bob does not see Alice's recentSearches
    assert.deepEqual(dB.recentSearches, []);
  });

  // 4. Tampered PUT payload from Member A trying to escalate privileges or touch P2
  await t.test('C2, H3, H6: Tampered PUT from Member A cannot add herself to P2, create projects, invite members, or cross-assign B', async () => {
    const stateARes = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: memberAToken });
    const tampered = stateARes.json;

    // Attempt 1: Create a new unauthorized project 'p_hack'
    tampered.data.projects.push({
      id: 'p_hack',
      key: 'HACK',
      name: 'Unauthorized Project',
      members: [memberAId],
    });

    // Attempt 2: Inject herself into P2 and overwrite P2
    tampered.data.projects.push({
      id: 'p2',
      key: 'OMEGA',
      name: 'Hacked Omega',
      members: [memberAId, memberBId],
      perms: { [memberAId]: 'Full access' },
    });

    // Attempt 3: Modify P1 membership to add Bob and escalate her own workspace role to Owner
    tampered.data.projects[0].members = [memberAId, guestGId, memberBId];
    tampered.data.members = tampered.data.members.map(m => (m.id === memberAId ? { ...m, role: 'Owner' } : m));
    tampered.data.members.push({
      id: 'm_rogue',
      name: 'Rogue Guest',
      email: 'rogue@evil.com',
      role: 'Owner',
      status: 'active',
    });

    // Attempt 4: Assign P1 task t1 to Bob (who is not in P1) and add cross-project dependency on t2
    tampered.data.tasks[0].assignee = memberBId;
    tampered.data.tasks[0].deps = ['t2'];

    // Attempt 5: Inject a task into P2
    tampered.data.tasks.push({
      id: 't_hack',
      key: 'OMEGA-99',
      project: 'p2',
      title: 'Injected into P2',
      status: 'todo',
    });

    const res = await apiReq(srv.baseUrl, 'PUT', '/api/state', {
      token: memberAToken,
      body: tampered,
    });
    assert.equal(res.status, 200);

    // Check database truth via Admin state
    const adminCheck = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: adminToken });
    const ad = adminCheck.json.data;

    // 'p_hack' was not created
    assert.equal(
      ad.projects.some(p => p.id === 'p_hack'),
      false,
    );
    // P2 was not modified and Alice is not in P2
    const p2 = ad.projects.find(p => p.id === 'p2');
    assert.equal(p2.name, 'Project Omega');
    assert.deepEqual(p2.members, [memberBId]);

    // P1 membership was not modified by Alice
    const p1 = ad.projects.find(p => p.id === 'p1');
    assert.deepEqual(p1.members.sort(), [memberAId, guestGId].sort());

    // Alice is still 'Member' and 'm_rogue' was not created
    const aliceRow = ad.members.find(m => m.id === memberAId);
    assert.equal(aliceRow.role, 'Member');
    assert.equal(
      ad.members.some(m => m.id === 'm_rogue'),
      false,
    );

    // t1 assignee was scrubbed (since Bob is not in P1) and cross-project dep 't2' was dropped
    const t1 = ad.tasks.find(t => t.id === 't1');
    assert.equal(t1.assignee, null);
    assert.deepEqual(t1.deps, []);

    // 't_hack' was not created in P2
    assert.equal(
      ad.tasks.some(t => t.id === 't_hack'),
      false,
    );
  });

  // 5. Guest viewer permissions
  await t.test('Guest viewer on P1 can read P1 but cannot edit tasks or see emails', async () => {
    const getG = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: guestGToken });
    assert.equal(getG.status, 200);
    const dG = getG.json.data;

    assert.deepEqual(
      dG.projects.map(p => p.id),
      ['p1'],
    );
    assert.deepEqual(
      dG.tasks.map(t => t.id),
      ['t1'],
    );

    // Guest cannot see Alice's email
    const aliceInG = dG.members.find(m => m.id === memberAId);
    assert.equal(aliceInG.email, '');

    // Guest tries to edit task t1 title and delete task t1
    dG.tasks[0].title = 'Hacked by Guest Viewer';
    const putG = await apiReq(srv.baseUrl, 'PUT', '/api/state', { token: guestGToken, body: getG.json });
    assert.equal(putG.status, 200);

    // Verify t1 title was NOT changed
    const getA = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: memberAToken });
    assert.equal(getA.json.data.tasks[0].title, 'Alpha Task 1 (Updated by Alice)');
  });

  // 6. Phase 3: Admin Project Membership & Isolation Report Endpoints
  await t.test('Phase 3: Non-admins get 403 on /api/admin/* endpoints; Admin can assign/unassign members and view isolation report', async () => {
    // Member A cannot call admin endpoints
    const forb1 = await apiReq(srv.baseUrl, 'GET', '/api/admin/isolation-report', { token: memberAToken });
    assert.equal(forb1.status, 403);
    const forb2 = await apiReq(srv.baseUrl, 'PUT', '/api/admin/projects/p2/members', {
      token: memberAToken,
      body: { add: [{ id: memberAId, perm: 'Can edit' }] },
    });
    assert.equal(forb2.status, 403);

    // Admin fetches isolation report
    const repRes = await apiReq(srv.baseUrl, 'GET', '/api/admin/isolation-report', { token: adminToken });
    assert.equal(repRes.status, 200);
    const aliceRep = repRes.json.report.find(r => r.memberId === memberAId);
    assert.deepEqual(aliceRep.accessibleProjectIds, ['p1']);
    assert.deepEqual(
      aliceRep.isolatedFromProjects.map(p => p.id),
      ['p2'],
    );

    // Admin assigns Alice to P2 via PUT /api/admin/projects/p2/members
    const addRes = await apiReq(srv.baseUrl, 'PUT', '/api/admin/projects/p2/members', {
      token: adminToken,
      body: { add: [{ id: memberAId, perm: 'Can edit' }] },
    });
    assert.equal(addRes.status, 200);
    assert.ok(addRes.json.members.some(m => m.id === memberAId));

    // Alice now sees both P1 and P2 on her next GET /api/state!
    const getAAfterAdd = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: memberAToken });
    assert.deepEqual(
      getAAfterAdd.json.data.projects.map(p => p.id).sort(),
      ['p1', 'p2'],
    );

    // Admin removes Alice from P2 via PUT /api/admin/projects/p2/members
    const rmRes = await apiReq(srv.baseUrl, 'PUT', '/api/admin/projects/p2/members', {
      token: adminToken,
      body: { remove: [memberAId] },
    });
    assert.equal(rmRes.status, 200);

    // Alice is immediately isolated from P2 again
    const getAAfterRm = await apiReq(srv.baseUrl, 'GET', '/api/state', { token: memberAToken });
    assert.deepEqual(
      getAAfterRm.json.data.projects.map(p => p.id),
      ['p1'],
    );
  });
});
