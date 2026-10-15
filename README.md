# Eve Trading Agent

A personal iMessage assistant built with [Eve](https://eve.dev),
[Photon](https://eve.dev/docs/channels/photon), and
[Coinbase for Agents](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp#cli).
Keep separate conversations, research markets in the background, receive X alerts,
and approve spot trades from your phone.

This standalone template reuses the working components of
[Adaam](https://github.com/Must-be-Ash/adaam). It contains no credentials, connected
accounts, personal watchlists, production deployment configuration, or running monitors.

## Included

| Feature | Behavior |
| --- | --- |
| Photon session manager | One owner, multiple isolated conversations; switch, archive, restore, or start fresh |
| Durable background work | Scoped workers, checkpoints, occurrence leases, bounded budgets, and replay protection |
| Scheduled X monitoring | One configurable playbook; one X account per session, owner-selected topics and notification conditions |
| Alerts | Delivered to the owner's iMessage conversation; replies reopen the relevant session |
| Coinbase | Market and account reads, previewed spot buys/sells, and approved cancellation of one open order |
| Approvals | Exact order terms or cancellation ID, expiry, owner/session binding, and duplicate-execution protection |
| Artifacts | Public reports, charts, images, PDFs, audio, video, and files with a Next.js viewer |
| Public research | Eve's built-in web tools plus the X playbook's bounded research lane |

AgentCash, Masterkey, Telegram, other playbooks and their dedicated pipelines,
transfers, conversions, portfolio administration, and media-generation providers
are excluded. Background workers cannot trade or read Coinbase account information.
Shell/file tools and unrestricted delegation are disabled. Separate session workers
and the signed research subagent remain available through their controlled runtime.

## Setup

Use Node.js 24 and npm. Local agent sessions use a Docker-compatible daemon with
network-disabled containers; hosted sessions use Vercel Sandbox with denied egress.
Tools call their explicitly configured services from the app server. Builds and
offline tests do not start containers or contact trading/messaging providers.

```sh
git clone https://github.com/Must-be-Ash/eve-trading-agent-template.git
cd eve-trading-agent-template
npm ci
cp .env.example .env.local
```

Use **new, dedicated resources**. Set secrets directly in `.env.local` or encrypted
deployment settings, never chat or Git. Cloning does not provision services.
Model, Photon, X, Exa, Redis, Blob, hosting, and sandbox usage may incur costs.

### Owner and model

Set `PHOTON_ALLOWED_PRINCIPALS` to exactly one E.164 identity such as
`imessage:+15551234567`, replacing the example. Use the same identity in
`COINBASE_ALLOWED_PRINCIPALS`. Both checks must pass before Coinbase access.
Group chats and non-Photon trading identities are rejected.

Set a stable `EVE_DEPLOYMENT_OWNER_ID` and generate independent 32-byte base64url
secrets for `EVE_OWNER_ALIAS_HMAC_SECRET`, `EVE_WORKSPACE_RUNTIME_AUTH_SECRET`, and
`EVE_HYBRID_EVIDENCE_AUTH_SECRET`:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Run that command separately for each secret and store the outputs securely.
Changing the owner ID or alias secret changes durable routing identities; use fresh
storage for a new owner. Do not import existing Adaam sessions.

Set `AI_GATEWAY_API_KEY` locally. Hosted Vercel may use project OIDC for Gateway.
The interactive model defaults to `openai/gpt-5.4`; `EVE_MODEL` can override it.
Background model IDs must match the playbook's pinned contracts.

### Redis and Blob

Create a dedicated Upstash Redis database and configure `REDIS_URL` for the Chat
SDK's TLS connection plus `KV_REST_API_URL` and `KV_REST_API_TOKEN` for the same
database's REST connection. The stores retain routing, approvals, budgets, and
execution receipts. Do not point a development or preview deployment at production
storage. `UPSTASH_REDIS_REST_URL/TOKEN` are supported REST aliases.

Use two Blob stores:

- **Public artifacts:** `BLOB_READ_WRITE_TOKEN` for reports and media intended to be shared.
- **Private worker evidence:** `EVE_HYBRID_EVIDENCE_READ_WRITE_TOKEN` for the X research runtime.

Set `PUBLIC_APP_URL` to the public HTTPS application origin. On Vercel the production
project URL is the fallback. Phones must be able to open the mini-app and artifact routes.

**Artifacts are public to anyone with the URL.** Keep balances, holdings, trade
details, account identifiers, and private conversation content in chat.
`publicDataOnly: true` and agent instructions are publication safeguards, not
automatic redaction. The template does not publish account data automatically.

### Photon

Connect your own Photon project and phone. Choose one credential path:

- **Direct credentials:** set all three of `IMESSAGE_PROJECT_ID`,
  `IMESSAGE_PROJECT_SECRET`, and `IMESSAGE_WEBHOOK_SECRET`. Register the webhook at
  `https://YOUR_APP/eve/v1/photon` and use its signing secret.
- **Vercel Connect:** attach your own Photon connector and configure inbound
  delivery to `/eve/v1/photon`; set `PHOTON_CONNECTOR_ID`. Connect supplies credentials
  and verifies forwarded webhooks.

Complete account/number verification using the
[Photon guide](https://eve.dev/docs/channels/photon). The registry's basic Photon
channel does not include this template's session manager and safeguards; do not
run `eve add channel/photon-imessage` over these customized files.

### Coinbase

Follow the [official CLI setup](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp#cli)
for your Coinbase Advanced Trade API key. Give it only the view/trade permissions
needed for your chosen spot portfolio. Set `COINBASE_KEY_ID` and
`COINBASE_KEY_SECRET`; preserve PEM newlines or escaped newlines.

The pinned official `@coinbase/coinbase-cli` runs as a stdio MCP server with an
isolated environment. Build preparation embeds the CLI for serverless execution.
The exposed tools are narrower than the CLI itself.

Buying and selling require a fresh preview and an explicit approval card. The
preview binds product, side, size, prices, owner, and expiry. Cancellation requires
approval for one exact open spot order ID and only affects its remaining open
portion. A timeout or ambiguous response retains the execution guard; inspect
Coinbase state instead of automatically retrying. There is no aggregate trading
budget: the owner's portfolio and per-order approvals control trading funds.

## Sessions, X monitors, and alerts

Text `sessions` to the owner-authorized agent to open its session manager. Create ordinary
conversations or install the **Public Commentary Tracker** playbook in a new
session. X-monitor creation uses the manager's account-resolution and confirmation
flow; chat tools inspect and manage existing monitors. Each instance tracks one
explicitly selected X account; create additional
sessions to follow additional accounts. Existing conversations and findings remain
isolated when you switch between them.

X monitoring additionally needs:

- `X_BEARER_TOKEN` with access to official user lookup and timeline endpoints.
- `EXA_API_KEY` for supplementary public research when the research worker requests it.
- `EVE_PUBLIC_COMMENTARY_EVIDENCE_KEY_BASE64`: 32 random bytes encoded as standard
  base64, plus a stable `EVE_PUBLIC_COMMENTARY_EVIDENCE_KEY_REFERENCE` label such as
  `kms://template/evidence-v1` (the label identifies your configured key; it does not provision a KMS).
- The private evidence Blob token and signed-worker secrets described above.
- Access to the pinned compact model `google/gemini-3.7-flash` and research model
  `openai/gpt-5.4-mini`, as configured in `.env.example`.

Resolve the account in the manager, then supply your monitoring objective, topics,
and impact hypotheses (which outcomes matter to which assets and in what direction).
Choose confidence/materiality thresholds, replies/quotes, cadence, and alert settings.
No account, political theme, asset list, or trading strategy is preselected.
New monitors start **paused**, with alerts disabled. The first resumed check can
include posts from the configured cadence lookback; it is not a complete historical baseline.

The example enables session management and configuration while leaving background
execution off. After reviewing credentials, current provider pricing, session budget,
and the configured account, enable these flags together:

```dotenv
EVE_WORKSPACE_DISPATCH_ENABLED=1
EVE_WORKSPACE_PAID_RESEARCH_ENABLED=1
EVE_PHOTON_WORKSPACE_ALERTS_ENABLED=1
EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED=1
EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED=1
EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED=1
EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED=1
EVE_X_MONITOR_EXECUTION_ENABLED=1
EVE_HYBRID_EVIDENCE_ENABLED=1
EVE_HYBRID_SEMANTIC_REASONING_ENABLED=1
```

Then enable the desired alert setting and explicitly resume the configured monitor
in the manager or chat. `EVE_WORKSPACE_SOURCE_EVENTS_ENABLED` stays off: this
playbook uses scheduled polling. `EVE_EXA_CORROBORATION_ENABLED` controls a separate,
optional preclassification search; turning it off does **not** disable the research
worker's Exa search. All work must still pass budget admission.

The scheduler supports interval, one-time, and daily schedules with an IANA timezone,
including multiple daily times. Change account/topic configuration through the
playbook flow; change cadence through monitor controls. Archive pauses work, restore
leaves it paused, and start-fresh advances the conversation generation while retaining
durable workspace state. Alerts carry their source session; ambiguous replies offer
a choice rather than guessing.

Budget reservations are conservative admission estimates, not proof of actual billing.
Known usage is reconciled; uncertain work retains its reservation and may pause the
monitor. X retrieval, Gateway, and Exa prices must be checked against your accounts.
The deployment caps in `.env.example` supplement per-session limits; they are not an
all-services invoice cap. The inherited `EVE_HYBRID_SOURCE_RECOVERY_*` variable names
also govern semantic child workers. Unknown X worker outcomes are quarantined and
paused; this template does not automatically repeat uncertain paid work. A timeline
window that exceeds the bounded pagination allowance also pauses for inspection;
its saved pages are retained, but automatic continuation is not included. Shorter
cadences reduce the number of posts each window must cover.

## Develop and deploy

```sh
npm run dev             # Next.js with Eve integration
npm run dev:agent       # standalone Eve development server
npm run check           # typecheck plus offline behavioral tests
npm run build           # Eve and Next.js production builds
npm start               # serve the Next.js production build
```

Offline tests require `redis-server` installed locally (CI installs it). Tests use
disposable local stores and fixture providers. No model calls, trades, messages,
provider lookups, or public artifact publication are used for acceptance.

Import the repository into a **new** Vercel project with Node.js 24. Use
`npm run build:web` as the Next.js build command; `withEve` configures the generated
Eve service to run `npm run build:agent`. Connect the new resources and configuration,
set the canonical HTTPS URL, and deploy. Verify Eve's generated monitor cron is
present; `eve dev` does not automatically run schedules. Custom self-hosting must
run the Eve production server/scheduler as well as the frontend.

Production Eve session routes require same-project Vercel OIDC. User trading enters
through verified Photon. Keep webhook and mini-app routes reachable under your
hosting protection policy. The landing page is informational, not a trading terminal.

Complete live acceptance with your own accounts: verified inbound owner message,
session switching, a market lookup, a denied order preview, and a deliberately
resumed small-budget monitor with alert/reply routing. Offline tests do not prove
provider credentials, phone delivery, model access, or live deployment configuration.

## Security and maintenance

Approval links are short-lived bearer capabilities delivered to the owner's chat.
Tokens are random, stored hashed, and carried in the URL fragment. Decisions bind
the original owner, thread, session/generation, request, and exact preview. Do not
share approval links. Redis and Eve history are private application data.

The runtime bridge in `packages/` is bundled locally and pins Eve 0.33.0 because it
uses that version's internal durable worker interface. Upgrade the bridge and Eve
together and rerun checks. Public schemas and playbook digests are validated during
build preparation; do not edit generated catalogs manually.

## Project map

```text
agent/channels/     Photon, session manager, alerts, approvals, protected Eve HTTP
agent/tools/        Coinbase, artifacts, playbook and monitor controls
agent/schedules/    One durable monitor dispatcher
agent/subagents/    Signed, bounded research worker
agent/lib/          Authorization, sessions, budgets, evidence, replay-safe stores
strategy-packs/     One configurable X playbook
app/artifacts/     Public report/chart/media viewers
packages/          Pinned Eve runtime bridge, included in this repository
tests/             Offline behavioral and safety checks
docs/submission.md Gallery research, draft listing, remaining publication steps
```

The repository remains private for review. It has not been submitted to Eve or
deployed by this extraction. The [submission notes](docs/submission.md) describe the
curated gallery process and the later public-repository requirement.

MIT licensed. Reused Adaam components retain the 2026 Ash Nouruzi copyright.
