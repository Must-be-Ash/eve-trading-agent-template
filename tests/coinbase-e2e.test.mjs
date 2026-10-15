import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { mockModel } from 'eve/evals';
import { startTestRedis } from './helpers/photon-redis.mjs';

// Value: the real Eve approval park/resume must reach the actual Photon card and
// HTTP decision route before a financial mutation. Isolated execute/store tests
// cannot catch breaks in that composition. Only model and external providers
// are fixtures; no application approval, store, or policy owner is replaced.
const root = fileURLToPath(new URL('../', import.meta.url));
const eveRoot = new URL('../node_modules/eve/dist/src/', import.meta.url);
const { createToolLoopHarness } = await import(new URL('harness/tool-loop.js', eveRoot));
const { dispatchDynamicToolEvent } = await import(new URL('context/dynamic-tool-lifecycle.js', eveRoot));
const { createToolExecuteWithAuth } = await import(new URL('execution/tool-auth.js', eveRoot));
const { ContextContainer, contextStorage } = await import(new URL('context/container.js', eveRoot));
const { SessionKey, AuthKey, SessionIdKey, InitiatorAuthKey } = await import(new URL('context/keys.js', eveRoot));
const directory = await mkdtemp(join(root, 'tests/.coinbase-e2e-'));
const file = join(directory, 'app.mjs');
const fixtures = `
  import { createiMessageAdapter } from '@photon-ai/chat-adapter-imessage';
  export const fixture = { calls: [], cards: [], outcome: 'success', productType: 'SPOT', order: null };
  export async function listCoinbaseMcpTools() {
    return ['coinbase_balance', 'coinbase_orders_create', 'coinbase_transfer'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));
  }
  export async function callCoinbaseMcpTool(name, input) {
    fixture.calls.push({ name, input: structuredClone(input) });
    if (name === 'coinbase_balance') return { accounts: [{ currency: 'USD', available_balance: { value: '125.50', currency: 'USD' } }] };
    if (name === 'coinbase_products_get') return { product_type: fixture.productType, status: 'ONLINE' };
    if (name === 'coinbase_orders_preview') return { commission_total: '0.01', quote_size: input.quote_size };
    if (name === 'coinbase_orders_get') return fixture.order;
    if (fixture.outcome === 'unknown') throw new Error('Transport timed out; completion state is unknown');
    if (name === 'coinbase_orders_create') return { success: true, order_id: 'f9ef2d74-e445-4bc5-86c2-c3a192337d6e', client_order_id: input.client_order_id };
    if (name === 'coinbase_orders_cancel') return { results: [{ order_id: input.order_ids[0], success: true }] };
    throw new Error('Unexpected fixture provider call: ' + name);
  }
  export function createPhotonImessageAdapter() {
    const adapter = createiMessageAdapter({ credentials: async () => { throw new Error('Fixture must never request Photon credentials'); }, webhookSecret: 'offline-fixture' });
    adapter.sendMiniApp = async (threadId, url) => { fixture.cards.push({ threadId, url }); };
    return adapter;
  }
`;
await build({
  absWorkingDir: root, stdin: { contents: `
    export { default as photon } from './agent/channels/photon.ts';
    export { default as approvalApp } from './agent/channels/photon-approval-app.ts';
    export { default as dynamicTools } from './agent/tools/coinbase_mcp.ts';
    export { default as previewTool } from './agent/tools/coinbase_preview_order.ts';
    export { default as createTool } from './agent/tools/coinbase_create_order.ts';
    export { default as cancelTool } from './agent/tools/coinbase_cancel_order.ts';
    export * from './agent/lib/photon-workspace-store.ts';
    export * from './agent/lib/photon-workspace.ts';
    export * from './agent/lib/photon-auth.ts';
    export * from './agent/lib/photon-approval-store.ts';
    export * from './agent/lib/workspace-runtime-scope.ts';
    export { fixture } from 'coinbase-e2e-provider-fixtures';
  `, resolveDir: root, loader: 'ts' }, outfile: file, bundle: true,
  packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'external-provider-fixtures', setup(plugin) {
    plugin.onResolve({ filter: /(?:^coinbase-e2e-provider-fixtures$|\/coinbase-mcp$|\/photon-imessage-adapter$)/ }, () => ({ path: 'providers', namespace: 'fixtures' }));
    plugin.onLoad({ filter: /.*/, namespace: 'fixtures' }, () => ({ contents: fixtures, loader: 'js', resolveDir: root }));
  } }],
});
const app = await import(pathToFileURL(file));
const OWNER = 'imessage:+15555550100';
const ORDER = { productId: 'BTC-USD', side: 'BUY', type: 'market', quoteSize: '10.00' };
const ORDER_ID = 'f9ef2d74-e445-4bc5-86c2-c3a192337d6e';
const envNames = ['PHOTON_ALLOWED_PRINCIPALS', 'COINBASE_ALLOWED_PRINCIPALS', 'COINBASE_KEY_ID', 'COINBASE_KEY_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'EVE_DEPLOYMENT_OWNER_ID', 'EVE_OWNER_ALIAS_HMAC_SECRET', 'PUBLIC_APP_URL'];
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
let redis;
const realFetch = globalThis.fetch;
before(async () => {
  redis = await startTestRedis();
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== redis.url) throw new Error(`Unexpected non-fixture network request: ${url.origin}`);
    return realFetch(input, options);
  };
  Object.assign(process.env, { PHOTON_ALLOWED_PRINCIPALS: OWNER, COINBASE_ALLOWED_PRINCIPALS: OWNER,
    COINBASE_KEY_ID: 'offline-key', COINBASE_KEY_SECRET: 'offline-signing-secret',
    KV_REST_API_URL: redis.url, KV_REST_API_TOKEN: redis.token,
    EVE_DEPLOYMENT_OWNER_ID: 'offline-owner', EVE_OWNER_ALIAS_HMAC_SECRET: Buffer.alloc(32, 1).toString('base64url'),
    PUBLIC_APP_URL: 'https://fixture.example' });
});
after(async () => {
  globalThis.fetch = realFetch;
  await redis?.close();
  await rm(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
function route(suffix) { return app.approvalApp.routes.find(route => route.method === 'POST' && route.path === `/eve/v1/photon-approval/${suffix}`).handler; }
function post(suffix, body) { return new Request(`https://fixture.example/eve/v1/photon-approval/${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
function mutations() { return app.fixture.calls.filter(call => ['coinbase_orders_create', 'coinbase_orders_cancel'].includes(call.name)); }

async function scenario(name, { cancel = false, changedOrder = false } = {}) {
  app.fixture.calls.length = 0;
  app.fixture.cards.length = 0;
  app.fixture.outcome = 'success';
  app.fixture.productType = 'SPOT';
  app.fixture.order = { order_id: ORDER_ID, product_id: 'BTC-USD', status: 'OPEN' };
  const scope = { principalId: OWNER, threadId: `imessage:coinbase-e2e-${name}` };
  const state = await app.getPhotonWorkspaceState(scope);
  const workspace = state.activeWorkspace;
  const sessionId = `session-${name}`;
  assert.equal(await app.savePhotonWorkspaceSession({ ...scope, workspaceId: workspace.id, generation: workspace.generation, sessionId }), true);
  const auth = app.photonAuth('+15555550100', scope.threadId, app.projectPhotonWorkspaceRuntimeScope({ ...scope, workspaceId: workspace.id, generation: workspace.generation }));
  const ctx = new ContextContainer();
  ctx.set(SessionKey, { sessionId, auth: { current: auth, initiator: auth }, turn: { id: 'turn-1' } });
  ctx.set(AuthKey, auth);
  ctx.set(InitiatorAuthKey, auth);
  ctx.set(SessionIdKey, sessionId);
  const events = [];
  const posts = [];
  const channel = { thread: { id: app.photonWorkspaceThreadId(scope.threadId, workspace), post: async value => { posts.push(value); } }, state: {} };
  let modelToolResults = [];
  const model = mockModel(({ toolResults, tools }) => {
    modelToolResults = toolResults;
    assert.ok(tools.some(tool => tool.name === 'coinbase_balance'));
    assert.equal(tools.some(tool => tool.name === 'coinbase_orders_create' || tool.name === 'coinbase_transfer'), false);
    if (!toolResults.some(result => result.name === 'coinbase_balance')) {
      return { toolCalls: [{ id: `balance-${name}`, name: 'coinbase_balance', input: {} }] };
    }
    if (cancel) return toolResults.some(result => result.name === 'coinbase_cancel_order')
      ? 'Cancellation reviewed.' : { toolCalls: [{ id: `cancel-${name}`, name: 'coinbase_cancel_order', input: { order_id: ORDER_ID } }] };
    const preview = toolResults.find(result => result.name === 'coinbase_preview_order');
    if (!preview) return { toolCalls: [{ id: `preview-${name}`, name: 'coinbase_preview_order', input: ORDER }] };
    if (toolResults.some(result => result.name === 'coinbase_create_order')) return 'Order reviewed.';
    const token = preview.output.authorization.previewToken;
    return { toolCalls: [{ id: `create-${name}`, name: 'coinbase_create_order', input: { ...ORDER, ...(changedOrder ? { quoteSize: '11.00' } : {}), previewToken: token } }] };
  });
  const definitions = [['coinbase_preview_order', app.previewTool], ['coinbase_create_order', app.createTool], ['coinbase_cancel_order', app.cancelTool]];
  const tools = new Map(definitions.map(([name, tool]) => [name, { ...tool, name, execute: createToolExecuteWithAuth({ scope: name, execute: tool.execute }) }]));
  const harness = createToolLoopHarness({ mode: 'conversation', capabilities: { requestInput: true }, tools,
    resolveModel: async () => model,
    handleEvent: async (event, messages = []) => {
      events.push(event);
      await dispatchDynamicToolEvent({ ctx, event, messages, resolvers: [{ slug: 'coinbase_mcp', logicalPath: 'agent/tools/coinbase_mcp.ts', eventNames: ['step.started'], events: app.dynamicTools.events }] });
      if (['input.requested', 'message.completed', 'turn.completed', 'turn.failed'].includes(event.type)) {
        await app.photon.adapter[event.type]?.(event.data, channel);
      }
    },
  });
  let session = { sessionId, continuationToken: channel.thread.id, history: [],
    agent: { modelReference: { id: 'offline-model', provider: 'eve-mock' }, system: 'Fixture: use the available order tools.', tools: [] },
    compaction: { threshold: 100000, recentWindowSize: 20 } };
  async function run(input) {
    let step = harness;
    for (let index = 0; index < 8; index++) {
      const result = await contextStorage.run(ctx, () => step(session, input));
      session = JSON.parse(JSON.stringify(result.session));
      if (typeof result.next !== 'function') return result;
      step = result.next;
      input = undefined;
    }
    throw new Error('Fixture model exceeded bounded harness steps');
  }
  await run({ message: cancel ? 'Cancel my exact open order.' : 'Buy 10 USD of BTC, after I approve.' });
  const pending = events.find(event => event.type === 'input.requested');
  assert.ok(pending, JSON.stringify(events));
  assert.equal(app.fixture.cards.length, 1, JSON.stringify(posts));
  assert.equal(app.fixture.cards[0].threadId, scope.threadId);
  const token = new URL(app.fixture.cards[0].url).hash.slice(1);
  assert.equal(mutations().length, 0, 'the harness must park without a financial write');
  const deliveries = [];
  const args = { attachSession: id => ({ respond: async (inputResponses, options) => {
    assert.equal(id, sessionId);
    assert.equal(options.auth.principalId, OWNER);
    assert.equal(options.auth.attributes.workspace_id, workspace.id);
    deliveries.push({ id, inputResponses, auth: options.auth });
    await run({ inputResponses });
    return { status: 'accepted', sessionId: id };
  } }) };
  return { scope, workspace, sessionId, token, events, posts, pending, deliveries, run,
    get modelToolResults() { return modelToolResults; },
    async decide(decision = 'approve') { const response = await route('decision')(post('decision', { approvalToken: token, decision }), args); return { status: response.status, body: await response.json() }; },
    async state() { return (await route('state')(post('state', { approvalToken: token }))).json(); },
  };
}

test('actual Eve approval pause resumes through the Photon card and decision route for exact create and cancellation', async () => {
  const order = await scenario('approved');
  assert.equal(app.fixture.calls[0].name, 'coinbase_balance');
  assert.equal((await order.state()).approvalText, 'Buy 10.00 USD of BTC?');
  assert.deepEqual(await order.decide(), { status: 200, body: { status: 'approved' } });
  assert.equal(mutations().length, 1);
  const { client_order_id, ...nativeOrder } = mutations()[0].input;
  assert.match(client_order_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(nativeOrder, { product_id: 'BTC-USD', side: 'BUY', type: 'market', quote_size: '10.00' });
  assert.equal(order.deliveries.length, 1);
  assert.equal(await app.getCurrentPhotonApprovalActivity(order.scope), null);
  assert.deepEqual(order.posts.at(-1), { markdown: 'Order reviewed.' });
  await order.decide();
  assert.equal(mutations().length, 1);
  assert.equal(order.deliveries.length, 1);

  const cancel = await scenario('cancel-approved', { cancel: true });
  assert.match((await cancel.state()).approvalText, new RegExp(ORDER_ID));
  assert.deepEqual(await cancel.decide(), { status: 200, body: { status: 'approved' } });
  assert.deepEqual(mutations(), [{ name: 'coinbase_orders_cancel', input: { order_ids: [ORDER_ID] } }]);
});


test('denial, expiry, owner revocation, and changed order never produce a mutation through the assembled route', async () => {
  for (const reason of ['denial', 'expiry', 'owner-revoked', 'changed-order']) {
    const flow = await scenario(reason, { changedOrder: reason === 'changed-order' });
    const now = Date.now;
    try {
      if (reason === 'expiry') {
        const expiry = (await flow.state()).expiresAtMs;
        Date.now = () => expiry + 1;
      }
      if (reason === 'owner-revoked') process.env.PHOTON_ALLOWED_PRINCIPALS = 'imessage:+15555550199';
      const response = await flow.decide(reason === 'denial' ? 'deny' : 'approve');
      assert.equal(response.status, reason === 'owner-revoked' ? 409 : 200);
      assert.equal(mutations().length, 0, reason);
      assert.equal(flow.deliveries.length, reason === 'owner-revoked' ? 0 : 1);
      if (reason === 'changed-order') {
        assert.ok(flow.modelToolResults.some(result => result.name === 'coinbase_create_order' && result.isError && /changed after preview/.test(JSON.stringify(result.output))), 'the model must receive the exact preview rejection');
        assert.equal(app.fixture.calls.filter(call => call.name === 'coinbase_products_get').length, 1, 'changed preview is rejected before the execution metadata read');
      }
    } finally {
      Date.now = now;
      process.env.PHOTON_ALLOWED_PRINCIPALS = OWNER;
    }
  }
});

test('concurrent approval buttons deliver once and an unknown provider outcome remains blocked without replay', async () => {
  const flow = await scenario('unknown');
  app.fixture.outcome = 'unknown';
  const results = await Promise.all([flow.decide(), flow.decide()]);
  assert.equal(results.filter(result => result.body.status === 'approved').length, 1);
  assert.equal(flow.deliveries.length, 1);
  assert.equal(mutations().length, 1);
  assert.equal(await app.getCurrentPhotonApprovalActivity(flow.scope), 'processing');
  assert.match(flow.posts.at(-1), /new orders remain blocked/);
  await flow.decide();
  assert.equal(mutations().length, 1);
  assert.equal(flow.deliveries.length, 1);
  const manager = await app.mintPhotonWorkspaceManager(flow.scope);
  const state = await app.getPhotonWorkspaceState(flow.scope);
  await assert.rejects(app.applyPhotonWorkspaceManagerAction(manager.managerToken, {
    action: 'start-fresh', workspaceId: flow.workspace.id, expectedRevision: state.revision,
  }), app.PhotonWorkspaceApprovalBlockedError);
});

test('an approval cannot resume a stale session after its workspace is bound to another durable session', async () => {
  const flow = await scenario('session-replaced');
  assert.equal(await app.savePhotonWorkspaceSession({ ...flow.scope, workspaceId: flow.workspace.id,
    generation: flow.workspace.generation, sessionId: 'replacement-session' }), true);
  const response = await flow.decide();
  assert.equal(response.status, 409);
  assert.equal(flow.deliveries.length, 0, 'the retired session must never receive an approval response');
  assert.equal(mutations().length, 0);
});
