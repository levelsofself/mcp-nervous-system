# The Nervous System

**LLM Behavioral Enforcement Framework**

7 mechanically enforced rules that prevent the most common failure modes when LLMs have access to real infrastructure: context loss, silent failures, file damage, goal drift, and overreach.

Built by [Arthur Palyan](https://www.levelsofself.com) at Palyan AI. 14 tools including task complexity classification and user intent parsing. Battle-tested on an 11-member AI family running 28 processes 24/7 on a single VPS. 58+ violations logged, 0 bypassed.

## The Problem

When you give an LLM access to your file system, bash, and production infrastructure, it will eventually:

- Edit a file it shouldn't touch
- Lose context between sessions and start over
- Drift from the original objective during long tasks
- Fail silently when a session times out
- Make logic changes without asking
- Disappear into debug loops

The Nervous System solves all of these with rules enforced by external mechanisms the LLM cannot override.

## Install

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

### Direct

```bash
npx mcp-nervous-system
```

Server starts on port 3475 with SSE, HTTP, and health endpoints.

### Hosted (No Install)

The server is live and ready to use:

```
URL: https://api.100levelup.com/mcp-ns/
Protocol: MCP 2024-11-05 (Streamable HTTP + SSE)
Authentication: None required
```

## NEW in v1.3.0

**classify_task_complexity** (free tier)
Analyzes any task across 6 dimensions (scope, judgment, risk, context depth, ambiguity, verification difficulty) and recommends the optimal model tier. Routes simple tasks to Haiku (~90% savings), standard tasks to Sonnet (~60% savings), and complex reasoning to Opus. Pass optional structured hints for higher accuracy.

**parse_user_intent** (free tier)
Decomposes user requests into numbered deliverables with confidence scoring. Below 80% confidence: the model should clarify before executing, not guess. Detects ambiguity, unresolved pronouns, hedging language, and implicit expectations. The 80% rule: understand first, execute second.

These tools work together. parse_user_intent breaks down what the person wants. classify_task_complexity routes each piece to the right model. The Nervous System enforces the rules while execution happens.

**Positioning: Auto mode (launching March 12) decides what Claude CAN do. The Nervous System governs HOW it behaves while doing it.**

## The 7 Rules

| # | Rule | What It Prevents |
|---|------|-----------------|
| 1 | **Dispatch Don't Do** | Debug loops, rabbit holes. Tasks > 2 messages get dispatched. |
| 2 | **Untouchable** | File damage. Protected files mechanically blocked from editing. |
| 3 | **Write Progress** | Silent failures. Progress noted before each action. |
| 4 | **Step Back Every 4** | Goal drift. Forced reflection every 4 messages. |
| 5 | **Delegate and Return** | Invisible work. Background tasks reported immediately. |
| 6 | **Ask Before Touching** | Unauthorized changes. Logic changes need human approval. |
| 7 | **Hand Off** | Context loss. Written handoffs every 3-4 exchanges. |

## MCP Tools (14)

| Tool | Description |
|------|------------|
| `get_framework` | Complete framework: all rules, permission protocol, enforcement patterns |
| `guardrail_rules` | The 7 core rules with triggers, enforcement, and failure modes |
| `preflight_check` | File protection system: shell script blocks edits to protected files |
| `session_handoff` | Context preservation: templates for handoff documents |
| `worklog` | Progress documentation pattern |
| `violation_logging` | Audit trail: timestamp, type, context for every violation |
| `step_back_check` | Forced reflection system |
| `get_nervous_system_info` | System overview and operational stats |
| `emergency_kill_switch` | Emergency shutdown of all PM2 processes. Requires kill switch secret. Logs to tamper-evident audit trail |
| `verify_audit_chain` | Walks the SHA-256 hash-chained audit log and verifies every entry. Returns chain integrity status |
| `dispatch_to_llm` | Spawns a background LLM agent to handle a task. Checks RAM, enforces max 2 concurrent dispatches |
| `classify_task_complexity` | Analyzes task across 6 dimensions, recommends optimal model tier (Haiku/Sonnet/Opus) |
| `parse_user_intent` | Decomposes requests into numbered deliverables with confidence scoring. 80% gate |
| `get_positioning` | Returns competitive positioning and differentiation messaging |

## Kill Switch

The `emergency_kill_switch` tool provides an emergency shutdown capability. Send a POST request to `/kill` with the kill switch secret to immediately stop all PM2 processes. Every activation is logged to the tamper-evident audit trail with SHA-256 hash chaining, so kill switch events cannot be hidden or altered after the fact.

- Requires authentication (kill switch secret)
- Logs to hash-chained audit trail
- Returns confirmation with affected process count

## Tamper-Evident Audit Trail

Every guardrail violation, kill switch activation, and dispatch event is recorded in a SHA-256 hash-chained audit log. Each entry includes the hash of the previous entry, making it cryptographically impossible to alter or delete past records without breaking the chain.

- Use `verify_audit_chain` to walk the entire chain and verify integrity
- Returns: valid/invalid status, entry count, and break point if tampered
- 58+ violations logged, 0 bypassed, 0 chain breaks

## Dispatch to LLM

The `dispatch_to_llm` tool enables a brain + agents architecture. Instead of one LLM session doing everything, complex tasks get dispatched to background agents that run independently under the same 7 rules.

- Checks available RAM (requires 500MB+)
- Enforces max 2 concurrent dispatches
- Returns PID and log file path for monitoring
- Every dispatched agent runs under the same nervous system guardrails

## EU AI Act Compliance

The Nervous System provides practical compliance tools for the EU AI Act. See the full compliance page at:

https://api.100levelup.com/family/eu-ai-act.html

## Resources (4)

- `nervous-system://framework` - The complete framework
- `nervous-system://quick-start` - Quick start guide
- `nervous-system://rules` - The 7 core rules
- `nervous-system://templates` - Templates for handoffs, worklogs, preflight

## Production Stats

From the live Palyan AI deployment (Feb 28 - Mar 5, 2026):

- **58+** violations caught
- **29** edits blocked by preflight
- **13** unique files protected
- **0** rules bypassed
- **28** processes monitored
- **7** days continuous operation

## Live Demo

Try it yourself (no login required):

- **[Interactive Demo](https://api.100levelup.com/family/arthur.html?guest=1)** - Talk to a governed LLM and try to break the rules
- **[Audit Dashboard](https://api.100levelup.com/family/audit.html)** - See real violation history with timeline
- **[System Status](https://api.100levelup.com/family/status.html)** - Live health checks
- **[API Documentation](https://api.100levelup.com/family/api-docs.html)** - Full tool and resource reference
- **[Case Study](https://api.100levelup.com/family/case-study.html)** - Production deployment data
- **[Plain English Rules](https://api.100levelup.com/family/rules-plain.html)** - For non-technical stakeholders
- **[Incident Response](https://api.100levelup.com/family/incident-response.html)** - Detection, containment, resolution
- **[EU AI Act Compliance](https://api.100levelup.com/family/eu-ai-act.html)** - Practical EU AI Act compliance tools

## Philosophy

> "LLMs can't reliably self-enforce promises. Guardrails work via preflight.sh, violation logs, and catching drift. Build enforcement systems, don't make promises."

If a guardrail can be violated by the thing it guards, it is not a guardrail. It is a suggestion.

Every rule in the Nervous System is enforced by an external mechanism: a shell script, a timer, a separate monitoring process. The LLM cannot override, circumvent, or ignore them.

## License

MIT
