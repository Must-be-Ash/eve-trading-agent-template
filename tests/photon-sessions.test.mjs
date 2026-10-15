import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

const output = await build({
  stdin: { contents: `export * from './agent/lib/photon-workspace-store.ts';
    export * from './agent/lib/photon-workspace.ts';
    export * from './agent/lib/photon-approval-store.ts';
    export * from './agent/lib/photon-approval-delivery.ts';
    export * from './agent/lib/photon-alert-reply-store.ts';
    export * from './agent/lib/owner-identity.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false,
});
const directory = await mkdtemp(new URL('.photon-sessions-', import.meta.url));
const file = `${directory}/owners.mjs`;
await writeFile(file, output.outputFiles[0].text);
let owners;
try { owners = await import(pathToFileURL(file)); }
finally { await rm(directory, { recursive: true, force: true }); }

// The registry, approval store and alert routing share real Redis here: this
// catches cross-session approval, stale generation and duplicate reply failures
// which an isolated parser or mocked compare-and-set would not establish.
test('session manager isolates durable conversations and routes alert discussion once', async () => {
  const redis = await startTestRedis();
  const principalId = 'imessage:+15555550123';
  process.env.KV_REST_API_URL = redis.url;
  process.env.KV_REST_API_TOKEN = redis.token;
  process.env.PHOTON_ALLOWED_PRINCIPALS = principalId;
  process.env.EVE_DEPLOYMENT_OWNER_ID = 'template-owner';
  process.env.EVE_OWNER_ALIAS_HMAC_SECRET = randomBytes(32).toString('base64url');
  const scope = { principalId, threadId: 'imessage:session-test' };
  try {
    const initial = await owners.getPhotonWorkspaceState(scope);
    assert.equal(initial.activeWorkspace.name, 'Main');
    const mainId = initial.activeWorkspace.id;
    const manager = await owners.mintPhotonWorkspaceManager(scope);
    const requestId = randomUUID();
    assert.equal(await owners.claimPhotonWorkspaceManagerRequest(manager.managerToken, requestId), 'claimed');
    assert.equal(await owners.claimPhotonWorkspaceManagerRequest(manager.managerToken, requestId), 'replayed');
    let { state } = await owners.applyPhotonWorkspaceManagerAction(manager.managerToken, {
      action: 'create', name: 'Market Research', select: true, expectedRevision: initial.revision,
    });
    const researchId = state.activeWorkspace.id;
    const researchThread = owners.photonWorkspaceThreadId(scope.threadId, state.activeWorkspace);
    assert.notEqual(researchThread, scope.threadId);
    assert.equal(owners.physicalPhotonThreadId(researchThread), scope.threadId);
    assert.equal(await owners.savePhotonWorkspaceSession({ ...scope, workspaceId: researchId, generation: 1, sessionId: 'research-session' }), true);
    await assert.rejects(owners.applyPhotonWorkspaceManagerAction(manager.managerToken, {
      action: 'select', workspaceId: mainId, expectedRevision: initial.revision,
    }), owners.PhotonWorkspaceConflictError);
    const saved = await owners.savePhotonApproval({ ...scope, workspaceId: researchId,
      workspaceGeneration: 1, sessionId: 'research-session', prompt: { approvalText: 'Buy 25 USD of BTC?',
        expiresAtMs: Date.now() + 60_000, requestId: 'research-approval', toolName: 'coinbase_create_order' } });
    await owners.activatePhotonApproval({ ...scope, approvalToken: saved.approvalToken });
    await assert.rejects(owners.applyPhotonWorkspaceManagerAction(manager.managerToken, {
      action: 'select', workspaceId: mainId, expectedRevision: state.revision,
    }), owners.PhotonWorkspaceApprovalBlockedError);
    const blockedIdentity = owners.resolvePhotonOwnerConversationIdentity(scope);
    const blockedDiscuss = await owners.mintPhotonAlertDiscussCapability({ ...scope,
      conversationId: blockedIdentity.conversationId, ownerId: blockedIdentity.ownerId,
      expectedRevision: state.revision, workspaceId: mainId, alertId: "alert-main", findingId: "finding-main" });
    assert.equal((await owners.applyPhotonAlertDiscussAction(blockedDiscuss.alertToken)).status, "stale",
      "alert cards cannot bypass the financial approval session lock");
    assert.equal((await owners.getPhotonWorkspaceState(scope)).activeWorkspace.id, researchId);
    const claim = await owners.claimPhotonApprovalDecision({ approvalToken: saved.approvalToken, decision: 'approve' });
    const calls = [];
    assert.equal(await owners.deliverPhotonApproval(claim.delivery, (sessionId) => ({ respond: async (responses, options) => {
      calls.push({ sessionId, responses, auth: options.auth });
      return { status: 'accepted', sessionId };
    } })), 'accepted');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, 'research-session');
    assert.equal(calls[0].auth.principalId, principalId);
    assert.equal(calls[0].auth.attributes.workspace_id, researchId);
    await owners.markPhotonApprovalExecution({ sessionId: 'research-session', state: 'succeeded' });
    assert.equal(await owners.releasePhotonApprovalProcessing('research-session'), 'released');
    const fresh = await owners.applyPhotonWorkspaceManagerAction(manager.managerToken, {
      action: 'start-fresh', workspaceId: researchId, expectedRevision: state.revision,
    });
    assert.equal(fresh.retiredSessionId, 'research-session');
    state = fresh.state;
    assert.equal(state.activeWorkspace.generation, 2);
    assert.notEqual(owners.photonWorkspaceThreadId(scope.threadId, state.activeWorkspace), researchThread);
    assert.equal(await owners.savePhotonWorkspaceSession({ ...scope, workspaceId: researchId, generation: 1, sessionId: 'late-old-session' }), false);
    assert.equal(state.activeWorkspace.sessionId, undefined);
    ({ state } = await owners.applyPhotonWorkspaceManagerAction(manager.managerToken, {
      action: 'archive', workspaceId: researchId, replacementWorkspaceId: mainId, expectedRevision: state.revision,
    }));
    assert.equal(state.activeWorkspace.id, mainId);
    ({ state } = await owners.applyPhotonWorkspaceManagerAction(manager.managerToken, {
      action: 'restore', workspaceId: researchId, expectedRevision: state.revision,
    }));
    assert.equal(state.activeWorkspace.id, mainId, 'restore does not silently change the active conversation');
    const identity = owners.resolvePhotonOwnerConversationIdentity(scope);
    const alert = await owners.mintPhotonAlertDiscussCapability({ ...scope, conversationId: identity.conversationId, ownerId: identity.ownerId,
      workspaceId: researchId, expectedRevision: state.revision, alertId: 'alert-research', findingId: 'finding-research' });
    const discussed = await owners.applyPhotonAlertDiscussAction(alert.alertToken);
    assert.equal(discussed.status, 'applied');
    assert.equal(discussed.state.activeWorkspace.id, researchId);
    assert.equal((await owners.applyPhotonAlertDiscussAction(alert.alertToken)).status, 'stale');
    const pending = await owners.consumePhotonPendingAlertContext({ ...scope, workspaceId: researchId });
    assert.equal(pending.context.alertId, 'alert-research');
    assert.equal((await owners.consumePhotonPendingAlertContext({ ...scope, workspaceId: researchId })).context, null);

    const candidate = { alertId: 'alert-research', workspaceId: researchId, workspaceName: 'Market Research',
      title: 'Bitcoin liquidity changed', deliveredAt: new Date().toISOString() };
    await owners.recordRecentPhotonAlert({ conversationId: identity.conversationId, candidate });
    const candidates = await owners.readRecentPhotonAlerts(identity.conversationId);
    const related = owners.classifyPhotonAlertReply({ candidates, messageText: 'Market Research bitcoin looks interesting', selectedWorkspaceId: mainId });
    assert.equal(related.workspaceId, researchId);
    const held = await owners.holdPhotonAlertReply({ candidateAlertId: candidate.alertId,
      candidateWorkspaceId: researchId, candidateWorkspaceName: candidate.workspaceName,
      conversationId: identity.conversationId, ingressId: 'ingress-alert-reply', messageText: 'Market Research bitcoin looks interesting',
      ownerId: identity.ownerId, routingRevision: pending.state.revision,
      selectedWorkspaceId: mainId, selectedWorkspaceName: 'Main' });
    assert.equal(owners.parsePhotonHeldReplyChoice('use Market Research', held), 'candidate');
    const claims = await Promise.all([
      owners.claimPhotonHeldAlertReply({ choice: 'candidate', ingressId: held.ingressId }),
      owners.claimPhotonHeldAlertReply({ choice: 'selected', ingressId: held.ingressId }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'one held message can be assigned to only one conversation');
    assert.equal(await owners.readActivePhotonHeldReply(identity.conversationId), null);
    assert.equal((await owners.getPhotonWorkspaceState({ ...scope, threadId: 'imessage:other-conversation' })).workspaces.length, 1);
    delete process.env.PHOTON_ALLOWED_PRINCIPALS;
    assert.equal(await owners.getPhotonWorkspaceManagerState(manager.managerToken), null, 'old bearer loses access immediately after owner revocation');
  } finally { await redis.close(); }
});
