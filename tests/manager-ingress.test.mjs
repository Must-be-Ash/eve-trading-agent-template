import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {loadManagerApi,startManagerFixture} from './helpers/manager-fixture.mjs';

// Keep webhook verification, the Photon/Chat SDK adapters, durable ingress and
// manager minting real. Only the remote Photon gRPC client is a provider fixture.
const photonPath = new URL(import.meta.resolve('@photon-ai/chat-adapter-imessage')).pathname;
const photonRequire = createRequire(photonPath);
const spectrumPath = photonRequire.resolve('@spectrum-ts/imessage');
const providerPath = new URL('../node_modules/@photon-ai/advanced-imessage/dist/index.js',import.meta.url).pathname;
const sent = [];
const providerKey = `managerIngressProvider${Date.now()}`;
globalThis[providerKey] = {
  close: async () => {},
  chats: { markRead: async () => {} },
  messages: {
    sendCustomizedMiniApp: async (chat,content) => {
      sent.push({chat,content});
      return {guid:`fixture-card-${sent.length}`,dateCreated:new Date()};
    },
    sendText: async () => {throw new Error('Unexpected plain-text fallback');},
  },
};
const webhookSecret = 'fixture-webhook-secret';
process.env.IMESSAGE_WEBHOOK_SECRET = webhookSecret;
process.env.IMESSAGE_PROJECT_ID = 'fixture-project';
process.env.IMESSAGE_PROJECT_SECRET = 'fixture-secret';
const api = await loadManagerApi(`export { photon, photonBot } from './agent/channels/photon.ts';`, {
  plugins: [{name:'photon-provider-boundary',setup(plugin){
    plugin.onResolve({filter:/^@photon-ai\/chat-adapter-imessage$/},()=>({path:photonPath}));
    plugin.onResolve({filter:/^@spectrum-ts\/imessage$/},()=>({path:spectrumPath}));
    plugin.onResolve({filter:/^(?:@spectrum-ts\/core(?:\/.*)?|@photon-ai\/otel)$/},args=>({path:photonRequire.resolve(args.path),external:true}));
    plugin.onResolve({filter:/^@photon-ai\/advanced-imessage$/},()=>({path:'fixture-client',namespace:'provider'}));
    plugin.onLoad({filter:/.*/,namespace:'provider'},()=>({loader:'js',contents:`
      export {NotFoundError,ValidationError} from ${JSON.stringify(providerPath)};
      export function createClient(){return globalThis[${JSON.stringify(providerKey)}];}
    `}));
    plugin.onResolve({filter:/advanced-imessage\/dist\/index\.js$/},args=>({path:args.path,external:true}));
  }}],
});

test('verified Photon sessions ingress emits a usable owner-bound manager link exactly once',async()=>{
  const fixture=await startManagerFixture(api,'signed-ingress');
  const downstreamFetch=globalThis.fetch;
  const proxySockets=new Set();
  const [,socketPath]=await fixture.redis.command('CONFIG','GET','unixsocket');
  const redisProxy=createServer(client=>{
    const upstream=connect(socketPath);proxySockets.add(client);proxySockets.add(upstream);
    client.pipe(upstream).pipe(client);
    for(const stream of [client,upstream]){stream.on('error',()=>{});stream.on('close',()=>proxySockets.delete(stream));}
  });
  redisProxy.listen(0,'127.0.0.1');await once(redisProxy,'listening');
  process.env.REDIS_URL=`redis://127.0.0.1:${redisProxy.address().port}`;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'||input instanceof URL ? input : input.url);
    if(url.origin==='https://spectrum.photon.codes' && ['/projects/fixture-project/','/projects/fixture-project/platforms/'].includes(url.pathname)) return Response.json({succeed:true,data:{}});
    if(url.origin==='https://spectrum.photon.codes'&&url.pathname==='/projects/fixture-project/imessage/tokens'){
      assert.equal(new Headers(init?.headers).get('authorization'),`Basic ${Buffer.from('fixture-project:fixture-secret').toString('base64')}`);
      return Response.json({succeed:true,data:{type:'shared',token:'fixture-imessage-token',expiresIn:3600}});
    }
    if(url.origin==='https://template.example'){
      const route=api.managerChannel.routes.find(r=>r.method==='GET'&&r.path===url.pathname);
      assert.ok(route,`manager metadata fetch ${url.pathname}`);
      return route.handler(new Request(url));
    }
    return downstreamFetch(input,init);
  };
  const route=api.photon.routes.find(r=>r.method==='POST');
  const pending=[];
  const context={waitUntil:p=>pending.push(p),from:()=>{throw new Error('Session manager must not invoke a model');},attachSession:()=>{throw new Error('Session manager must not attach a model session');}};
  const payload=JSON.stringify({event:'messages',space:{id:'iMessage;-;+15555550123'},message:{id:'fixture-inbound-sessions',direction:'inbound',timestamp:new Date().toISOString(),sender:{id:'+15555550123'},content:{type:'text',text:'sessions'}}});
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=`v0=${createHmac('sha256',webhookSecret).update(`v0:${timestamp}:${payload}`).digest('hex')}`;
  const request=sig=>new Request(`https://template.example${route.path}`,{method:'POST',headers:{'content-type':'application/json','x-spectrum-timestamp':timestamp,'x-spectrum-signature':sig,'x-spectrum-event':'messages'},body:payload});
  try{
    assert.equal((await route.handler(request('v0=invalid'),context)).status,401);
    assert.equal(sent.length,0);
    assert.equal((await route.handler(request(signature),context)).status,200);
    await Promise.all(pending.splice(0));
    assert.equal(sent.length,1,'signed ingress produces one fixture card');
    assert.equal(sent[0].chat,'iMessage;-;+15555550123');
    const url=new URL(sent[0].content.url);
    assert.equal(url.pathname,'/eve/v1/photon-workspaces');
    assert.match(url.hash,/^#[A-Za-z0-9_-]{43}$/);
    const manager=await fixture.post('/state',{managerToken:url.hash.slice(1)});
    assert.equal(manager.status,200);
    assert.equal(manager.body.workspaces.length,1);
    assert.equal(manager.body.workspaces[0].name,'Main');
    assert.equal((await route.handler(request(signature),context)).status,200);
    await Promise.all(pending.splice(0));
    assert.equal(sent.length,1,'same signed ingress is idempotent');
    delete process.env.PHOTON_ALLOWED_PRINCIPALS;
    assert.equal((await fixture.post('/state',{managerToken:url.hash.slice(1)})).status,410,'revoking the owner invalidates the bearer');
  }finally{
    await api.photonBot.shutdown();
    for(const socket of proxySockets)socket.destroy();
    await new Promise(r=>redisProxy.close(r));
    await fixture.close();
    delete globalThis[providerKey];
    for(const key of ['REDIS_URL','IMESSAGE_PROJECT_ID','IMESSAGE_PROJECT_SECRET','IMESSAGE_WEBHOOK_SECRET'])delete process.env[key];
  }
});
