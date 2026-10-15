import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { buildSandboxSession } from '../../node_modules/eve/dist/src/execution/sandbox/session.js';
import { SandboxTemplateNotProvisionedError } from '../../node_modules/eve/dist/src/public/definitions/sandbox-backend.js';

// A provider fixture for the authored Docker boundary. All files stay in
// memory; shell execution fails closed. Only the framework's literal HOME
// query has a fixture response. Runtime/session/channel code is real.
export function createDockerProviderFixture() {
  const calls = [];
  const sessions = new Map();
  const templates = new Map();
  const name = 'fixture-docker';
  function open(sessionKey, seed = []) {
    let files = sessions.get(sessionKey);
    if (!files) { files = new Map(seed); sessions.set(sessionKey, files); }
    const session = buildSandboxSession({
      id: sessionKey,
      resolvePath: path => posix.resolve('/workspace', path),
      async readFile({ path }) {
        calls.push({ operation: 'read', sessionKey, path });
        const bytes = files.get(path);
        return bytes ? new Response(bytes).body : null;
      },
      async writeFile({ path, content }) {
        calls.push({ operation: 'write', sessionKey, path });
        files.set(path, Buffer.from(await new Response(content).arrayBuffer()));
      },
      async removePath({ path, recursive }) {
        calls.push({ operation: 'remove', sessionKey, path });
        for (const key of files.keys()) if (key === path || (recursive && key.startsWith(path + '/'))) files.delete(key);
      },
      async spawn({ command }) {
        calls.push({ operation: 'spawn', sessionKey, command });
        if (command === 'printf \'%s\\n\' "$HOME"') {
          return {
            stdout: new Response('/home/fixture\n').body,
            stderr: new Response('').body,
            wait: async () => ({ exitCode: 0 }),
            kill: async () => {},
          };
        }
        throw new Error('Fixture prohibits shell execution: ' + command);
      },
    }, async policy => {
      assert.equal(policy, 'deny-all');
      calls.push({ operation: 'network-policy', sessionKey, policy });
    });
    return session;
  }
  return {
    calls, sessions,
    docker(options) {
      assert.equal(options?.networkPolicy, 'deny-all', 'Authored sandbox must retain deny-all.');
      calls.push({ operation: 'configure', options: structuredClone(options) });
      return {
        name,
        async prewarm(input) {
          calls.push({ operation: 'prewarm', templateKey: input.templateKey });
          assert.equal(input.bootstrap, undefined, 'Unmodeled authored bootstrap is forbidden.');
          templates.set(input.templateKey, input.seedFiles.map(file => [posix.resolve('/workspace', file.path), Buffer.from(file.content)]));
          return { reused: false };
        },
        async create(input) {
          calls.push({ operation: 'create', sessionKey: input.sessionKey, templateKey: input.templateKey, tags: input.tags });
          if (input.templateKey !== null && !templates.has(input.templateKey)) {
            throw new SandboxTemplateNotProvisionedError({ backendName: name, templateKey: input.templateKey });
          }
          const session = open(input.sessionKey, templates.get(input.templateKey));
          return {
            session,
            useSessionFn: async options => {
              if (options?.networkPolicy !== undefined) await session.setNetworkPolicy(options.networkPolicy);
              return session;
            },
            async captureState() { return { backendName: name, sessionKey: input.sessionKey, metadata: {} }; },
            async stop() { calls.push({ operation: 'stop', sessionKey: input.sessionKey }); },
            async shutdown() { calls.push({ operation: 'shutdown', sessionKey: input.sessionKey }); },
          };
        },
      };
    },
    close() { sessions.clear(); templates.clear(); },
  };
}
