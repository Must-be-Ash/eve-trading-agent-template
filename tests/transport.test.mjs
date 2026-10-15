import assert from "node:assert/strict";
import test from "node:test";

import { BoundedStdioMCPTransport } from "../agent/lib/bounded-stdio-transport.ts";

function deadline(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3_000); }),
  ]).finally(() => clearTimeout(timer));
}

async function childReply(source, config = {}) {
  const transport = new BoundedStdioMCPTransport({
    command: process.execPath,
    args: ["-e", source],
    maximumBytes: 1024 * 1024,
    stderr: "ignore",
    ...config,
  });
  try {
    const received = new Promise((resolve, reject) => {
      transport.onmessage = resolve;
      transport.onerror = reject;
    });
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    return await deadline(received, "child response");
  } finally {
    await transport.close();
  }
}

test("stdio preserves JSON-RPC framing through a real subprocess", async () => {
  const reply = await childReply(`
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { echoed: request.method } }) + "\\n");
    });
  `);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.echoed, "initialize");
});

test("stdio preserves explicit isolated environment and does not inherit app secrets", async () => {
  process.env.TEMPLATE_TEST_SECRET = "never-pass-to-child";
  try {
    const reply = await childReply(`
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
          home: process.env.HOME, secret: process.env.TEMPLATE_TEST_SECRET ?? null,
        } }) + "\\n");
      });
    `, { env: { HOME: "/tmp/isolated-coinbase-fixture" } });
    assert.equal(reply.result.home, "/tmp/isolated-coinbase-fixture");
    assert.equal(reply.result.secret, null);
  } finally {
    delete process.env.TEMPLATE_TEST_SECRET;
  }
});

for (const [label, source] of [
  ["unterminated frame", 'process.stdout.write("x".repeat(5_000_000));'],
  ["complete frame", 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { payload: "x".repeat(5000) } }) + "\\n");'],
]) {
  test(`stdio rejects oversized ${label} before parsing`, async () => {
    let limitError;
    const transport = new BoundedStdioMCPTransport({
      command: process.execPath,
      args: ["-e", source],
      maximumBytes: 1_024,
      stderr: "ignore",
      onLimitExceeded: (error) => { limitError = error; },
    });
    try {
      const errored = new Promise((resolve) => { transport.onerror = resolve; });
      await transport.start();
      const error = await deadline(errored, "oversized frame");
      assert.match(error.message, /exceeded 1024 bytes/u);
      assert.equal(limitError, error);
    } finally {
      await transport.close();
    }
  });
}
