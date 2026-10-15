import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadManagerApi, startManagerFixture } from './helpers/manager-fixture.mjs';

// Protect the assembled manager -> scheduling -> evaluation -> durable result
// contract. Previous scheduler tests supplied evaluator results themselves;
// these fixtures replace only X HTTP responses and retain every product layer.
test('manager-installed X monitors run the real scheduler and evaluator with isolated durable outcomes', async (t) => {
  const api = await loadManagerApi(`
    export * from './agent/schedules/monitors.ts';
    export * from './agent/lib/workspace-budget-ledger.ts';
    export * from './agent/lib/workspace-dispatch-budget.ts';
    export * from './agent/lib/workspace-finding-store.ts';
    export * from './agent/lib/workspace-state-store.ts';
  `);
  const fixture = await startManagerFixture(api, 'scheduled-monitoring-e2e');
  const settings = {
    EVE_WORKSPACE_RUNTIME_AUTH_SECRET: 'W'.repeat(43),
    EVE_HYBRID_EVIDENCE_AUTH_SECRET: 'H'.repeat(43),
    EVE_WORKSPACE_DISPATCH_ENABLED: '1', EVE_WORKSPACE_PAID_RESEARCH_ENABLED: '1',
    EVE_PHOTON_WORKSPACE_ALERTS_ENABLED: '1', EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: '1',
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: '1', EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: '1',
    EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: '1', EVE_X_MONITOR_EXECUTION_ENABLED: '1',
    EVE_HYBRID_EVIDENCE_ENABLED: '1', EVE_HYBRID_SEMANTIC_REASONING_ENABLED: '1',
    EVE_PUBLIC_COMMENTARY_EVIDENCE_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
    EVE_PUBLIC_COMMENTARY_EVIDENCE_KEY_REFERENCE: 'kms://fixture/evidence-v1',
    EVE_HYBRID_FAST_MODEL_ID: 'google/gemini-3.7-flash', EVE_HYBRID_FRONTIER_MODEL_ID: 'openai/gpt-5.4-mini',
    EVE_HYBRID_FAST_MODEL_REASONING: 'low', EVE_HYBRID_FRONTIER_MODEL_REASONING: 'high',
    EVE_STRATEGY_PACK_WORKER_MODEL_ID: 'openai/gpt-5.4-mini',
    EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: 'google/gemini-3.7-flash,openai/gpt-5.4-mini',
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const managerFetch = globalThis.fetch;
  const timelineRequests = [];
  let timeline = () => ({ meta: { result_count: 0 } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === 'https://api.x.com' && url.pathname === '/2/users/123456789/tweets') {
      timelineRequests.push(url);
      return Response.json(timeline(url));
    }
    return managerFetch(input, init);
  };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T20:00:00.000Z') });
  async function tick() {
    let pending;
    api.createWorkspaceMonitorSchedule().run({ waitUntil: promise => { pending = promise; } });
    await pending;
  }
  const owned = [];
  async function install(name, cadenceMinutes) {
    let installed = await fixture.createInstalledPack({ name, configuration: { cadenceMinutes, alerts: 'enabled' } });
    if (name === 'Ten minute X') {
      const fresh = await fixture.post('/action', { action: 'start-fresh', workspaceId: installed.activeWorkspaceId,
        expectedRevision: installed.revision, requestId: randomUUID() });
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      installed = fresh.body;
    }
    const workspace = installed.workspaces.find(w => w.id === installed.activeWorkspaceId);
    assert.equal(workspace.monitors.length, 1);
    const monitor = workspace.monitors[0];
    assert.equal(monitor.lifecycleState, 'paused');
    const scope = api.authorizePhotonWorkspaceControlPlaneStore({ principalId: fixture.scope.principalId,
      resource: 'manager', workspaceId: workspace.id });
    const entry = { workspaceId: workspace.id, monitorId: monitor.monitorId, scope };
    owned.push(entry);
    const resumed = await fixture.post('/runtime-action', {
      action: 'monitor-resume', requestId: randomUUID(), expectedRoutingRevision: installed.revision,
      expectedMonitorRevision: monitor.configurationRevision, workspaceId: workspace.id, monitorId: monitor.monitorId,
    });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    return entry;
  }
  async function outcomes(entry) {
    const keys = await fixture.redis.command('KEYS', 'eve:workspace-runtime:v1:run-outcome:*');
    return (await Promise.all(keys.map(async key => JSON.parse(await fixture.redis.command('GET', key)))))
      .filter(row => row.workspaceId === entry.workspaceId);
  }
  async function pause(entry) {
    const state = await fixture.state();
    const monitor = state.workspaces.find(w => w.id === entry.workspaceId)?.monitors.find(m => m.monitorId === entry.monitorId);
    if (!monitor || monitor.lifecycleState !== 'enabled') return;
    const result = await fixture.post('/runtime-action', { action: 'monitor-pause', requestId: randomUUID(),
      expectedRoutingRevision: state.revision, expectedMonitorRevision: monitor.configurationRevision,
      workspaceId: entry.workspaceId, monitorId: entry.monitorId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  try {
    const fast = await install('Ten minute X', 'minutes_10');
    const slow = await install('Thirty minute X', 'minutes_30');
    process.env.EVE_WORKSPACE_PAID_RESEARCH_ENABLED = '0';
    await tick();
    assert.equal(timelineRequests.length, 0, 'the paid research kill switch prevents provider calls');
    assert.equal((await api.readGlobalDispatchBudgetLedger()).reservations.length, 0,
      'disabled paid research leaves due occurrences and budgets untouched');
    assert.equal((await api.getWorkspaceMonitor(fast.scope, fast.monitorId)).lastRunAt, null);
    process.env.EVE_WORKSPACE_PAID_RESEARCH_ENABLED = '1';
    await Promise.all([tick(), tick()]);
    assert.equal(timelineRequests.length, 2, 'concurrent scheduler ticks claim each real occurrence once');
    assert.deepEqual(timelineRequests.map(url => url.searchParams.get('start_time')).sort(),
      ['2026-10-15T19:30:00.000Z', '2026-10-15T19:50:00.000Z']);
    for (const entry of [fast, slow]) {
      const records = await outcomes(entry);
      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, 'no_match');
      assert.equal(records[0].finding, null);
      assert.equal(records[0].checkpoint.watermark, '2026-10-15T20:00:00.000Z');
      const monitor = await api.getWorkspaceMonitor(entry.scope, entry.monitorId);
      assert.equal(monitor.sourceCheckpoint.watermark, records[0].checkpoint.watermark);
      assert.equal(monitor.lifecycleState, 'enabled');
      const ledger = await api.readWorkspaceBudgetLedger(entry.scope);
      assert(ledger.reservations.every(row => row.state === 'reconciled'));
      assert(ledger.reservations.every(row => row.reconciledPaidMicros === '0'));
    }
    await tick();
    assert.equal(timelineRequests.length, 2, 'completed windows do not run again');
    t.mock.timers.tick(10 * 60_000);
    await tick();
    assert.equal(timelineRequests.length, 3, 'only the ten-minute session is due');
    assert.equal((await outcomes(fast)).length, 2);
    assert.equal((await outcomes(slow)).length, 1);
    await pause(fast);
    await pause(slow);

    const overflow = await install('Bounded pagination', 'minutes_10');
    timeline = () => ({ meta: { result_count: 0, next_token: 'more-fixture-pages' } });
    const beforeOverflow = timelineRequests.length;
    await tick();
    assert.equal(timelineRequests.length - beforeOverflow, 2, 'pagination never exceeds its two-page bound');
    assert.equal((await outcomes(overflow)).length, 0, 'partial source coverage cannot become a completed no-match');
    assert.equal((await api.getWorkspaceMonitor(overflow.scope, overflow.monitorId)).sourceCheckpoint.watermark, null);
    await tick();
    const held = await api.getWorkspaceMonitor(overflow.scope, overflow.monitorId);
    assert.equal(held.lifecycleState, 'paused_failure');
    assert.equal(timelineRequests.length - beforeOverflow, 2, 'recovery does not repeat an uncertain acquisition');
    assert((await fixture.redis.command('KEYS', '*pagination*')).length > 0, 'bounded pages remain durable for inspection');

    const unknown = await install('Unknown source acceptance', 'minutes_10');
    timeline = () => { throw new TypeError('fixture_transport_unknown'); };
    const beforeUnknown = timelineRequests.length;
    await tick();
    const unknownBudget = await api.readWorkspaceBudgetLedger(unknown.scope);
    assert(unknownBudget.reservations.some(row => row.kind === 'paid_source_attempt' && row.state === 'uncertain'),
      'a provider transport failure retains its uncertain paid reservation');
    await tick();
    assert.equal(timelineRequests.length - beforeUnknown, 1, 'recovery does not repeat a provider call with unknown acceptance');
    assert.equal((await outcomes(unknown)).length, 0);
    assert.equal((await api.getWorkspaceMonitor(unknown.scope, unknown.monitorId)).sourceCheckpoint.watermark, null);

    const blocked = await install('Zero session budget', 'minutes_10');
    const budget = await api.readWorkspaceDocument('budget', blocked.scope);
    await api.writeWorkspaceDocument('budget', { scope: blocked.scope, expectedRevision: budget.revision,
      value: { ...budget.value, maximumPaidPerCall: '0', maximumPaidPerDay: '0', maximumPaidPerMonth: '0' } });
    const beforeBlocked = timelineRequests.length;
    await tick();
    assert.equal(timelineRequests.length, beforeBlocked, 'a zero paid allowance denies before the X provider boundary');
    assert.equal((await outcomes(blocked)).length, 0);
  } finally {
    for (const entry of owned) await pause(entry).catch(() => {});
    globalThis.fetch = managerFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fixture.close();
  }
});
