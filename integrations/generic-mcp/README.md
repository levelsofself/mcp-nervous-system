# Nervous System - 5-Minute Governance Guide

Add governance to any MCP-compatible system in under 5 minutes. Works with Claude Desktop, Claude Code, Cursor, Windsurf, Cline, or any MCP client.

## 3 Lines to Enable Governance

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "nervous-system": {
      "command": "npx",
      "args": ["-y", "mcp-nervous-system"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add nervous-system npx mcp-nervous-system
```

### Any MCP Client (SSE)

Point your client at the hosted server:

```
URL: https://api.100levelup.com/mcp-ns/
Protocol: MCP 2024-11-05 (Streamable HTTP + SSE)
Authentication: None required
```

## Quick Start Script

```bash
bash quick-start.sh
```

This creates:
- `nervous-system.config.json` - your project config
- `untouchable-files.txt` - your protected files list
- `.ns-data/` - data and logs directory

## What You Get (19 Tools)

### Always Use These

| Tool | What It Does |
|------|-------------|
| `preflight_check` | Check if a file is safe to edit before touching it |
| `step_back_check` | Forced reflection - am I solving the real problem? |
| `session_handoff` | Write context so the next session can pick up where you left off |
| `worklog` | Document what changed, when, and why |

### Use When Needed

| Tool | What It Does |
|------|-------------|
| `drift_audit` | Find config drift across roles, versions, files, processes, website |
| `emergency_kill_switch` | Stop all PM2 processes immediately |
| `verify_audit_chain` | Verify the tamper-evident audit log hasn't been altered |
| `dispatch_to_llm` | Spawn a background agent under the same governance |
| `security_audit` | Check for common security issues |
| `page_health` | Monitor web pages for uptime and content |
| `pre_publish_audit` | Verify package is ready for npm publish |

## Custom Config

Create `nervous-system.config.json` in your project root:

```json
{
  "project_root": ".",
  "data_dir": "./.ns-data",
  "logs_dir": "./.ns-data/logs",
  "protected_files_list": "./untouchable-files.txt",
  "pm2_managed": false,
  "html_pages": [],
  "docs_to_audit": []
}
```

## Untouchable Files

Create `untouchable-files.txt` - one file path per line:

```
# Production configs
.env
.env.production
database/migrations/

# Lock files
package-lock.json
yarn.lock

# CI/CD
.github/workflows/deploy.yml
```

Any LLM that tries to edit these files gets BLOCKED. The attempt is logged to the tamper-evident audit chain.

## Verify It Works

After setup, ask your LLM:

> "Try to edit .env"

It should call `preflight_check`, get BLOCKED, and refuse. That is governance working.

## Files

| File | Purpose |
|------|---------|
| `README.md` | This guide |
| `quick-start.sh` | Auto-setup script |
