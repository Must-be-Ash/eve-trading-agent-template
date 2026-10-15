# Eve gallery submission

Researched on October 15, 2026. This repository is an open-source submission candidate,
not an accepted or published Eve template.

## What the examples establish

The [Marketing Team](https://eve.dev/templates/marketing-team-eve-template),
[Kody](https://eve.dev/templates/kody-eve-template), and
[OpenInstinct](https://eve.dev/templates/openinstinct-eve-template) examples present
a clear use case, GitHub source, setup instructions, dependencies, and integration
configuration. They range from focused agents to full applications. Kody demonstrates
custom Chat SDK channels and Redis; OpenInstinct includes a substantial frontend.
Their feature counts are not a template limit.

This template retains one owner with multiple Photon sessions, durable background
workers, scheduled X monitors and alerts, Coinbase spot trading and cancellations,
approvals, and artifact views. One configurable X playbook remains. Specialized
pipelines, personal configuration, AgentCash, Masterkey, and Telegram are removed.
The examples support this feature depth; their pattern is a coherent, independently
configurable application rather than a fixed maximum number of features.

## Actual listing mechanism

Eve's [gallery manifest](https://github.com/vercel/eve/blob/main/apps/docs/lib/templates/manifest.ts)
defines curated entries. Its [sync script](https://github.com/vercel/eve/blob/main/apps/docs/scripts/sync-templates.ts)
loads a repository README and selected source files from GitHub. There is no
repository-side `template.json` registration contract. The public sync path requires a public repository. Making the source public
does not automatically register or approve a gallery listing.

The [standalone-template guidance](https://github.com/vercel/eve/blob/main/apps/templates/README.md)
expects independent package/configuration files, a lockfile, a normal published Eve
dependency, and no imports back into a parent workspace. This repository follows
that structure. Its build and tests are the local acceptance gates.

## Proposed listing

This is a draft for maintainers to adapt, not a submitted registration:

```ts
{
  slug: "eve-trading-agent-template",
  title: "iMessage Trading Assistant",
  description: "A personal iMessage trading assistant with Coinbase market data, approved spot trades, isolated sessions, scheduled X alerts, and shareable research.",
  category: "Chat",
  integrations: ["HTTP API", "Vercel"],
  model: "openai/gpt-5.4",
  source: "GitHub",
  sourceHref: "https://github.com/Must-be-Ash/eve-trading-agent-template",
  setupPrompt: "Set up the Eve Trading Agent from https://github.com/Must-be-Ash/eve-trading-agent-template. Read its README, install pinned dependencies, and use new dedicated resources. Preserve the protected Photon channel and approval controls. Configure secrets through encrypted settings, never chat. Do not place a trade or send a test message without my explicit instruction. Report the remaining account, phone-verification, and deployment steps.",
  github: { owner: "Must-be-Ash", repo: "eve-trading-agent-template", ref: "main" },
  files: [
    "agent/agent.ts",
    "agent/instructions.md",
    "agent/channels/photon.ts",
    "agent/channels/photon-approval-app.ts",
    "agent/tools/coinbase_preview_order.ts",
    "agent/tools/coinbase_create_order.ts",
    "agent/tools/coinbase_cancel_order.ts",
    "agent/channels/photon-workspace-app.ts",
    "agent/schedules/monitors.ts",
    "agent/tools/publish_report.ts",
    "agent/skills/coinbase.md",
    "agent/skills/artifact-publishing.md",
  ],
}
```

`HTTP API` and `Vercel` are existing gallery labels. Ask the maintainers whether to
add `Photon` and `Coinbase` as dedicated labels. A demo URL is optional; do not claim
a live demo until a separate deployment has been configured and checked.

## Before proposing the listing

1. Review the repository and complete owner-controlled deployment and
   Photon/Coinbase acceptance with new credentials and resources.
2. Add representative screenshots from that deployment using public sample data.
3. Keep the repository public and its GitHub template flag enabled so others can
   use it without inheriting history.
4. Follow Eve's [contribution policy](https://github.com/vercel/eve/blob/main/CONTRIBUTING.md):
   propose the addition in an issue and obtain a maintainer invitation before an
   upstream PR. Follow their signing and DCO requirements for that contribution.
5. Adapt the manifest entry to the current schema, run the upstream sync/build,
   and let maintainers review it. Acceptance is their decision.

No upstream issue, PR, Eve gallery listing, or service deployment was created as
part of preparing this repository.
