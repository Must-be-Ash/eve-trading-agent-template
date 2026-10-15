import { AsyncLocalStorage } from "node:async_hooks";

import type { Thread } from "chat";
import type { AttachSessionFn } from "eve/channels";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";
import type { InputRequest } from "eve/client";

import { createPhotonApprovalPrompt, isPhotonApprovalAlias, isPhotonApprovalSupported, parsePhotonTextDecision, type PhotonApprovalDecision } from "../lib/photon-approval";
import { deliverPhotonApproval } from "../lib/photon-approval-delivery";
import { activatePhotonApproval, claimCurrentPhotonApprovalDecision, claimPhotonApprovalEvent, clearPhotonApproval, getCurrentPhotonApprovalActivity, getPhotonApprovalView, releasePhotonApprovalProcessing, savePhotonApproval } from "../lib/photon-approval-store";
import { isPhotonPrincipalAllowed, photonAuth, photonPrincipalId } from "../lib/photon-auth";
import { createPhotonState } from "../lib/photon-state";
import { createPhotonImessageAdapter } from "../lib/photon-imessage-adapter";
import { isPhotonContentlessOutboundControlEcho } from "../lib/photon-imessage-ingress";
import { photonApprovalAppUrl, photonArtifactPresentation } from "../lib/photon-mini-app";

const imessage = createPhotonImessageAdapter();
const sessionHandles = new AsyncLocalStorage<AttachSessionFn>();

function questionText(request: InputRequest): string {
  const options = request.options?.map((option) => `${option.label}${option.description ? ` — ${option.description}` : ""}`).join(" / ");
  return `${request.prompt}${options ? `\n\n${options}` : ""}\nReply with your answer.`;
}

// Durable channel events do not receive attachSession in Eve 0.33. This
// authenticated denial-only path uses the app's existing Eve HTTP channel.
async function denyRequests(sessionId: string, requests: readonly InputRequest[], thread: Thread, notice: string): Promise<void> {
  const approvals = requests.filter((request) => request.kind === "tool-approval");
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  const token = process.env.VERCEL_OIDC_TOKEN;
  try {
    if (!host || !token) throw new Error("Internal session responder unavailable.");
    const origin = new URL(host.startsWith("https://") ? host : `https://${host}`);
    const result = await fetch(new URL(`/eve/v1/session/${encodeURIComponent(sessionId)}`, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ inputResponses: approvals.map((request) => ({ requestId: request.requestId, optionId: "deny" })) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) throw new Error("Eve could not cancel the pending approval.");
    await thread.post(notice);
  } catch {
    await thread.post("I couldn't safely open or cancel this approval. No action was authorized; it remains blocked.").catch(() => undefined);
  }
}

async function releaseGuard(sessionId: string, thread: Thread | null): Promise<void> {
  const result = await releasePhotonApprovalProcessing(sessionId).catch(() => "retained");
  if (result === "retained" && thread) {
    await thread.post("The Coinbase order status is uncertain. Check Coinbase before trying again; new orders remain blocked.");
  }
}

const bridge = chatSdkChannel({
  adapters: { imessage },
  routes: { imessage: "/eve/v1/photon" },
  concurrency: "queue",
  turnPolicy: "queue",
  state: createPhotonState(),
  streaming: false,
  userName: "Eve",
  events: {
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message || !channel.thread) return;
      const artifact = photonArtifactPresentation(data.message);
      await channel.thread.post({ markdown: artifact?.message ?? data.message });
      if (artifact) await imessage.sendMiniApp(channel.thread.id, artifact.url).catch(() => undefined);
    },
    async "turn.completed"(_data, channel, ctx) { await releaseGuard(ctx.session.id, channel.thread); },
    async "turn.cancelled"(_data, channel, ctx) { await releaseGuard(ctx.session.id, channel.thread); },
    async "turn.failed"(_data, channel, ctx) {
      await releaseGuard(ctx.session.id, channel.thread);
      await channel.thread?.post("I couldn't finish that request. I won't retry it automatically. If it involved an order, check Coinbase before trying again.");
    },
    async "session.failed"(data, channel) { await releaseGuard(data.sessionId, channel.thread); },
    async "input.requested"(data, channel, ctx) {
      if (!channel.thread) return;
      const thread = channel.thread;
      const [request] = data.requests;
      if (!data.requests.some((item) => item.kind === "tool-approval")) {
        await thread.post(data.requests.map(questionText).join("\n\n"));
        return;
      }
      const auth = ctx.session.auth.current;
      if (data.requests.length !== 1 || !request || !isPhotonApprovalSupported(request) ||
        auth?.authenticator !== "photon-imessage-webhook" || auth.principalType !== "user" ||
        !isPhotonPrincipalAllowed(auth.principalId)) {
        await denyRequests(ctx.session.id, data.requests, thread, "This approval was denied. I can approve one Coinbase order at a time from iMessage.");
        return;
      }
      let approvalToken: string | undefined;
      try {
        const prompt = createPhotonApprovalPrompt(request);
        const saved = await savePhotonApproval({ principalId: auth.principalId, prompt, sessionId: ctx.session.id, threadId: thread.id });
        if (saved.reused) {
          if (saved.state === "draft") await thread.post("The earlier approval has not opened. Reply NO to cancel it, then prepare the order again.");
          return;
        }
        approvalToken = saved.approvalToken;
        if (!approvalToken) throw new Error("Approval token unavailable.");
        await imessage.sendMiniApp(thread.id, photonApprovalAppUrl(approvalToken));
        await activatePhotonApproval({ approvalToken, principalId: auth.principalId, threadId: thread.id });
        await thread.post(`${prompt.approvalText}\n\nOpen the approval card, or reply YES to approve or NO to deny.`).catch(() => undefined);
      } catch {
        if (approvalToken) {
          const view = await getPhotonApprovalView(approvalToken).catch(() => null);
          if (view && ["active", "processing", "delivered"].includes(view.status)) return;
          const cleared = await clearPhotonApproval({ approvalToken, principalId: auth.principalId, threadId: thread.id }).catch(() => false);
          if (!cleared) {
            await thread.post("The approval could not be opened safely. No action was authorized; it remains blocked.").catch(() => undefined);
            return;
          }
        }
        await denyRequests(ctx.session.id, [request], thread, "I couldn't open an exact approval. The action was denied; ask me to prepare it again.");
      }
    },
  },
});

