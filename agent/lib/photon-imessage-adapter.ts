import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { createConnectWebhookVerifier } from "@vercel/connect/chat";
import { connectPhotonCredentials } from "@vercel/connect/eve";

export function createPhotonImessageAdapter() {
  return createiMessageAdapter({
    // Resolve lazily so a template can build before a connector is configured.
    credentials: async () => {
      const projectId = process.env.IMESSAGE_PROJECT_ID?.trim();
      const projectSecret = process.env.IMESSAGE_PROJECT_SECRET?.trim();
      if (projectId || projectSecret) {
        if (!projectId || !projectSecret || !process.env.IMESSAGE_WEBHOOK_SECRET?.trim()) {
          throw new Error("Portable Photon credentials require IMESSAGE_PROJECT_ID, IMESSAGE_PROJECT_SECRET, and IMESSAGE_WEBHOOK_SECRET.");
        }
        return { projectId, projectSecret };
      }
      const connectorId = process.env.PHOTON_CONNECTOR_ID?.trim();
      if (!connectorId) throw new Error("Set PHOTON_CONNECTOR_ID to your Photon connector.");
      return connectPhotonCredentials(connectorId)();
    },
    ...(process.env.IMESSAGE_WEBHOOK_SECRET?.trim()
      ? { webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET.trim() }
      : { webhookVerifier: createConnectWebhookVerifier() }),
  });
}
