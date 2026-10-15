# Independent pre-Eve acceptance

Audit date: October 15, 2026. Baseline: `dfc6339ffcac8390774b0c3d265a72cfde5a58b8`.
Audited code and executable evidence: **`0f3166d0a936f1ef2bee1e040541345aff4dc2cf`**,
local branch `codex/pre-eve-e2e-audit`. This report is a subsequent documentation-only
commit; it does not change the tested runtime or fixtures.

**Verdict: do not share the unchanged public baseline as an accepted template.**
Eight confirmed blockers were repaired locally. The patched commit passes local
acceptance and is ready for maintainer review with the limits below; it is **not
live-accepted or production-certified**. Publishing these local changes and doing
owner-controlled live acceptance remain separate actions. This audit did neither.

This audit uses an anonymous clone, synthetic owner/provider data, disposable real
Redis, and the pinned installed Eve runtime. It does not use the originating
application's accounts, configuration, resources, or credentials. Actual provider
spend is **$0**. Token/cost reservations exercised by tests are local ledger data,
not provider charges. Nothing was pushed, deployed, submitted, or sent to a person.

## Scope of the evidence

### Relationship to Adaam

A subsequent read-only source comparison used Adaam commit
`dcb15c82b5cd7db7c50ec71051bad62b8278ae24` as the working implementation reference.
The template retains Adaam's session, approval, monitoring, research and artifact
plumbing. The runtime bridge JavaScript and type declarations are byte-identical;
its package version change adds licensing metadata. The scheduler is extracted
from Adaam's event dispatcher with unsupported event/earnings paths removed. One
configurable X playbook remains, alongside Photon, Coinbase and artifact views.

Seven of the eight audited failure patterns also exist in the compared Adaam
source. That establishes shared provenance, not observed Adaam production failures.
Adaam has no simpler corrected implementation of those paths to copy. The remaining
failure was introduced when template commit `ed1eae8` added deployment-wide semantic
budget caps but omitted accepted-result settlement. Its repair reuses the existing
receipt and ledger helper, preserving that protection. None of the eight repairs
introduces a separate service or parallel runtime. No additional runtime changes
were needed after the comparison, and Adaam itself was not modified.

`proved locally` means an asserted executable result with the stated external
fixtures. `proved live` requires the real configured service; there are no such
claims in this audit. `blocked` identifies a missing prerequisite or action outside
the authorized audit. `not exercised` identifies a remaining verification gap.

The tests retain product authorization, manager handlers, configuration receipts,
Redis transactions, scheduling, evaluator, findings, approval state, and publication
logic. Fixtures substitute external X/model/Coinbase/Photon/Blob responses. The
manager's session-reset transport is acknowledged by a fixture; that is not proof
of a hosted model session being terminated. The Coinbase tool-loop test uses the
actual installed Eve harness with serialized session state, not a hosted Workflow
restart. These distinctions matter when interpreting the matrix.

The positive monitoring test loads the compiled Eve manifest and actual local
Workflow runtime, runs the real evaluator and semantic/research tools, and uses
the real signed Photon ingress and durable reply handlers. Its sandbox backend is
an in-memory Docker provider fixture which preserves the authored `deny-all` policy
and permits no real shell execution. This is not a real Docker or hosted sandbox test.

## Reproduce

Use Node 24 and a local `redis-server`. No provider credentials are needed. Start
with a clean clone and follow this order; default checks do not require build output.

```sh
npm ci
npm run check
npm run build
node scripts/audit-production-http.mjs
node scripts/audit-monitoring-positive.mjs
```

The optional generated-client browser journey requires a separately available
Playwright installation and Chromium; it does not add a production dependency.

```sh
EVE_AUDIT_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/audit-manager-browser.mjs
```

Set `EVE_AUDIT_OUTPUT_DIR` to an existing directory to save the HTTP evidence and
browser screenshot there. Both default to the operating system temporary directory.
The positive worker audit intentionally runs after `npm run build`: it loads the
real compiled Eve worker manifest and local Workflow runtime. It must not be
replaced by supplying a completed evaluator result.

## Remaining owner acceptance

