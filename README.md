# The Nervous System

**LLM Behavioral Enforcement Framework**

7 mechanically enforced rules that prevent the most common failure modes when LLMs have access to real infrastructure: context loss, silent failures, file damage, goal drift, and overreach.

Built by [Arthur Palyan](https://www.levelsofself.com) at Palyan AI.

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

## MCP Tools (8)

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

## Resources (4)

- `nervous-system://framework` - The complete framework
- `nervous-system://quick-start` - Quick start guide
- `nervous-system://rules` - The 7 core rules
- `nervous-system://templates` - Templates for handoffs, worklogs, preflight

## Production Stats

From the live Palyan AI deployment (Feb 28 - Mar 5, 2026):

- **47** violations caught
- **29** edits blocked by preflight
- **13** unique files protected
- **0** rules bypassed
- **22** processes monitored
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

## Philosophy

> "Claude can't reliably self-enforce promises. Guardrails work via preflight.sh, violation logs, and catching drift. Build enforcement systems, don't make promises."

If a guardrail can be violated by the thing it guards, it is not a guardrail. It is a suggestion.

Every rule in the Nervous System is enforced by an external mechanism: a shell script, a timer, a separate monitoring process. The LLM cannot override, circumvent, or ignore them.

## License

MIT
