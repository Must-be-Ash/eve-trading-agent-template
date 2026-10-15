import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const cwd = fileURLToPath(new URL('../', import.meta.url));
async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const evePort = await availablePort();
const nextPort = await availablePort();
// Probe the built HTTP entrypoint without starting agent sessions or sandboxes.
// Full `eve start` additionally requires the documented Docker prerequisite.
const children = [];
const logs = {};
const environment = { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
async function start(name, args, extraEnvironment = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...environment, ...extraEnvironment }, stdio: ['ignore','pipe','pipe'] });
  children.push(child); logs[name] = '';
  child.stdout.on('data', data => { logs[name] += data; });
  child.stderr.on('data', data => { logs[name] += data; });
  return child;
}
async function request(port, path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(3000) });
  const text = await response.text();
  return { status: response.status, path, text: text.slice(0, 300), challenge: response.headers.get('www-authenticate') };
}
const evidence = [];
try {
  await start('eve', ['.output/server/index.mjs'], { NITRO_HOST: '127.0.0.1', NITRO_PORT: String(evePort) });
  await start('next', ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(nextPort)]);
  for (const port of [evePort,nextPort]) {
    let ready = false;
    for (let i=0;i<30;i++) {
      try { await request(port, '/'); ready=true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `server ${port} did not start`);
  }
  for (const [port, path, options, expected] of [
    [nextPort, '/', {}, 200],
    [nextPort, '/artifacts/invalid-artifact-id', {}, 404],
    [evePort, '/eve/v1/health', {}, 200],
    [evePort, '/eve/v1/session', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'unauthorized fixture'})}, 401],
    [evePort, '/eve/v1/session/fixture/stream', {}, 401],
    [evePort, '/eve/v1/photon-workspaces', {}, 200],
    [evePort, '/eve/v1/photon-workspaces/state', {method:'POST',headers:{'content-type':'application/json'},body:'{}'}, 400],
  ]) {
    const result = await request(port,path,options); evidence.push({ port, ...result });
    assert.equal(result.status, expected, `${port}${path}`);
  }
} finally {
  for (const child of children) {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child,'exit'); }
  }
  await writeFile(join(process.env.EVE_AUDIT_OUTPUT_DIR ?? tmpdir(), 'eve-template-production-smoke.json'), JSON.stringify({ evidence, logs, cleanedUp: children.every(child => child.exitCode !== null || child.signalCode !== null) }, null, 2));
}
console.log(JSON.stringify(evidence));
