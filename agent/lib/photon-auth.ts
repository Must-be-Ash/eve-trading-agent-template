import type { SessionAuthContext } from "eve/context";

import { workspaceRuntimeScopeAttributes, type WorkspaceRuntimeScope } from "./workspace-runtime-scope";

export function photonPrincipalId(senderId: string): string {
  return `imessage:${senderId}`;
}

export function photonSenderId(principalId: string): string | null {
  return /^imessage:\+[1-9]\d{7,14}$/u.test(principalId)
    ? principalId.slice("imessage:".length)
    : null;
}

export function isPhotonPrincipalAllowed(principalId: string): boolean {
  const entries = (process.env.PHOTON_ALLOWED_PRINCIPALS ?? "")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length === 1 && photonSenderId(entries[0]!) !== null && entries[0] === principalId;
}

/** Call only with the sender extracted from a verified Photon webhook. */
export function photonAuth(senderId: string, threadId: string, scope?: WorkspaceRuntimeScope, additionalAttributes: Readonly<Record<string, string>> = {}): SessionAuthContext {
  const principalId = photonPrincipalId(senderId);
  if (!isPhotonPrincipalAllowed(principalId)) {
    throw new Error("This iMessage identity is not authorized.");
  }
  return {
    attributes: { ...additionalAttributes, channel: "photon", thread_id: threadId, ...(scope ? workspaceRuntimeScopeAttributes(scope) : {}) },
    authenticator: "photon-imessage-webhook",
    issuer: "photon-imessage",
    principalId,
    principalType: "user",
    subject: senderId,
  };
}