Before calling this a live-accepted deployment, provision separate resources from
the README, verify real owner phone/Photon ingress and card taps, validate Coinbase
read/preview/denial compatibility, and accept one deliberately resumed monitor with
an explicit small provider budget and real alert/reply routing. Confirm deployment
protection, cron execution, actual account model access, and billing reconciliation.
Live order execution requires separate explicit financial authorization; it was not
part of this audit. Keep monitors paused until that acceptance is complete.

Actual media decoding/playback and hosted Blob/CDN permission behavior remain
unverified. Local artifact tests prove schemas, publication gates, serialized
manifests, HTML/metadata rendering, escaping, replay, and private/public storage
selection. Minimal media signatures in fixtures are not complete playable files.
Private context canaries test implicit serialization; `publicDataOnly: true` is still
a declaration, not automatic redaction of private values explicitly supplied by a
model or user.

Abandoned private evidence becomes collectible after its 30-minute reader reference
expires; the existing collector sweeps it on the next acquisition. This is not a
guarantee of deletion at the expiry instant if no later acquisition runs.

## Acceptance matrix

| Contract | Status | Reproduction and evidence |
| --- | --- | --- |
| Anonymous public clone, pinned install without parent workspace resources | proved locally | Credential helper disabled for clone; Node 24.18.0, npm 11.16.0; `npm ci`; no environment file copied |
| TypeScript, default behavioral suite, Eve and Next production builds | proved locally | `npm run check`, `npm run build`; final counts and commit below |
| Production landing/health and unauthenticated session/stream protection | proved locally | `scripts/audit-production-http.mjs`; actual generated servers, 200 landing/health, 401 session/stream, 400 malformed manager state, invalid artifact ID 404 |
| Full local `eve start` with a real sandbox | blocked | Docker executable is absent in the audit environment; generated HTTP entrypoint was exercised directly |
| Signed Photon `sessions` ingress to usable owner-bound manager bearer | proved locally | `tests/manager-ingress.test.mjs`; actual Eve/Chat/Photon stack, invalid HMAC rejection, duplicate card suppression and owner revocation |
| Generated manager browser journey | proved locally | `scripts/audit-manager-browser.mjs`; create/switch/fresh/archive/restore, token-fragment removal, no browser errors |
| Fresh X resolve/explicit identity confirmation/install | proved locally | Browser plus `tests/manager-e2e.test.mjs`; numeric user ID pinned, monitor paused and alerts disabled by default; forged/missing/cross-thread/stale receipt rejection |
| Monitor resume/cadence/pause and restored paused state | proved locally | Browser and manager route tests against real Redis; installed strategy remains active after fresh/restore |
| Rejected archive has no lifecycle side effects | proved locally | Actual stale/invalid requests and barrier-injected concurrent registry edit/new approval; route rejects without suspending monitors |
| Fresh generation retains pack and rejects old runtime bindings | proved locally | `tests/manager-e2e.test.mjs`; real interactive and worker runtime validation; `tests/monitoring-e2e.test.mjs` subsequently runs the refreshed pack |
| Two same-account schedules, duplicate cron claims and no-match durability | proved locally | `tests/monitoring-e2e.test.mjs`; real scheduler/evaluator, separate 10/30-minute windows, durable outcomes/checkpoints, no repeated fetch on replay |
| Installed monitors → actual compiled workers → findings/checkpoints → alerts → originating-session reply | proved locally | `scripts/audit-monitoring-positive.mjs`; two real findings, two SDK fixture cards, discuss action, signed webhook, immutable source-workspace assignment, completed dispatch and delivered reply receipts |
| Final/trailing worker token usage settles both budget ledgers | proved locally | Same script; four settled child reservations, 14 model turns, 14,000 input/1,400 output tokens in both ledgers; subsequent scheduler replay makes no new source/model calls |
| Shared private evidence survives concurrent readers and upload failure | proved locally | Same positive journey plus three real-Redis `tests/evidence-lifetime.test.mjs` regressions; last release removes bytes; expired abandoned reference becomes collectible without erasing its quota usage |
| Paid-work disable flag and zero workspace budget | proved locally | Same test; no provider calls/reservations while disabled; zero-budget denial before X |
| Bounded pagination failure/recovery | proved locally | Same test; at most two pages, no completed outcome/checkpoint, saved pages retained, subsequent inspection pauses without another fetch |
| Unknown X acceptance remains reserved without paid replay | proved locally | Same test; transport failure retains an uncertain paid-source reservation; recovery makes no repeated provider call and commits no outcome/checkpoint |
| Coinbase actual tool loop through preview/card/decision/exact create or cancel | proved locally | `tests/coinbase-e2e.test.mjs`; actual dynamic discovery, authorization and Eve approval lifecycle; fixture mutations only |
| Coinbase deny/expiry/revoked owner/changed preview/stale session | proved locally | Same test; zero writes and no stale-session continuation; card route returns 409 after session replacement |
| Coinbase concurrent/duplicate decision and unknown execution result | proved locally | Same test; exactly one continuation/mutation; unknown result retains durable guard and blocks Start fresh |
| Seven artifact publisher/viewer paths and private evidence separation | proved locally | `tests/artifact-journey.test.mjs`; real publisher tools, Blob manifests, Next page/metadata and React HTML; report/chart/image/PDF/audio/video/file |
| Artifact replay, escaping, noindex and no implicit private-context serialization | proved locally | Same test; public payloads/URLs/metadata/HTML exclude synthetic context canaries; failed final validation prevents subsequent publication |
| SSRF private-address/redirect/DNS rebinding and bounded media fetch | proved locally | Existing `tests/artifacts.test.mjs` and research-fetch tests retained in default suite |
| Known-unstarted retry, uncertain worker/send holds and pending-alert recovery | proved locally | Existing `tests/workspace-dispatch.test.mjs`; component-boundary proof, not a claim of full process-crash recovery |
| Hosted process restart, real provider credentials, phone delivery, cron and hosting policy | not exercised | Requires separately configured owner environment and live acceptance |
| Live financial write or public artifact publication | blocked | Explicitly outside this audit's authorization; no action taken |
| Valid media decoding/playback and deployed Blob/CDN permissions | not exercised | Server-rendered markup and fixture storage are the local evidence only |
| Current Eve submission process and standalone repository documentation | proved locally | README/configuration/code inspection and upstream primary-source review; no submission |

