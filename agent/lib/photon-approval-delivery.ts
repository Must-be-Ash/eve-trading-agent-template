import type { AttachSessionFn } from "eve/channels";
import {
  completePhotonApprovalDecision,
  failPhotonApprovalDecision,
  type PhotonApprovalDelivery,
} from "./photon-approval-store";
import { isPhotonPrincipalAllowed, photonAuth, photonSenderId } from "./photon-auth";

import { getPhotonWorkspaceState } from "./photon-workspace-store";
import { photonApprovalWorkspace } from "./photon-workspace";
import { projectPhotonWorkspaceRuntimeScope } from "./workspace-runtime-scope";

/** Deliver once to the recorded durable session; a timeout never means retry. */
export async function deliverPhotonApproval(
  delivery: PhotonApprovalDelivery,
  attachSession: AttachSessionFn,
): Promise<"accepted" | "unavailable" | "uncertain"> {
  const senderId = photonSenderId(delivery.principalId);
  if (!senderId || !isPhotonPrincipalAllowed(delivery.principalId)) {
    await failPhotonApprovalDecision(delivery).catch(() => undefined);
    return "unavailable";
  }
  let scope;
  if (delivery.workspaceId || delivery.workspaceGeneration) {
    try {
      const state = await getPhotonWorkspaceState({ principalId: delivery.principalId, threadId: delivery.threadId });
      const workspace = photonApprovalWorkspace(state, delivery);
      if (!workspace) throw new Error("Approval session is no longer active.");
      scope = projectPhotonWorkspaceRuntimeScope({
        generation: workspace.generation, principalId: delivery.principalId,
        threadId: delivery.threadId, workspaceId: workspace.id,
      });
    } catch {
      await failPhotonApprovalDecision(delivery).catch(() => undefined);
      return "unavailable";
    }
  }
  try {
    const result = await attachSession(delivery.sessionId).respond(
      [{ optionId: delivery.decision, requestId: delivery.requestId }],
      { auth: photonAuth(senderId, delivery.threadId, scope) },
    );
    if (result.status !== "accepted") {
      await failPhotonApprovalDecision(delivery).catch(() => undefined);
      return "unavailable";
    }
    await completePhotonApprovalDecision(delivery);
    return "accepted";
  } catch {
    // Approval may already have reached Eve. Keep its guard until execution is
    // reconciled; a retry could execute the same financial action twice.
    if (delivery.decision === "deny") {
      await failPhotonApprovalDecision(delivery).catch(() => undefined);
    }
    return "uncertain";
  }
}
