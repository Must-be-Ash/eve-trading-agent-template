import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { startTestRedis } from './photon-redis.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function loadManagerApi(extraExports = '', { plugins = [] } = {}) {
  const directory = await mkdtemp(join(projectRoot, 'tests/.manager-e2e-'));
  const outfile = join(directory, 'manager.mjs');
  try {
    await build({ absWorkingDir: projectRoot, stdin: { contents: `
      export { default as managerChannel } from './agent/channels/photon-workspace-app.ts';
      export * from './agent/lib/photon-workspace-store.ts';
      export * from './agent/lib/photon-approval-store.ts';
      export * from './agent/lib/workspace-monitor-store.ts';
      export * from './agent/lib/workspace-store-authorization.ts';
      export * from './agent/lib/owner-identity.ts';
      ${extraExports}
    `, resolveDir: projectRoot, loader: 'ts' }, outfile,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins });
    return await import(pathToFileURL(outfile).href);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Fixtures stop at the network edge: every manager route, identity receipt,
// pack transaction, monitor, subscription, and budget uses production code.
export async function startManagerFixture(api, label = randomUUID()) {
  const redis = await startTestRedis();
  const env = {
    KV_REST_API_URL: redis.url, KV_REST_API_TOKEN: redis.token,
    PHOTON_ALLOWED_PRINCIPALS: 'imessage:+15555550123',
    EVE_DEPLOYMENT_OWNER_ID: 'fixture_owner', EVE_OWNER_ALIAS_HMAC_SECRET: 'M'.repeat(43),
    EVE_WORKSPACE_STATE_ENABLED: '1', EVE_WORKSPACE_MONITOR_WRITES_ENABLED: '1',
    EVE_STRATEGY_PACK_CATALOG_ENABLED: '1', EVE_STRATEGY_PACK_RUNTIME_ENABLED: '1',
    EVE_STRATEGY_PACK_MUTATIONS_ENABLED: '1', EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: '0',
    EVE_WORKSPACE_DISPATCH_ENABLED: '0', EVE_WORKSPACE_PAID_RESEARCH_ENABLED: '0',
    EVE_PHOTON_WORKSPACE_ALERTS_ENABLED: '0', EVE_WORKSPACE_SOURCE_EVENTS_ENABLED: '0',
    PUBLIC_APP_URL: 'https://template.example', X_BEARER_TOKEN: 'fixture-x-token',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === redis.url) return originalFetch(input, init);
    if (url.origin === 'https://api.x.com' && url.pathname.startsWith('/2/users/by/username/')) {
      requests.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization') });
      const username = url.pathname.split('/').at(-1);
      return Response.json({ data: { id: '123456789', name: 'Fixture Desk', username } });
    }
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  };
  const scope = { principalId: env.PHOTON_ALLOWED_PRINCIPALS, threadId: `imessage:${label}` };
  const manager = await api.mintPhotonWorkspaceManager(scope);
  const resetSessions = [];
  const routeContext = { attachSession: sessionId => ({ reset: async options => { resetSessions.push({ sessionId, options }); return { status: 'reset' }; } }) };
  async function request(path, body, options = {}) {
    const method = options.method ?? (body ? 'POST' : 'GET');
    const route = api.managerChannel.routes.find(candidate => candidate.method === method && candidate.path.endsWith(path));
    assert.ok(route, `Real manager route exists: ${method} ${path}`);
    const response = await route.handler(new Request(`https://template.example${route.path}`, {
      method, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), routeContext);
    return response;
  }
  async function post(path, body = {}) {
    const response = await request(path, { managerToken: manager.managerToken, ...body });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function state() {
    const result = await post('/state');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function createInstalledPack(overrides = {}) {
    const current = await state();
    const source = current.workspaces.find(w => w.id === current.activeWorkspaceId);
    const resolved = await post('/resolve-x-identity', { profile: '@fixture_desk', requestId: randomUUID() });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const identity = resolved.body;
    const installed = await post('/pack-action', {
      action: 'strategy-pack-create', activateMonitorResourceIds: [],
      configuration: { xIdentity: [identity.profileUrl, identity.username, identity.displayName, identity.numericUserId, 'confirmed'],
        monitoringObjective: 'Watch public comments about market liquidity.', topics: ['liquidity'],
        impactHypotheses: ['improving liquidity|BTC|up'], ...(overrides.configuration ?? {}) },
      expectedRoutingRevision: current.revision, name: overrides.name ?? 'Fixture X Monitor',
      packId: 'public-commentary-tracker', packVersion: '1.5.4', packMutationIdentity: current.packMutationIdentity,
      sourceWorkspaceGeneration: source.generation, sourceWorkspaceId: source.id,
      xIdentityResolutionReceipt: identity.resolutionReceipt,
      ...(overrides.activateMonitorResourceIds ? { activateMonitorResourceIds: overrides.activateMonitorResourceIds } : {}),
    });
    assert.equal(installed.status, 200, JSON.stringify(installed.body));
    return installed.body;
  }
  return { api, redis, scope, manager, requests, resetSessions, request, post, state, createInstalledPack,
    async close() {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await redis.close();
    } };
}