## Findings

The baseline was **not ready**: assembled paths exposed failures that its existing
54 passing tests did not cover. Local repairs preserve model routes, default
budgets, recovery bounds, owner configuration, and approval policy.

| Severity | Defect and effect | Repair and regression |
| --- | --- | --- |
| P1 | A stale or invalid archive request suspended monitors despite rejecting the registry mutation. | Prepare related records read-only; commit registry, approval guard and monitor/due-index updates in the existing atomic CAS. Manager route race regressions. |
| P1 | Start fresh advanced the conversation generation but left the installed pack snapshot stale, breaking new runtime access. | Roll over the current strategy snapshot in the same registry CAS; preserve pack identity/configuration; reject prior generation runtime. |
| P1 | A financial approval could resume an old session after the workspace recorded a replacement within the same generation. | Shared approval workspace validation now rejects a known different durable session. Actual old-card route regression. |
| P1 | The paid-research disable flag did not prevent scheduled X/provider work. | Require that flag before occurrence claims and budget reservation; pending delivery recovery retains its separate gates. |
| P1 | Accepted semantic jobs reconciled only the workspace ledger, leaving shared deployment reservations occupied and blocking research at the default concurrency cap. | Reconcile both existing ledgers from the durable attempt receipt, including accepted-result replay. |
| P1 | One session could delete digest-shared private evidence while another worker still needed it, losing an otherwise valid finding. | Acquire expiring reader references atomically in the existing artifact index; release in `finally`; delete only after all readers finish. Expired abandoned references use the existing collector. Concurrent reader/upload-failure regressions. |
| P1 | External Photon message IDs were validated as internal IDs; a digit-leading UUID failed acknowledgement after sending. | Use a bounded nonempty external message ID; real adapter fixture returns a digit-leading UUID. |
| P1 | Unknown X request acceptance was recorded as a known zero-cost result, releasing its spend allowance. | Retain uncertain paid-source reservations for ambiguous transport/parser results; preserve known receipts and release only reused acquisitions. Actual transport-failure regression. |
| P3, open | An ordinary empty session displays “Unknown pack · unavailable” and an unnecessary removal control. | Cosmetic manager presentation only; session routing remains usable. Kept outside this audit's blocker fixes. |

