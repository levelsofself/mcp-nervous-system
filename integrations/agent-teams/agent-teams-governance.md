# Agent Teams Governance Architecture

How the Nervous System governs parallel agents in Claude Code Agent Teams.

## Core Principle

Governance flows through two mechanisms:

1. **CLAUDE.md** - every agent reads project instructions on spawn. The 7 rules live here.
2. **MCP Server** - every agent can call NS tools. One server, shared state, unified audit trail.

```
CLAUDE.md (rules)       MCP Server (enforcement)
     |                       |
     v                       v
  Agent 1  ---- preflight_check ----> NS index.js
  Agent 2  ---- preflight_check ----> NS index.js
  Agent 3  ---- drift_audit --------> NS index.js
     |                                    |
     +-------- shared audit chain --------+
```

## How Governance Propagates

When a team lead spawns sub-agents:

1. Each sub-agent inherits the project's `CLAUDE.md`
2. `CLAUDE.md` contains the governance section with mandatory NS tool calls
3. The NS MCP server is available to all agents (configured once in Claude Code settings)
4. All agents write to the same audit chain file
5. The team lead can call `verify_audit_chain` to confirm no violations were hidden

## Tool Search Compatibility

Claude Code's Tool Search feature uses `defer_loading` for MCP servers with many tools. The NS has 19 tools - some are used constantly, others rarely.

**Always loaded** (used on every edit):
- `preflight_check`
- `step_back_check`
- `session_handoff`

**Deferred** (loaded when needed):
- `drift_audit`
- `emergency_kill_switch`
- `verify_audit_chain`
- `dispatch_to_llm`
- `security_audit`
- `page_health`
- `pre_publish_audit`

To configure defer_loading, add to your Claude Code MCP settings:

```json
{
  "nervous-system": {
    "command": "npx",
    "args": ["-y", "mcp-nervous-system"],
    "defer_loading": true
  }
}
```

## Team-Level vs Agent-Level Governance

| Pattern | When to Use |
|---------|------------|
| **Agent-level** | Each agent calls preflight_check before its own edits. Default. |
| **Team-level** | Team lead calls drift_audit after all agents complete. For verification. |

Both patterns run simultaneously. Agent-level catches violations in real-time. Team-level catches drift that individual agents might miss.

## Audit Trail Across Parallel Agents

The SHA-256 hash-chained audit trail handles concurrent writes:

1. Each agent appends violations to the same audit chain file
2. File locks prevent corruption from parallel writes
3. After team completion, `verify_audit_chain` walks the full chain
4. Any tampering is detectable - the chain breaks at the altered entry

## Example Team Workflow

```
1. Team lead receives complex task
2. Team lead calls preflight_check on key files to understand protection
3. Team lead spawns 3 sub-agents with specific subtasks
4. Each sub-agent:
   a. Reads CLAUDE.md (gets governance rules)
   b. Calls preflight_check before every edit
   c. Gets step_back reflection every 4 turns
   d. Reports violations to team lead
5. Team lead:
   a. Monitors agent progress
   b. After all complete: drift_audit(scope: "full")
   c. verify_audit_chain to confirm clean execution
   d. session_handoff to preserve context
```

## CLAUDE.md Governance Section Template

```markdown
## GOVERNANCE (Nervous System)

### Before ANY File Edit
Call `preflight_check` with the file path. If BLOCKED, do not edit and report to team lead. If PROTECTED, do not edit and ask the human.

### Every 4 Messages
Call `step_back_check`. Report your assessment. Are you solving the real problem?

### Before Ending Work
Call `session_handoff` to preserve context for the next session.

### After Team Task Completion (Team Lead Only)
1. Call `drift_audit` with scope "full"
2. Call `verify_audit_chain` to confirm clean execution
3. Report results to human
```
