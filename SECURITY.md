# Security policy

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Must-be-Ash/eve-trading-agent-template/security/advisories/new).
Do not put vulnerabilities, credentials, approval links, account data, or private
conversation content in public issues.

Include the commit or version, affected component, impact, and reproduction steps
using synthetic data. Do not place trades, send messages to other people, or
publish private artifacts to demonstrate an issue. Reports should concern the
current `main` branch; older versions should be checked against current code.

Each deployment uses its owner's credentials and storage. Keep development
servers private, never enable `EVE_DEV=1` in production, and retain the owner
checks, explicit trade approvals, and replay protections. Artifacts are public;
account and conversation information belongs in private chat.

For ordinary setup questions and non-sensitive bugs, use repository issues.