## Final results and evidence

- Baseline `npm run check`: **54/54 passed**; baseline production build passed.
  These results alone did not establish the assembled journeys.
- Patched `npm run check`: **69/69 passed**, no failures/skips; TypeScript passed.
- Patched `npm run build`: Eve and Next production builds passed.
- Patched compiled positive monitoring audit: **1/1 passed**; real durable outcomes,
  two alerts and originating-session reply, with external provider fixtures only.
- Patched generated-manager Chromium journey and built-production HTTP probes passed.
- `npm audit`: zero reported vulnerabilities for the pinned installation at audit
  time. This is a dependency report, not a guarantee of vulnerability absence.
- Independent local review of lifecycle, approval-related state, paid-work gating,
  budget reconciliation, artifact lifetimes and X uncertainty found no additional
  high-confidence blocker after repairs. This was local agent review, not an external
  review service or a live acceptance certificate.

The worker accounting fixture reports 14,000/1,400 actual synthetic model tokens.
Each research child intentionally retains its existing conservative $0.25 paid
ceiling because that path cannot meter every research tool; the test asserts
500,000 micros across the two research children. These local ledger figures are
neither provider invoices nor actual expenditure. Actual provider spend stayed $0;
no production budget or recovery allowance was raised.

Run evidence was retained under `/private/tmp` on the audit machine:

| Evidence file | Result or reproduction |
| --- | --- |
| `eve-template-final-check.log` | 69/69 and TypeScript |
| `eve-template-final-build.log` | Eve and Next production build |
| `eve-template-final-monitoring.log` | Compiled positive journey and compact accounting/alert/reply summary |
| `eve-template-final-http.log`, `eve-template-production-smoke.json` | Built route statuses, authentication challenges, server cleanup |
| `eve-manager-browser-final.log`, `eve-manager-browser-final.png` | Actual generated client, active restored pack and paused monitor |
| `eve-manager-prefixtest.log` | Rejected archive left baseline monitor suspended |
| `eve-manager-start-fresh-prefixtest.log` | Baseline installed strategy became unavailable after fresh |
| `eve-coinbase-e2e-prefix.log` | Baseline stale-session card returned 200 rather than 409; also contains an early corrected fixture assertion |
| `eve-monitoring-prefixed.log` | Paid-research flag off still performed X reads |
| `eve-monitoring-global-prefixed.log` | Accepted classifications retained global reservations and blocked research |
| `eve-monitoring-artifact-race-prefixed.log`, `eve-evidence-lifetime-prefixtest.log` | Concurrent shared evidence failed; three focused lifetime contracts failed before repair |
| `eve-monitoring-delivery-id-prefixed.log` | Original reply-ID schema rejects digit-leading provider IDs after actual fixture sends |
| `eve-monitoring-uncertainty.log` | Unknown X acceptance incorrectly reconciled to zero before repair |

The delivery-ID baseline replay loads that one file from the original Git commit
through the test bundler so it can reach the failure with the earlier blockers
already repaired. No production file is rolled back to run it. Temporary probes
were removed; the committed acceptance scripts are the reproducible final evidence.

All fixture monitors were paused before their disposable stores were removed.
Local HTTP, Chromium, Redis, Chat SDK and Workflow resources were closed. No live
monitor, account setting, resource, public artifact or financial state was changed.
The original checkout's files and selected branch were preserved; the audit branch
was retained locally for review. Nothing was merged or pushed.

Submission instructions were checked against Eve's current
[contribution policy](https://github.com/vercel/eve/blob/main/CONTRIBUTING.md),
[gallery manifest](https://github.com/vercel/eve/blob/main/apps/docs/lib/templates/manifest.ts),
and [standalone template guidance](https://github.com/vercel/eve/blob/main/apps/templates/README.md).
The existing submission draft remains accurate: a public repository is not an
accepted gallery entry; maintainers require an issue and invitation before an
upstream PR. No maintainer contact or submission occurred.
