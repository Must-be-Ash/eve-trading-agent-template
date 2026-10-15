import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDockerProviderFixture } from '../tests/helpers/monitoring-docker-fixture.mjs';
import { createiMessageAdapter } from '@photon-ai/chat-adapter-imessage';
import { createPhotonSdkFixture, createLoopbackRedisTcp, dispatchPhotonFixtureMessage } from '../tests/helpers/monitoring-photon-fixture.mjs';
import { loadManagerApi, startManagerFixture } from '../tests/helpers/manager-fixture.mjs';

// Run after npm run build. The installed Eve compiler, local durable Workflow
// world, actual scheduler/evaluator, tools, manager and Photon routes all run.
// Fixtures replace only X/Gateway HTTP and Blob/Photon/Docker provider boundaries;
// no evaluator results, findings, outcomes or routing receipts are supplied.
test('compiled Eve workers produce isolated findings, settled budgets, delivered alerts and source-session replies', { timeout: 60_000 }, async (t) => {
  const inherited = {...process.env};
  for (const key of Object.keys(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|VERCEL|EVE_|PHOTON_|IMESSAGE_|COINBASE_|KV_|UPSTASH_|REDIS_)/u.test(key)) delete process.env[key];
  }
  t.after(()=>{ for(const key of Object.keys(process.env)) if(!(key in inherited)) delete process.env[key]; Object.assign(process.env,inherited); });
  const photon = createPhotonSdkFixture(createiMessageAdapter);
  const docker = createDockerProviderFixture();
  globalThis.__monitorDocker = docker;
  globalThis.__monitorPhoton = photon;
  const api = await loadManagerApi(`
    export * from './agent/schedules/monitors.ts';
    export * from './agent/lib/workspace-budget-ledger.ts';
    export * from './agent/lib/workspace-dispatch-budget.ts';
    export * from './agent/lib/workspace-finding-store.ts';
    export * from './agent/lib/workspace-state-store.ts';
    export * from './agent/lib/photon-alert-reply-store.ts';
    export { photonBot } from './agent/channels/photon.ts';
    export { default as alertChannel } from './agent/channels/photon-alert-app.ts';
    export { moduleMap } from './.output/.eve/compile/module-map.mjs';
    export { default as compiledManifest } from './.output/.eve/compile/compiled-agent-manifest.json';
  `, { plugins: [{ name: 'blob-fixture', setup(plugin) {
    plugin.onResolve({filter:/^@vercel\/blob$/}, ({path})=>({path,namespace:'blob-fixture'}));
    plugin.onLoad({filter:/.*/,namespace:'blob-fixture'},()=>({loader:'js',contents:'export const put=(...a)=>globalThis.__monitorBlob.put(...a);export const get=(...a)=>globalThis.__monitorBlob.get(...a);export const del=(...a)=>globalThis.__monitorBlob.del(...a);'}));
  }}, {name:'photon-fixture', setup(plugin) {
    plugin.onResolve({filter:/^@photon-ai\/chat-adapter-imessage$/},({path})=>({path,namespace:'photon-fixture'}));
    plugin.onLoad({filter:/.*/,namespace:'photon-fixture'},()=>({loader:'js',contents:'export const createiMessageAdapter=(...a)=>globalThis.__monitorPhoton.createiMessageAdapter(...a);'}));
  }}, {name:'docker-fixture', setup(plugin) {
    plugin.onResolve({filter:/^eve\/sandbox\/docker$/},({path})=>({path,namespace:'docker-fixture'}));
    plugin.onLoad({filter:/.*/,namespace:'docker-fixture'},()=>({loader:'js',contents:'export const docker=(...a)=>globalThis.__monitorDocker.docker(...a);'}));
  }}] });
  const { installBundledCompiledArtifacts } = await import('../node_modules/eve/dist/src/runtime/loaders/bundled-artifacts.js');
  installBundledCompiledArtifacts({manifest:api.compiledManifest,moduleMap:api.moduleMap});
  const { readFile, mkdtemp, rm } = await import('node:fs/promises');
  const { createWorld } = await import('../node_modules/eve/dist/src/compiled/@workflow/world-local/index.js');
  const { setWorld, workflowEntrypoint } = await import('../node_modules/eve/dist/src/internal/workflow/runtime.js');
  await import('../.output/server/_libs/eve+zod.mjs');
  const serverSource = await readFile(new URL('../.output/server/index.mjs', import.meta.url), 'utf8');
  const encoded = serverSource.match(/const workflowCode = Buffer.from\((\[[\s\S]*?\])\.join/)[1];
  const workflowCode = Buffer.from(JSON.parse(encoded).join(''), 'base64').toString('utf8');
  const worldDir = await mkdtemp(join(tmpdir(), 'eve-monitoring-world-'));
  const world = createWorld({ dataDir: worldDir, recoverActiveRuns: false });
  setWorld(world);
  world.registerHandler('__wkf_workflow_', workflowEntrypoint(workflowCode));
  t.after(async()=>{await world.close?.();await rm(worldDir,{recursive:true,force:true});});
  const { mockModel } = await import('eve/evals');
  const modelRequests = [];
  const rootPrompts = [];
  const model = mockModel({respond: request => {
    const jobMatch = request.userMessages.join('\n').match(/<hybrid-evidence-job-v1>\n([\s\S]*?)\n<\/hybrid-evidence-job-v1>/);
    if (!jobMatch) {
      rootPrompts.push(request.messages.map(message => message.text).join('\n'));
      return {text:'The Ten minute X alert describes Fixture Desk increasing market liquidity. Bitcoin could respond, but that response remains uncertain.',usage:{inputTokens:500,outputTokens:50}};
    }
    const envelope = JSON.parse(jobMatch[1]);
    const results = request.toolResults;
    if(results.some(r=>r.isError)) throw new Error('fixture_received_tool_error:'+JSON.stringify(results));
    const called = name => results.some(r=>r.name===name);
    let name, input;
    if (!called('read_hybrid_evidence_bundle')) { name='read_hybrid_evidence_bundle';input={}; }
    else if(called('complete_hybrid_evidence_job')) { name='final_output';input={jobId:envelope.job.jobId,state:'completed'}; }
    else if(envelope.definition.definitionId==='public-commentary-impact-actionability') {
      name='complete_hybrid_evidence_job';input={decisionJson:JSON.stringify({outcome:'accepted',marketView:{stance:'bullish',targets:[{displayName:'Bitcoin',symbol:'BTC',type:'crypto_asset'}]},confidence:'high',horizon:'days',rationale:'The statement explicitly announces improving liquidity, matching the configured Bitcoin hypothesis.',uncertainty:['The market response is uncertain.'],counterevidence:[]})};
    } else if(!called('decide_hybrid_evidence_research')) { name='decide_hybrid_evidence_research';input={decision:'report_now',reason:'The signed announcement supports a bounded fixture research brief.'}; }
    else {
      name='complete_hybrid_evidence_job';input={disposition:'accepted',unknowns:[],citations:envelope.citableLocators,fields:{title:'Fixture Desk announces more market liquidity',confidence:'medium',interpretation:'Fixture Desk announced increased market liquidity, which could support Bitcoin.',implications:['Watch Bitcoin for a response to the liquidity announcement.'],materialFacts:[{statement:'Fixture Desk announced increased market liquidity.',sourceUrls:['https://x.com/fixture_desk/status/101']}],research:{status:'not_needed'},sources:[{role:'official',label:'Fixture Desk statement',url:'https://x.com/fixture_desk/status/101'}],uncertainty:['The eventual market response remains uncertain.']}};
    }
    modelRequests.push({jobId:envelope.job.jobId,definition:envelope.definition.definitionId,tool:name});
    return {toolCalls:[{name,input}],usage:{inputTokens:1000,outputTokens:100}};
  }});
  const objects = new Map();
  globalThis.__monitorBlob = {
    async put(path, bytes, options) { objects.set(path, Buffer.from(bytes)); return {url:'https://fixture.private.blob.vercel-storage.com/'+path}; },
    async get(path, options) { const bytes=objects.get(path); return bytes?{statusCode:200,stream:new Response(bytes).body}:null; },
    async del(path) { objects.delete(path); }
  };
  const fixture = await startManagerFixture(api, 'iMessage;-;+15555550123');
  const redisTcp = await createLoopbackRedisTcp(fixture.redis);
  t.after(async()=>{
    docker.close();
    delete globalThis.__monitorDocker;
    delete globalThis.__monitorPhoton;
    delete globalThis.__monitorBlob;
  });
  const settings = {
    REDIS_URL: redisTcp.url,
    EVE_HYBRID_EVIDENCE_READ_WRITE_TOKEN: 'fixture-private-store-token',
    AI_GATEWAY_API_KEY: 'fixture-gateway-key',
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
  const { createBundledRuntimeCompiledArtifactsSource } = await import('../node_modules/eve/dist/src/runtime/compiled-artifacts-source.js');
  const { getCompiledRuntimeAgentBundle } = await import('../node_modules/eve/dist/src/runtime/sessions/compiled-agent-cache.js');
  const { prewarmSandboxes } = await import('../node_modules/eve/dist/src/execution/sandbox/prewarm.js');
  const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  await prewarmSandboxes({ appRoot:fileURLToPath(new URL('../',import.meta.url)),
    compileDirectoryPath:fileURLToPath(new URL('../.output/.eve/compile',import.meta.url)),
    compiledArtifactsSource,graph:bundle.graph });
  const managerFetch = globalThis.fetch;
  const timelineRequests = [];
  let timeline = () => ({ meta: { result_count: 0 } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === 'https://api.x.com' && url.pathname === '/2/users/123456789/tweets') {
      timelineRequests.push(url);
      return Response.json(timeline(url));
    }
    if (url.origin === 'https://ai-gateway.vercel.sh' && url.pathname === '/v4/ai/language-model') {
      const result = await model.doStream(JSON.parse(init.body));
      const chunks = [];
      for await (const chunk of result.stream) {
        if (chunk.type === 'finish') chunk.providerMetadata = { gateway: { cost: '0' } };
        chunks.push('data: '+JSON.stringify(chunk)+'\n\n');
      }
      return new Response(chunks.join(''), {headers:{'content-type':'text/event-stream'}});
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
    const installed = await fixture.createInstalledPack({ name, configuration: { cadenceMinutes, alerts: 'enabled' } });
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
      .filter(row => row.recordType === 'workspace_run_outcome' && row.workspaceId === entry.workspaceId);
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
    timeline = url => ({ data: [{ id: '101', author_id: '123456789', conversation_id: '101', created_at: '2026-10-15T19:59:00.000Z', edit_controls: { editable_until: '2026-10-15T19:59:01.000Z' }, edit_history_tweet_ids: ['101'], text: 'We are increasing market liquidity today.' }], meta: { result_count: 1 } });
    await Promise.all([tick(), tick()]);
    assert.equal(timelineRequests.length, 2, 'concurrent scheduler ticks claim each real occurrence once');
    assert.deepEqual(timelineRequests.map(url => url.searchParams.get('start_time')).sort(),
      ['2026-10-15T19:30:00.000Z', '2026-10-15T19:50:00.000Z']);
    for (const entry of [fast, slow]) {
      const records = await outcomes(entry);
      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, 'finding_staged');
      assert.ok(records[0].finding);
      assert.equal(records[0].checkpoint.watermark, '2026-10-15T20:00:00.000Z');
      const monitor = await api.getWorkspaceMonitor(entry.scope, entry.monitorId);
      assert.equal(monitor.sourceCheckpoint.watermark, records[0].checkpoint.watermark);
      assert.equal(monitor.lifecycleState, 'enabled');
      const ledger = await api.readWorkspaceBudgetLedger(entry.scope);
      assert(ledger.reservations.every(row => row.state === 'reconciled'));
      const children = ledger.reservations.filter(row => row.kind === 'hybrid_model_attempt');
      assert.deepEqual(children.map(row => row.reconciledInputTokens).sort((a,b)=>a-b), [3000,4000]);
      assert.deepEqual(children.map(row => row.reconciledOutputTokens).sort((a,b)=>a-b), [300,400]);
      // Research intentionally retains its conservative paid ceiling when the drain cannot meter all research tools.
      assert.deepEqual(children.map(row => row.reconciledPaidMicros).sort(), ['0','250000']);
    }
    await tick();
    assert.equal(timelineRequests.length, 2, 'completed windows do not run again');
    assert.equal(modelRequests.length, 14, 'two semantic and two research workers settle once');
    const globalLedger = await api.readGlobalDispatchBudgetLedger();
    const globalChildren = globalLedger.reservations.filter(row => row.kind === 'hybrid_model_attempt');
    assert.equal(globalChildren.length, 4);
    assert(globalChildren.every(row => row.state === 'settled'), 'successful children release global concurrency reservations');
    assert.equal(globalChildren.reduce((sum,row)=>sum+row.reconciledInputTokens,0), 14000);
    assert.equal(globalChildren.reduce((sum,row)=>sum+row.reconciledOutputTokens,0), 1400);
    assert.equal(globalChildren.reduce((sum,row)=>sum+BigInt(row.reconciledPaidMicros),0n), 500000n);
    assert.equal(photon.messages.length, 2);
    assert.equal(photon.cards.length, 2, 'each source session delivers exactly one discuss card');
    const recentKeys = await fixture.redis.command('KEYS', 'eve:photon:v1:alert-reply:recent:*');
    assert.equal(recentKeys.length, 1);
    const recent = JSON.parse(await fixture.redis.command('GET', recentKeys[0]));
    assert.equal(recent.length, 2, 'digit-first provider IDs are remembered after delivery');
    const fastAlert = recent.find(row => row.workspaceId === fast.workspaceId);
    assert.ok(fastAlert);
    const fastCard = photon.cards.find(card => card.id === fastAlert.deliveryMessageId);
    const discuss = api.alertChannel.routes.find(route => route.method === 'POST');
    const discussion = await discuss.handler(new Request('https://template.example'+discuss.path, {
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({alertToken:new URL(fastCard.url).hash.slice(1).split('.')[0]})
    }));
    assert.equal(discussion.status, 200, await discussion.text());
    assert.equal((await fixture.state()).activeWorkspaceId, fast.workspaceId);
    const inbound = await dispatchPhotonFixtureMessage({text:'Explain the alert',webhookSecret:photon.webhookSecret});
    assert.equal(inbound.response.status, 200);
    async function ingressRecords(kind) {
      const keys = await fixture.redis.command('KEYS',`eve:photon:v1:ingress-control:${kind}:*`);
      return Promise.all(keys.map(async key=>JSON.parse(await fixture.redis.command('GET',key))));
    }
    let replyDeliveries = [], dispatches = [];
    for (let attempt=0; attempt<100; attempt++) {
      [replyDeliveries,dispatches] = await Promise.all([ingressRecords('response'),ingressRecords('dispatch')]);
      if (replyDeliveries[0]?.state==='delivered' && dispatches[0]?.state==='completed') break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(replyDeliveries.length,1);
    assert.equal(replyDeliveries[0].state,'delivered','reply has a durable delivered receipt');
    assert.equal(dispatches.length,1);
    assert.equal(dispatches[0].state,'completed','reply workflow has a durable completed dispatch');
    assert.equal(rootPrompts.length, 1, 'signed webhook reaches the real conversation worker');
    assert(rootPrompts[0].includes('Fixture Desk announces more market liquidity'));
    const assignmentKeys = await fixture.redis.command('KEYS','eve:photon:v1:ingress-control:assignment:*');
    assert.equal(assignmentKeys.length,1);
    const assignment=JSON.parse(await fixture.redis.command('GET',assignmentKeys[0]));
    assert.equal(assignment.workspaceId,fast.workspaceId);
    assert.equal(assignment.reason,'discuss_action');
    assert.equal(assignment.immutable,true);
    assert(photon.messages.some(({message})=>JSON.stringify(message).includes('The Ten minute X alert describes')),
      'actual channel handler delivers the conversation model response through the SDK boundary');
    assert(docker.calls.filter(call=>call.operation==='spawn').every(call=>call.command === 'printf \'%s\\n\' "$HOME"'),
      'the sandbox fixture permits only the framework home-directory query');
    console.log('MONITORING_ACCEPTANCE',JSON.stringify({sessions:2,sourceReads:timelineRequests.length,workerModelCalls:modelRequests.length,
      findings:2,globalChildrenSettled:globalChildren.length,fixtureModelInputTokens:14000,fixtureModelOutputTokens:1400,
      conservativeResearchPaidMicros:500000,liveSpend:0,deliveredCards:photon.cards.length,replyWorkspace:assignment.workspaceId,replyDelivered:true}));
  } finally {
    for (const entry of owned) await pause(entry).catch(() => {});
    try { await api.photonBot.shutdown(); } finally {
      await redisTcp.close();
      globalThis.fetch = managerFetch;
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await fixture.close();
    }
  }
});
