# Nervous System + Hivemind Integration

Add governance to your Hivemind team chat agents. The Nervous System runs as an MCP server in Hivemind's connector system, enforcing the 7 rules across all agents with @mention coordination.

## What You Get

- **preflight_check** runs before shell and file_edit tools
- **drift_audit** runs on the autonomous heartbeat cycle
- **session summaries** feed into NS session_handoff
- **Agent health monitoring** through NS page_health
- **violation_logging** with full audit trail

## Setup (Under 10 Minutes)

### 1. Install

```bash
npm install mcp-nervous-system
```

### 2. Add NS as an MCP Connector

In your Hivemind config, add the NS as a connector:

```yaml
connectors:
  - name: nervous-system
    type: mcp
    command: npx
    args: ["-y", "mcp-nervous-system"]
```

Or use the hosted version (no install):

```yaml
connectors:
  - name: nervous-system
    type: mcp-sse
    url: https://api.100levelup.com/mcp-ns/
```

### 3. Copy the Connector Module

```bash
cp hivemind-ns-connector.js /path/to/your/hivemind-project/connectors/
```

### 4. Configure Your Team

Copy `example-team.yaml` to your project and adjust:

```bash
cp example-team.yaml /path/to/your/hivemind-project/team.yaml
```

### 5. Create Your Untouchable Files List

```bash
echo "/path/to/critical-file.js" >> untouchable-files.txt
```

### 6. Start Hivemind

```bash
hivemind start --team team.yaml
```

All agents now run under NS governance. The heartbeat cycle triggers drift audits automatically.

## How It Works

```
Hivemind Team Chat
  |
  +-- @agent1 receives task
  |     |
  |     +-- hivemind-ns-connector.js intercepts tool calls
  |     |     +-- shell command? --> preflight_check first
  |     |     +-- file_edit? --> preflight_check first
  |     |     +-- BLOCKED? --> violation logged, edit cancelled
  |     |
  +-- Autonomous heartbeat (every N minutes)
  |     +-- drift_audit(scope: "full")
  |     +-- page_health check on monitored URLs
  |     +-- Results posted to team chat
  |     |
  +-- Session summary
        +-- session_handoff written
        +-- Violations count reported
```

## Files

| File | Purpose |
|------|---------|
| `hivemind-ns-connector.js` | MCP connector - hooks NS into Hivemind's tool pipeline |
| `example-team.yaml` | Team config with NS governance enabled |
| `README.md` | This guide |