async function submitDecision(thread: Thread, senderId: string, decision: PhotonApprovalDecision, sentAtMs: number, expiredOnly = false): Promise<void> {
  const claim = await claimCurrentPhotonApprovalDecision({ decision, decisionSentAtMs: sentAtMs, expiredOnly, principalId: photonPrincipalId(senderId), threadId: thread.id });
  if (claim.status !== "deliver") {
    const notices = {
      missing: "There is no active order approval. Ask me to prepare the order again.",
      unavailable: "The approval is still opening. No action was authorized; review the card and try again.",
      stale: "That reply was sent before the current approval opened and was ignored. Review the order and reply YES or NO again.",
      invalid: "That approval is no longer active. No additional action was authorized.",
      forbidden: "That approval belongs to a different sender. No action was authorized.",
      conflict: "The other choice is already being confirmed. No second choice was accepted.",
      delivered: "That decision was already delivered. No additional action was authorized.",
      processing: "That decision is already processing. Wait for the result before starting another order.",
    };
    await thread.post(notices[claim.status]);
    return;
  }
  const attachSession = sessionHandles.getStore();
  if (!attachSession) throw new Error("The approval session responder is unavailable.");
  const result = await deliverPhotonApproval(claim.delivery, attachSession);
  await thread.post(result === "uncertain"
    ? "The approval delivery status is uncertain. Check Coinbase before starting another order."
    : result === "unavailable"
      ? "That approval session is no longer available. No action was authorized."
      : claim.delivery.expired
        ? "That approval expired and was denied. Please send your new request again."
        : claim.delivery.decision === "approve" ? "Approved. Continuing…" : "Denied. No order will be placed.");
}

async function dispatch(
  thread: Parameters<Parameters<typeof bridge.bot.onDirectMessage>[0]>[0],
  message: Parameters<Parameters<typeof bridge.bot.onDirectMessage>[0]>[1],
  context?: Parameters<Parameters<typeof bridge.bot.onDirectMessage>[0]>[2],
): Promise<void> {
  for (const skipped of context?.skipped ?? []) await dispatch(thread, skipped);
  if (!thread.isDM || message.author.isBot || message.author.isMe || isPhotonContentlessOutboundControlEcho(message) ||
      (!message.text.trim() && !(message.attachments?.length))) return;
  const senderId = message.author.userId;
  const principalId = photonPrincipalId(senderId);
  if (!isPhotonPrincipalAllowed(principalId)) return;
  const decision = parsePhotonTextDecision(message.text);
  try {
    if (decision) {
      const sentAtMs = message.metadata.dateSent.getTime();
      if (!Number.isSafeInteger(sentAtMs) || sentAtMs < 0 || sentAtMs > Date.now() + 5 * 60_000) {
        await thread.post("I couldn't verify when that reply was sent. No action was authorized; review the order and reply again.");
        return;
      }
      if (!await claimPhotonApprovalEvent({ eventId: message.id, principalId, threadId: thread.id })) return;
      await submitDecision(thread, senderId, decision, sentAtMs);
      return;
    }
    if (isPhotonApprovalAlias(message.text)) {
      await thread.post("Use YES or NO for an active order approval. No action was authorized.");
      return;
    }
    const activity = await getCurrentPhotonApprovalActivity({ principalId, threadId: thread.id });
    if (activity === "expired") { await submitDecision(thread, senderId, "deny", Date.now(), true); return; }
    if (activity) {
      await thread.post(activity === "processing"
        ? "Your approved action is still processing. Wait for the result before sending another request."
        : "An order is waiting for your decision. Reply YES to approve or NO to deny before sending another request.");
      return;
    }
  } catch {
    await thread.post("I couldn't verify the pending approval state, so no new request was sent. Please check the order status before trying again.");
    return;
  }
  await bridge.send(messageToUserContent(message), { auth: photonAuth(senderId, thread.id), thread, turnPolicy: "queue" });
}

bridge.bot.onDirectMessage(dispatch);
bridge.bot.onNewMessage(/[\s\S]*/u, dispatch);

// Pass the public fixed-session API through the verified webhook handler so
// text decisions cannot follow a replacement session at the same address.
export default {
  ...bridge.channel,
  routes: bridge.channel.routes.map((route) => route.transport === "websocket" ? route : {
    ...route,
    handler: (request, args) => sessionHandles.run(args.attachSession, () => route.handler(request, args)),
  }),
} satisfies typeof bridge.channel;
