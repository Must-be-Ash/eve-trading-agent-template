import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// Real Lua/Redis semantics behind a tiny loopback Upstash wire adapter. Each
// fixture has its own Unix socket, data directory, and ephemeral HTTP port.
export async function startTestRedis() {
  const directory = await mkdtemp(join(tmpdir(), "eve-template-redis-"));
  const socket = join(directory, "redis.sock");
  const server = spawn(process.env.REDIS_SERVER_BIN || "redis-server", [
    "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700",
    "--dir", directory, "--save", "", "--appendonly", "no",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let rest;
  async function close() {
    if (rest) await new Promise((resolve) => rest.close(resolve));
    if (server.pid && server.exitCode === null) { server.kill("SIGTERM"); await once(server, "exit"); }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Disposable Redis did not start.")), 5000);
      const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
      server.once("error", finish);
      server.once("exit", (code) => finish(new Error(`Disposable Redis exited ${code}.`)));
      server.stdout.on("data", (chunk) => { if (String(chunk).toLowerCase().includes("ready to accept connections")) finish(); });
    });
    async function command(...parts) {
      const client = connect(socket);
      const body = Buffer.concat([
        Buffer.from(`*${parts.length}\r\n`),
        ...parts.flatMap((part) => { const bytes = Buffer.from(String(part)); return [Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]; }),
      ]);
      client.write(body);
      try {
        let bytes = Buffer.alloc(0);
        for await (const chunk of client) {
          bytes = Buffer.concat([bytes, chunk]);
          const parsed = parseResp(bytes);
          if (parsed) { if (parsed.error) throw new Error(parsed.value); return parsed.value; }
        }
        throw new Error("Redis closed before its response.");
      } finally { client.destroy(); }
    }
    rest = createServer(async (req, res) => {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const execute = async (args) => {
          try {
            const result = await command(...args);
            return { result: req.headers["upstash-encoding"] === "base64" ? encode(result) : result };
          } catch (error) { return { error: error.message }; }
        };
        const result = req.url === "/pipeline" || req.url === "/multi-exec"
          ? await Promise.all(request.map(execute)) : await execute(request);
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    });
    rest.listen(0, "127.0.0.1");
    await once(rest, "listening");
    return { url: `http://127.0.0.1:${rest.address().port}`, token: "local-fixture", command, close };
  } catch (error) { await close(); throw error; }
}
function encode(value) {
  if (typeof value === "string") return Buffer.from(value).toString("base64");
  return Array.isArray(value) ? value.map(encode) : value;
}
function parseResp(bytes, offset = 0) {
  const end = bytes.indexOf("\r\n", offset);
  if (end < 0) return null;
  const type = String.fromCharCode(bytes[offset]);
  const value = bytes.toString("utf8", offset + 1, end);
  let next = end + 2;
  if (type === "+" || type === "-" || type === ":") return { value: type === ":" ? Number(value) : value, next, error: type === "-" };
  if (type === "$") {
    const length = Number(value);
    if (length === -1) return { value: null, next };
    if (bytes.length < next + length + 2) return null;
    return { value: bytes.toString("utf8", next, next + length), next: next + length + 2 };
  }
  if (type === "*") {
    const count = Number(value);
    if (count === -1) return { value: null, next };
    const values = [];
    for (let i = 0; i < count; i++) { const item = parseResp(bytes, next); if (!item) return null; values.push(item.value); next = item.next; }
    return { value: values, next };
  }
  throw new Error(`Unsupported Redis reply type ${type}`);
}
