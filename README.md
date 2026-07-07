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
