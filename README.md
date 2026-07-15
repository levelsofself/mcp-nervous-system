# Agent Manifests

The following manifest files define governance settings for each agent:

- `tamara.manifest.yaml` - Oversees multi-agent operations with elevated permissions and reliability controls.
- `lily.manifest.yaml` - Guides users with public-facing coaching plans and motivational feedback.
- `kris.manifest.yaml` - Analyzes business credit signals and flags potential financial risk patterns.
- `aram.manifest.yaml` - Provides legal guidance under strict escalation and compliance boundaries.
- `harry.manifest.yaml` - Handles strict financial data workflows for bookkeeping and reconciliations.
- `harout.manifest.yaml` - Supports client-facing real estate workflows for listings and buyer matching.
- `roman.manifest.yaml` - Creates educational content and lesson structures for clear learning outcomes.
- `lou.manifest.yaml` - Finds grant opportunities and synthesizes eligibility and deadline requirements.
- `spartak.manifest.yaml` - Translates multilingual content accurately while preserving tone and intent.
- `nick.manifest.yaml` - Delivers advanced training workflows with restricted data and access controls.
- `corona.manifest.yaml` - Develops creative real estate concepts, campaigns, and positioning strategies.
- `soriano.manifest.yaml` - Designs youth empowerment programs with supportive coaching and resource guidance.
- `lady.manifest.yaml` - Executes parallel workstreams across five lanes with synchronized delivery control.

## Governance lint + paid x402 API

The Nervous System is an external governance layer for agent systems: governance, attribution, and coordination across vendors.

### Free, local tool: `audit_mcp_config`
Deterministic governance lint for MCP server configurations. Pass the config JSON (e.g. `claude_desktop_config.json`) as `config` (object) or `config_json` (string). It checks for plaintext secrets in `env`, unpinned packages, auto-install flags, broad filesystem scopes, shell wrappers, non-TLS remote transports, and unpinned docker tags, then returns findings with severities and a 0-100 score. Zero dependencies, fully offline, never throws.

### Hosted x402 API (pay-per-call)
For CI/agent use, the same checks plus audit-chain verification are available as pay-per-call HTTP endpoints priced in USDC on Base (x402):

- `POST https://api.100levelup.com/x402/audit-mcp` - governance lint ($0.05 USDC)
- `GET  https://api.100levelup.com/x402/verify-audit` - audit-chain verification ($0.005 USDC)

Discovery: [`/openapi.json`](https://api.100levelup.com/openapi.json) and [`/llms.txt`](https://api.100levelup.com/llms.txt).

## 2.0.0: what each tool actually does

This release renames every tool that described an action it did not perform.

| Tool | Does real work? |
|---|---|
| `audit_mcp_config` | **Yes.** Deterministic lint. Inline secrets, shell wrappers, unpinned packages, broad filesystem scope, non-TLS transports, unpinned docker tags. Returns findings with severities and a 0-100 score. |
| `check_preflight` | **Yes**, when configured. Reads `protected_files_list` from `nervous-system.config.json` or `NERVOUS_SYSTEM_PROTECTED_LIST`. With no list it says so instead of guessing. If the list is unreadable it FAILS CLOSED. |
| `get_*` (everything else) | **No.** They return text: the framework, templates, instructions. That is why they are named `get_`. |

### Breaking changes from 1.x
- `emergency_kill_switch` is now `get_kill_switch_instructions`. It never stopped anything; it returned a string.
- `verify_audit_chain` is now `get_audit_verification_instructions`. It never verified a chain.
- `dispatch_to_llm` is now `get_dispatch_command`. It never dispatched.
- `check_preflight` no longer matches three hardcoded filenames from the author's own server. One of them (`tamara-v5`) did not exist, so the tool returned "you may edit it" for the real protected file. It now reads your list, or admits it has none.
- Hardcoded fleet counts and violation totals are removed from `get_origin_story`. A number baked into a package is a fossil the moment it ships.

The full write-capable toolset (kill switch, dispatch, audits, session close) runs server-side at `api.100levelup.com`. This package is the local half and says so.
