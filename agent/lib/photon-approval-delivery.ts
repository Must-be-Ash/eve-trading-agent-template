import type { AttachSessionFn } from "eve/channels";
import {
  completePhotonApprovalDecision,
  failPhotonApprovalDecision,
  type PhotonApprovalDelivery,
} from "./photon-approval-store";
import { isPhotonPrincipalAllowed, photonAuth, photonSenderId } from "./photon-auth";

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
  try {
    const result = await attachSession(delivery.sessionId).respond(
      [{ optionId: delivery.decision, requestId: delivery.requestId }],
      { auth: photonAuth(senderId, delivery.threadId) },
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
