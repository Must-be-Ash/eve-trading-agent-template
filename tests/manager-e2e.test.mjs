import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadManagerApi, startManagerFixture } from './helpers/manager-fixture.mjs';

const api = await loadManagerApi(`export * from './agent/lib/strategy-pack-runtime.ts';`);
let fixture;
before(async () => { fixture = await startManagerFixture(api, 'manager-e2e'); });
after(async () => { await fixture?.close(); });

// These contracts cross the actual HTTP handlers, schemas, durable transaction,
// and state projection. Store-only tests cannot catch request shape mismatches
// or lifecycle writes performed before a route rejects a stale action.
test('manager routes create, isolate, retire, archive, restore and reject replay/stale/locked actions', async () => {
  let state = await fixture.state();
  const mainId = state.activeWorkspaceId;
  const create = { action: 'create', name: 'Research', select: true, expectedRevision: state.revision, requestId: randomUUID() };
  let response = await fixture.post('/action', create);
  assert.equal(response.status, 200);
  state = response.body;
  const researchId = state.activeWorkspaceId;
  assert.notEqual(researchId, mainId);
  assert.equal((await fixture.post('/action', create)).status, 409);
  assert.equal((await fixture.post('/action', { action: 'select', workspaceId: mainId, expectedRevision: 0, requestId: randomUUID() })).status, 409);
  const other = await api.getPhotonWorkspaceState({ ...fixture.scope, threadId: 'imessage:other' });
  assert.equal(other.workspaces.length, 1);
  assert.notEqual(other.activeWorkspace.id, mainId);
  assert.equal((await fixture.post('/action', { action: 'select', workspaceId: other.activeWorkspace.id, expectedRevision: state.revision, requestId: randomUUID() })).status, 400);
  await api.savePhotonWorkspaceSession({ ...fixture.scope, workspaceId: researchId, generation: 1, sessionId: 'fixture-session' });
  const approval = await api.savePhotonApproval({ ...fixture.scope, workspaceId: researchId, workspaceGeneration: 1,
    sessionId: 'fixture-session', prompt: { approvalText: 'Buy 25 USD of BTC?', expiresAtMs: Date.now() + 60000, requestId: 'fixture-approval', toolName: 'coinbase_create_order' } });
  await api.activatePhotonApproval({ ...fixture.scope, approvalToken: approval.approvalToken });
  response = await fixture.post('/action', { action: 'start-fresh', workspaceId: researchId, expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /pending financial approval/);
  const denied = await api.claimPhotonApprovalDecision({ approvalToken: approval.approvalToken, decision: 'deny' });
  await api.completePhotonApprovalDecision({ recordKey: denied.delivery.recordKey, decision: 'deny' });
  response = await fixture.post('/action', { action: 'start-fresh', workspaceId: researchId, expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  state = response.body;
  assert.equal(state.workspaces.find(w => w.id === researchId).generation, 2);
  assert.equal(fixture.resetSessions.at(-1).sessionId, 'fixture-session');
  assert.equal(await api.savePhotonWorkspaceSession({ ...fixture.scope, workspaceId: researchId, generation: 1, sessionId: 'late-old-session' }), false);
  response = await fixture.post('/action', { action: 'archive', workspaceId: researchId, replacementWorkspaceId: mainId, expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  state = response.body;
  assert.equal(state.activeWorkspaceId, mainId);
  response = await fixture.post('/action', { action: 'restore', workspaceId: researchId, expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 200);
  assert.equal(response.body.activeWorkspaceId, mainId);
  assert.equal(response.body.workspaces.find(w => w.id === researchId).status, 'active');
  assert.equal((await fixture.request('/state', { managerToken: fixture.manager.managerToken }, { headers: { origin: 'https://attacker.example' } })).status, 403);
});

test('fresh X installation uses resolved receipt and creates paused durable resources; runtime controls enforce revisions', async () => {
  let state = await fixture.createInstalledPack();
  const workspace = state.workspaces.find(w => w.id === state.activeWorkspaceId);
  assert.equal(workspace.strategyPack.state, 'active');
  assert.equal(workspace.strategyPack.configuration.alerts, 'disabled');
  assert.equal(workspace.monitors.length, 1);
  assert.equal(workspace.monitors[0].lifecycleState, 'paused');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].authorization, 'Bearer fixture-x-token');
  const monitorId = workspace.monitors[0].monitorId;
  const resume = { action: 'monitor-resume', workspaceId: workspace.id, monitorId,
    expectedRoutingRevision: state.revision, expectedMonitorRevision: workspace.monitors[0].configurationRevision,
    requestId: randomUUID() };
  let response = await fixture.post('/runtime-action', resume);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  state = response.body;
  let monitor = state.workspaces.find(w => w.id === workspace.id).monitors[0];
  assert.equal(monitor.lifecycleState, 'enabled');
  assert.ok(monitor.nextOccurrenceAt);
  assert.equal((await fixture.post('/runtime-action', { ...resume, requestId: randomUUID() })).status, 409);
  response = await fixture.post('/runtime-action', { action: 'monitor-schedule', workspaceId: workspace.id, monitorId,
    expectedRoutingRevision: state.revision, expectedMonitorRevision: monitor.configurationRevision, requestId: randomUUID(),
    schedule: { kind: 'interval', anchor: new Date().toISOString(), everyMinutes: 30 } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  state = response.body;
  monitor = state.workspaces.find(w => w.id === workspace.id).monitors[0];
  assert.equal(monitor.schedule.everyMinutes, 30);
  const staleArchive = await fixture.post('/action', { action: 'archive', workspaceId: workspace.id,
    expectedRevision: state.revision - 1, requestId: randomUUID() });
  assert.equal(staleArchive.status, 409);
  state = await fixture.state();
  assert.equal(state.workspaces.find(w => w.id === workspace.id).status, 'active');
  assert.equal(state.workspaces.find(w => w.id === workspace.id).monitors[0].lifecycleState, 'enabled',
    'a rejected stale archive must not suspend an active monitor');
  response = await fixture.post('/action', { action: 'archive', workspaceId: workspace.id,
    expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 400, 'active session requires an explicit replacement');
  assert.equal((await fixture.state()).workspaces.find(w => w.id === workspace.id).monitors[0].lifecycleState, 'enabled');
  const replacementWorkspaceId = state.workspaces.find(w => w.id !== workspace.id && w.status === 'active').id;
  response = await fixture.post('/action', { action: 'archive', workspaceId: workspace.id, replacementWorkspaceId,
    expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  state = response.body;
  assert.equal(state.workspaces.find(w => w.id === workspace.id).monitors[0].lifecycleState, 'suspended_archived');
  response = await fixture.post('/action', { action: 'restore', workspaceId: workspace.id, expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 200);
  assert.equal(response.body.workspaces.find(w => w.id === workspace.id).monitors[0].lifecycleState, 'paused');
});

test('archive atomically rejects a concurrent registry edit or new financial approval without suspending work', async () => {
  let state = await fixture.state();
  const workspace = state.workspaces.find(w => w.name === 'Fixture X Monitor');
  const monitor = workspace.monitors[0];
  let result = await fixture.post('/runtime-action', { action: 'monitor-resume', workspaceId: workspace.id,
    monitorId: monitor.monitorId, expectedRoutingRevision: state.revision,
    expectedMonitorRevision: monitor.configurationRevision, requestId: randomUUID() });
  assert.equal(result.status, 200);
  state = result.body;
  const originalFetch = globalThis.fetch;
  async function duringArchiveCommit(interleave) {
    let intercepted = false;
    globalThis.fetch = async (input, init) => {
      if (!intercepted && String(input).startsWith(fixture.redis.url)) {
        const payload = JSON.parse(init.body);
        const commands = Array.isArray(payload[0]) ? payload : [payload];
        if (commands.some(command => String(command[0]).toLowerCase() === 'evalsha' &&
          Number(command[2]) > 2 && String(command[3]).startsWith('eve:photon:v1:workspace-registry:'))) {
          intercepted = true;
          await interleave();
        }
      }
      return originalFetch(input, init);
    };
    try {
      const response = await fixture.post('/action', { action: 'archive', workspaceId: workspace.id,
        expectedRevision: state.revision, requestId: randomUUID() });
      assert.equal(intercepted, true, 'interleave at the real Redis archive commit');
      assert.equal(response.status, 409, JSON.stringify(response.body));
      const unchanged = await fixture.state();
      assert.equal(unchanged.workspaces.find(w => w.id === workspace.id).status, 'active');
      assert.equal(unchanged.workspaces.find(w => w.id === workspace.id).monitors[0].lifecycleState, 'enabled');
      return unchanged;
    } finally { globalThis.fetch = originalFetch; }
  }
  state = await duringArchiveCommit(async () => {
    const renamed = await fixture.post('/action', { action: 'rename', name: 'Research Renamed',
      workspaceId: state.activeWorkspaceId, expectedRevision: state.revision, requestId: randomUUID() });
    assert.equal(renamed.status, 200);
  });
  let approval;
  state = await duringArchiveCommit(async () => {
    const active = state.workspaces.find(w => w.id === state.activeWorkspaceId);
    approval = await api.savePhotonApproval({ ...fixture.scope, workspaceId: active.id,
      workspaceGeneration: active.generation, sessionId: 'race-approval', prompt: {
        approvalText: 'Buy 25 USD of BTC?', expiresAtMs: Date.now() + 60000,
        requestId: 'race-request', toolName: 'coinbase_create_order' } });
    await api.activatePhotonApproval({ ...fixture.scope, approvalToken: approval.approvalToken });
  });
  const denied = await api.claimPhotonApprovalDecision({ approvalToken: approval.approvalToken, decision: 'deny' });
  await api.completePhotonApprovalDecision({ recordKey: denied.delivery.recordKey, decision: 'deny' });
  result = await fixture.post('/runtime-action', { action: 'monitor-pause', workspaceId: workspace.id,
    monitorId: monitor.monitorId, expectedRoutingRevision: state.revision,
    expectedMonitorRevision: state.workspaces.find(w => w.id === workspace.id).monitors[0].configurationRevision,
    requestId: randomUUID() });
  assert.equal(result.status, 200);
  assert.equal(result.body.workspaces.find(w => w.id === workspace.id).monitors[0].lifecycleState, 'paused');
});


test('start fresh preserves the installed pack while retiring its prior generation runtime', async () => {
  const state = await fixture.state();
  const workspace = state.workspaces.find(w => w.name === 'Fixture X Monitor');
  const scope = api.authorizePhotonWorkspaceControlPlaneStore({ principalId: fixture.scope.principalId,
    resource: 'manager', workspaceId: workspace.id });
  const prior = await api.resolveInteractiveStrategyPackRuntime({ scope, workspaceGeneration: workspace.generation });
  assert.ok(prior);
  const environment = { ...process.env, EVE_WORKSPACE_DISPATCH_ENABLED: '1', EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: '1' };
  const monitor = await api.getWorkspaceMonitor(scope, workspace.monitors[0].monitorId);
  const priorWorker = await api.prepareWorkspaceWorkerStrategyPackRuntime({ environment, scope, monitor });
  const response = await fixture.post('/action', { action: 'start-fresh', workspaceId: workspace.id,
    expectedRevision: state.revision, requestId: randomUUID() });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const fresh = response.body.workspaces.find(w => w.id === workspace.id);
  assert.equal(fresh.generation, workspace.generation + 1);
  assert.equal(fresh.strategyPack.state, 'active', 'clearing conversation history must preserve the installed pack');
  assert.equal(fresh.strategyPack.bindingRevision, workspace.strategyPack.bindingRevision);
  const current = await api.resolveInteractiveStrategyPackRuntime({ scope, workspaceGeneration: fresh.generation });
  assert.equal(current.snapshot.workspaceGeneration, fresh.generation);
  assert.deepEqual(current.pack, prior.pack);
  await assert.rejects(api.resolveInteractiveStrategyPackRuntime({ scope, workspaceGeneration: workspace.generation }), /strategy_pack_runtime_stale/);
  const worker = await api.prepareWorkspaceWorkerStrategyPackRuntime({ environment, scope, monitor });
  assert.equal(worker.snapshot.workspaceGeneration, fresh.generation);
  await assert.rejects(api.requireWorkspaceWorkerStrategyPackRuntime({ environment, scope, monitor,
    envelope: { capabilityRevision: priorWorker.snapshot.capabilityManifestRevision, sources: monitor.sources,
      strategyPack: priorWorker.snapshot } }), /strategy_pack_runtime_stale/);
  assert.equal(fresh.monitors[0].lifecycleState, 'paused');
});

test('pack HTTP installation rejects forged and cross-thread identity receipts, stale generations, and replays once', async () => {
  const state = await fixture.state();
  const source = state.workspaces.find(w => w.id === state.activeWorkspaceId);
  const resolved = await fixture.post('/resolve-x-identity', { profile: '@fixture_desk', requestId: randomUUID() });
  assert.equal(resolved.status, 200);
  const identity = resolved.body;
  const body = { action: 'strategy-pack-create', activateMonitorResourceIds: [], name: 'Identity Scope Test',
    configuration: { xIdentity: [identity.profileUrl, identity.username, identity.displayName, identity.numericUserId, 'confirmed'],
      monitoringObjective: 'Watch public comments about market liquidity.', topics: ['liquidity'], impactHypotheses: ['improving liquidity|BTC|up'] },
    expectedRoutingRevision: state.revision, packId: 'public-commentary-tracker', packVersion: '1.5.4',
    packMutationIdentity: state.packMutationIdentity, sourceWorkspaceGeneration: source.generation,
    sourceWorkspaceId: source.id, xIdentityResolutionReceipt: identity.resolutionReceipt };
  const otherManager = await api.mintPhotonWorkspaceManager({ ...fixture.scope, threadId: 'imessage:foreign-receipt' });
  const foreign = await fixture.post('/resolve-x-identity', { managerToken: otherManager.managerToken,
    profile: '@fixture_desk', requestId: randomUUID() });
  assert.equal(foreign.status, 200);
  for (const receipt of [undefined, { ...identity.resolutionReceipt, signature: '0'.repeat(64) }, foreign.body.resolutionReceipt]) {
    const rejected = await fixture.post('/pack-action', { ...body, xIdentityResolutionReceipt: receipt });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error, 'strategy_pack_invalid_request');
  }
  const stale = await fixture.post('/pack-action', { ...body, sourceWorkspaceGeneration: source.generation + 1 });
  assert.equal(stale.status, 409);
  assert.equal((await fixture.state()).workspaces.length, state.workspaces.length);
  const created = await fixture.post('/pack-action', body);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const replayed = await fixture.post('/pack-action', body);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.workspaces.length, state.workspaces.length + 1);
  assert.equal(replayed.body.packMutation.receipt.mutationId, created.body.packMutation.receipt.mutationId);
  assert.equal(replayed.body.workspaces.find(w => w.name === body.name).monitors[0].lifecycleState, 'paused');
});
