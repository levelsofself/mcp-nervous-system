# Nervous System

Deterministic governance lint for MCP server configurations, plus reference tooling for the 7 rules.

## What each tool actually does

| Tool | Does real work? |
|---|---|
| `audit_mcp_config` | **Yes.** Deterministic lint, zero dependencies, fully offline, never throws. Checks inline secrets in env, shell wrappers, unpinned packages, auto-install flags, broad filesystem scopes, non-TLS remote transports, unpinned docker tags. Returns findings with severities and a 0-100 score. |
| `check_preflight` | **Yes, when configured.** Reads `protected_files_list` from `nervous-system.config.json` or `NERVOUS_SYSTEM_PROTECTED_LIST`. With no list it says so rather than guessing. If the list is unreadable it FAILS CLOSED. |
| `get_*` (everything else) | **No.** They return text: the framework, templates, instructions. That is why they are named `get_`. |

## Install

    npx mcp-nervous-system

## Free local tool: audit_mcp_config

Pass your config as `config` (object) or `config_json` (string), e.g. the contents of
`claude_desktop_config.json`. Returns findings with severities and a 0-100 score.

## Hosted API (pay-per-call, x402, USDC on Base)

The write-capable toolset runs server-side and is not in this package.

- `POST https://api.100levelup.com/x402/audit-mcp` - governance lint ($0.05 USDC)
- `GET  https://api.100levelup.com/x402/verify-audit` - audit-chain verification ($0.005 USDC)

Discovery: `/openapi.json` and `/llms.txt`.

## 2.0.0 breaking changes

- `emergency_kill_switch` -> `get_kill_switch_instructions`. It never stopped anything.
- `verify_audit_chain` -> `get_audit_verification_instructions`. It never verified a chain.
- `dispatch_to_llm` -> `get_dispatch_command`. It never dispatched.
- `check_preflight` no longer matches hardcoded filenames from the author's own server. It reads your list.
- Hardcoded fleet counts and violation totals removed from `get_origin_story`. A number baked into a
  package is a fossil the moment it ships.

## License

MIT
