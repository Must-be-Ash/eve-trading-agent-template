import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';

// Replace only the Photon SDK's remote initialization and sends. Keep its
// signed webhook parser, Chat initialization, thread IDs, and inbound routing.
export function createPhotonSdkFixture(realFactory) {
  const messages = [];
  const cards = [];
  const adapters = [];
  const webhookSecret = 'fixture-photon-webhook-secret';
  return {
    messages, cards, adapters, webhookSecret,
    createiMessageAdapter() {
      const adapter = realFactory({
        webhookSecret,
        credentials: async () => { throw new Error('Fixture must never request Photon credentials.'); },
      });
      adapter.ensureApp = async () => {};
      adapter.postMessage = async (threadId, message) => {
        const id = '1' + randomUUID().slice(1);
        messages.push({ id, threadId, message: structuredClone(message) });
        return { id, threadId, raw: { id } };
      };
      adapter.sendMiniApp = async (threadId, url) => {
        const id = '1' + randomUUID().slice(1);
        cards.push({ id, threadId, url });
        return { id, threadId, raw: { id } };
      };
      adapter.startTyping = async () => {};
      adapters.push(adapter);
      return adapter;
    },
  };
}

// The existing isolated Redis fixture exposes REST and a Unix socket. Chat
// SDK uses redis://, so forward local TCP to that same real disposable store.
export async function createLoopbackRedisTcp(redis) {
  const socketPath = (await redis.command('CONFIG', 'GET', 'unixsocket'))[1];
  if (!socketPath) throw new Error('Fixture Redis has no Unix socket.');
  const sockets = new Set();
  const server = createServer(client => {
    const upstream = connect(socketPath);
    sockets.add(client);
    sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `redis://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

// This enters the installed Nitro channel dispatcher, which creates the real
// Workflow runtime, continuation operations, and fixed-session handles. The
// caller installs its compiled artifacts/local World before invoking it.
export async function dispatchPhotonFixtureMessage({
  text,
  webhookSecret,
  eventId = randomUUID(),
  senderId = '+15555550123',
  chatGuid = 'iMessage;-;+15555550123',
  now = Date.now(),
  origin = 'https://template.example',
}) {
  const body = JSON.stringify({
    event: 'messages',
    space: { id: chatGuid },
    message: {
      id: eventId,
      direction: 'inbound',
      sender: { id: senderId },
      timestamp: new Date(now).toISOString(),
      content: { type: 'text', text },
    },
  });
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac('sha256', webhookSecret)
    .update(`v0:${timestamp}:${body}`).digest('hex');
  const request = new Request(`${origin}/eve/v1/photon`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-spectrum-event': 'messages',
      'x-spectrum-timestamp': timestamp,
      'x-spectrum-signature': `v0=${signature}`,
    },
    body,
  });
  const { dispatchChannelRequest } = await import('../../node_modules/eve/dist/src/internal/nitro/routes/channel-dispatch.js');
  const pending = [];
  const response = await dispatchChannelRequest({
    req: request, context: { params: {} }, waitUntil: task => pending.push(task),
  }, 'POST /eve/v1/photon', { kind: 'production' });
  await Promise.all(pending);
  return { eventId, response, backgroundTaskCount: pending.length };
}
