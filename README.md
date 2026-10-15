# Eve Trading Agent

A personal iMessage trading assistant built with [Eve](https://eve.dev),
[Photon](https://eve.dev/docs/channels/photon), and
[Coinbase for Agents](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp#cli).
Ask about the market, inspect your account, review a spot order, and share a report.

This is a standalone starter extracted from [Adaam](https://github.com/Must-be-Ash/adaam).
It contains no existing accounts, deployment links, watchlists, or scheduled work.

## Included

- **iMessage:** one authorized owner, persistent sessions, Redis-backed message state.
- **Coinbase:** market data and account/order reads, plus previewed spot buys and sells.
- **Approvals:** an expiring iMessage mini-app with exact order terms, approve/deny,
  and protection against duplicate or uncertain execution.
- **Artifacts:** reports, line/bar/pie/candlestick/depth charts, images, audio, video,
  PDFs, and downloadable files, with a Next.js viewer.

AgentCash, Masterkey, Telegram, playbooks, strategy pipelines, monitors, schedules,
workspace management, transfers, withdrawals, and autonomous trading are excluded.
Shell, filesystem, web-search, web-fetch, and delegation tools are disabled. Market
research uses the Coinbase tools. Media publishers accept existing files; they do
not generate media.

## Setup

Use Node.js 24 and npm. You need your own model access, Photon project, Coinbase
account/API key, a dedicated Upstash Redis database, and a public Vercel Blob store.
These services can incur costs. Creating a clone does not provision them.

```sh
git clone https://github.com/Must-be-Ash/eve-trading-agent-template.git
cd eve-trading-agent-template
npm ci
cp .env.example .env.local
```

Set configuration directly in `.env.local` for development or encrypted deployment
environment variables. Never paste secrets into a conversation or commit them.

### 1. Model and owner

Set `AI_GATEWAY_API_KEY` for local use. Vercel deployments can use their project
OIDC token for AI Gateway. `EVE_MODEL` defaults to `openai/gpt-5.4`.

Set `PHOTON_ALLOWED_PRINCIPALS` to exactly one E.164 phone identity, for example
`imessage:+15551234567` (replace the example). Put the same identity in
`COINBASE_ALLOWED_PRINCIPALS`. Both checks must allow the caller before account
access or trading. Empty configuration denies access. Group chats are rejected.

### 2. Redis and artifacts

Create a **new dedicated** Upstash Redis database and configure all three URLs/tokens
from that database:

| Variable | Used for |
| --- | --- |
| `REDIS_URL` | TLS Redis connection for the Photon Chat SDK |
| `KV_REST_API_URL` | Redis REST endpoint for approvals and trading journal |
| `KV_REST_API_TOKEN` | Redis REST token |

Create a **public** Vercel Blob store for this project and set
`BLOB_READ_WRITE_TOKEN`. Set `PUBLIC_APP_URL` to the app's public HTTPS origin.
On Vercel, the project production URL is used when this variable is omitted.
Approval cards and artifacts need a URL the owner's phone can reach.

**All artifacts are public to anyone with the link.** Account balances, holdings,
orders, and private conversation content belong in chat. `publicDataOnly: true`
and agent instructions are publication safeguards, not automatic redaction.

### 3. Photon

Use a new Photon project and its own phone connection. Choose one credential path:

- **Portable credentials:** configure `IMESSAGE_PROJECT_ID` and
  `IMESSAGE_PROJECT_SECRET` from your Photon project. Create a webhook for
  `https://YOUR_APP/eve/v1/photon`, then set its signing secret as
  `IMESSAGE_WEBHOOK_SECRET`. All three are required for direct delivery.
- **Vercel Connect:** attach your own Photon connector to this Vercel project and
  environment, including inbound webhook delivery to `/eve/v1/photon`. Set
  `PHOTON_CONNECTOR_ID` to its connector ID. Credentials stay in Connect; forwarded
  webhooks use the Connect verifier.

Follow the [Photon setup guide](https://eve.dev/docs/channels/photon) for account
and number verification. Eve's guided `eve add channel/photon-imessage` setup
generates a basic channel; **do not overwrite this template's customized
`agent/channels/photon.ts`**. If using the wizard, run it in a disposable setup
project, then configure this template with the resulting credentials or connector.
Do not reuse an existing Adaam deployment's connector or storage.

### 4. Coinbase

Follow the [Coinbase CLI setup](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp#cli)
to create a CDP API key for Coinbase Advanced Trade. Use a dedicated, minimally
funded spot portfolio, with the permissions needed to view and trade. Configure
`COINBASE_KEY_ID` and `COINBASE_KEY_SECRET` on the server. Preserve the key's PEM
newlines or escaped newlines as provided by Coinbase.

The template uses the pinned official `@coinbase/coinbase-cli` package as a stdio
MCP server. The build embeds it for serverless execution. It exposes a narrower
set of tools than the CLI itself; it has no x402 purchasing or transfer tools.

Every spot order requires a fresh exact preview and explicit approval. The preview
binds the product, side, size, prices, owner, and expiry. Coinbase's client order ID
and the durable mutation journal prevent automatic duplicate submissions. A timeout
can leave an order uncertain; inspect its status rather than retrying it. There is
no aggregate trading budget: portfolio funding and per-order approval are the controls.
Use Coinbase directly to edit or cancel existing orders.

## Develop and deploy

```sh
npm run dev             # Next.js plus the local Eve runtime
npm run check           # typecheck and offline tests
npm run build           # Eve runtime plus Next.js production build
npm start              # serve the local production build
```

The home page explains the template; it is not a browser trading terminal.
The Eve terminal can be used locally, but local HTTP identities cannot trade.
Production HTTP session routes require same-project Vercel OIDC; user trading
enters only through the verified Photon channel.

For Vercel, import your own repository as a new Next.js project, use Node.js 24,
connect its dedicated resources, and configure the variables above. The Next.js
build command is `npm run build:web`; the generated Eve service runs
`npm run build:agent`. `withEve` supplies the service routing. Set the canonical
HTTPS URL, complete Photon verification, and deploy. Inbound Photon webhooks and
the approval/artifact pages must be reachable under your deployment protection policy.

After deployment, verify `/eve/v1/health`, confirm unauthenticated session requests
are rejected, and text the agent from your authorized number. Start with a market
lookup and `coinbase_access_status`. Review and deny a preview before choosing
whether to authorize a real trade. Deployment, phone verification, and live trading
acceptance are separate owner actions; offline tests do not prove them.

## Approval and privacy model

Approval links are short-lived bearer capabilities delivered to the owner's chat;
anyone with the complete link can attempt to use it. Tokens are random, stored
hashed, and carried in the URL fragment. Decisions remain bound to the original
owner, thread, session, request, and preview. Share artifacts deliberately; never
share approval links.

Redis stores approval and execution records, while Eve stores conversation history.
Treat these as private application data. Use separate resources for each deployment
and control access through your hosting accounts.

## Project map

```text
agent/
  agent.ts               Model and session limits
  instructions.md        Small trading-assistant contract
  channels/              Photon, approval mini-app, protected Eve HTTP
  tools/                 Coinbase, artifact publishers, disabled defaults
  skills/                Coinbase and artifact procedures
  lib/                   Authorization, approvals, trading journal, artifacts
app/
  page.tsx               Template landing page
  artifacts/[artifactId] Report and media viewers
tests/                   Offline safety and behavior checks
docs/submission.md       Gallery research and draft listing
```

Pinned dependencies and the lockfile make the starter reproducible. Before changing
Eve versions, read the installed package docs and rerun the checks. Start fresh
sessions when changing runtime compatibility; do not move Adaam sessions into this app.

## Template submission

The repository is private while under review. See [submission notes](docs/submission.md)
for the gallery pattern, proposed listing, and remaining publication steps. It has
not been submitted to Eve or deployed by this extraction.

MIT licensed. Selected components retain Adaam's 2026 Ash Nouruzi copyright.
