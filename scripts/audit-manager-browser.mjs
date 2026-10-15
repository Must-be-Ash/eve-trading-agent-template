import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.EVE_AUDIT_PLAYWRIGHT_MODULE ?? 'playwright');
import {loadManagerApi,startManagerFixture} from '../tests/helpers/manager-fixture.mjs';
// Optional browser acceptance: supply Playwright separately, then run from the repo.
// The real generated client and HTTP handlers run against disposable Redis.
// X is a provider fixture; Eve's reset transport is acknowledged locally.
const api = await loadManagerApi();
const fixture = await startManagerFixture(api, 'browser-manager');
const errors = [], requests = [];
let server, browser;
try {
  server = createServer(async (req,res) => {
    try {
      let body = ''; for await (const data of req) body += data;
      const route = api.managerChannel.routes.find(r => r.method === req.method && r.path === req.url);
      if (!route) {res.writeHead(404);res.end();return;}
      const response = await route.handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
        method:req.method,headers:req.headers,...(body ? {body}:{}),
      }),{attachSession: () => ({reset: async () => ({status:'reset'})})});
      requests.push({path:req.url,status:response.status});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    } catch(e) {errors.push(e.stack);res.writeHead(500);res.end('Fixture failed');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  await page.route('**/*',route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  page.on('pageerror',e=>errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/eve/v1/photon-workspaces#${fixture.manager.managerToken}`);
  await page.locator('main[aria-busy="false"]').waitFor();
  await page.locator('#new-name').fill('Browser Research');
  await page.locator('#create-form button').click();
  await page.locator('#status').filter({hasText:'Active session: Browser Research'}).waitFor();
  await page.locator('#pack-name').fill('Browser X Monitor');
  await page.locator('input[type=url]').fill('@fixture_desk');
  await page.getByRole('button',{name:'Resolve public X identity',exact:true}).click();
  await page.getByText('Fixture Desk · @fixture_desk · X user ID 123456789',{exact:true}).waitFor();
  await page.getByLabel('Confirm this display name and pinned numeric X user ID').check();
  await page.locator('#pack-configuration-monitoringObjective').fill('Watch public comments about market liquidity.');
  await page.locator('#pack-configuration-topics').fill('liquidity');
  await page.locator('#pack-configuration-impactHypotheses').fill('improving liquidity|BTC|up');
  await page.getByRole('button',{name:'Create pack session',exact:true}).click();
  await page.locator('#status').filter({hasText:'Strategy-pack created'}).waitFor();
  let state = await fixture.state();
  const installed = state.workspaces.find(w=>w.name==='Browser X Monitor');
  assert.ok(installed);
  assert.equal(installed.monitors[0].lifecycleState,'paused');
  assert.equal(installed.strategyPack.configuration.alerts,'disabled');
  const card = name => page.locator('article').filter({has:page.getByText(name,{exact:true})});
  await card('Browser X Monitor').getByRole('button',{name:'Resume',exact:true}).click();
  await card('Browser X Monitor').getByRole('button',{name:'Pause',exact:true}).waitFor();
  state = await fixture.state();
  assert.equal(state.workspaces.find(w=>w.id===installed.id).monitors[0].lifecycleState,'enabled');
  await card('Browser X Monitor').getByRole('button',{name:'Edit schedule',exact:true}).click();
  await card('Browser X Monitor').locator('input[type=number]').fill('30');
  await Promise.all([page.waitForResponse(response=>response.url().endsWith('/runtime-action')),
    card('Browser X Monitor').getByRole('button',{name:'Save schedule',exact:true}).click()]);
  state = await fixture.state();
  assert.equal(state.workspaces.find(w=>w.id===installed.id).monitors[0].schedule.everyMinutes,30);
  await card('Browser X Monitor').getByRole('button',{name:'Pause',exact:true}).click();
  await card('Browser X Monitor').getByRole('button',{name:'Resume',exact:true}).waitFor();
  await card('Browser X Monitor').getByRole('button',{name:'Start fresh',exact:true}).click();
  await card('Browser X Monitor').getByRole('button',{name:'Confirm start fresh',exact:true}).click();
  await page.locator('#status').filter({hasText:'Started fresh in'}).waitFor();
  await card('Main').getByRole('button',{name:'Switch here',exact:true}).click();
  await page.locator('#status').filter({hasText:'Active session: Main'}).waitFor();
  await card('Browser X Monitor').getByRole('button',{name:'Archive',exact:true}).click();
  await card('Browser X Monitor').getByRole('button',{name:'Confirm archive',exact:true}).click();
  await page.locator('#status').filter({hasText:'Archived'}).waitFor();
  await page.locator('#show-archived').check();
  await card('Browser X Monitor').getByRole('button',{name:'Restore session',exact:true}).click();
  await page.locator('#status').filter({hasText:'Restored'}).waitFor();
  state = await fixture.state();
  const restored = state.workspaces.find(w=>w.id===installed.id);
  assert.equal(restored.generation,installed.generation+1);
  assert.equal(restored.status,'active');
  assert.equal(restored.strategyPack.state,'active');
  assert.equal(restored.monitors[0].lifecycleState,'paused');
  await page.screenshot({path:join(process.env.EVE_AUDIT_OUTPUT_DIR ?? tmpdir(), 'eve-manager-browser-final.png'),fullPage:true});
  console.log('BROWSER JOURNEY PASSED', {sessions:state.workspaces.length,restoredGeneration:restored.generation,monitor:restored.monitors[0].lifecycleState});
  assert.equal(new URL(page.url()).hash,'');
  assert.deepEqual(errors,[]);
  console.log('REQUESTS',requests);
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await fixture.close();}
