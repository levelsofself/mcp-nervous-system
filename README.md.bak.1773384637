# The Nervous System

**LLM Behavioral Enforcement Framework**

7 mechanically enforced rules that prevent the most common failure modes when LLMs have access to real infrastructure: context loss, silent failures, file damage, goal drift, and overreach.

Built by [Arthur Palyan](https://www.levelsofself.com) at Palyan Family AI System. 19+ tools including configuration drift detection, emergency kill switch, usage monitoring, and bot compliance auditing. Battle-tested on a 13-agent AI family running 25 processes 24/7 on a $24/month VPS. SAM.gov registered (CAGE 19R10). 18 partners across 8 countries. 99+ violations caught, 0 bypassed.

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

## NEW in v1.9.0

**Platform Integration Guides** - Working examples for governing multi-agent systems on the 3 biggest platforms plus any MCP client. Each guide gets you to governed agents in under 10 minutes.

- [Ruflo (claude-flow)](./integrations/ruflo/) - Queen-Worker hive mind governance with preflight checks, drift audits, and violation logging to swarm_state
- [Hivemind](./integrations/hivemind/) - Team chat agent governance with tool interception, heartbeat drift audits, and session handoffs
- [Anthropic Agent Teams](./integrations/agent-teams/) - Parallel agent governance via CLAUDE.md propagation with shared untouchable lists and unified audit trails
- [Generic MCP](./integrations/generic-mcp/) - 5-minute setup for any MCP client (Claude Desktop, Claude Code, Cursor, Windsurf, Cline)

## v1.8.0

**Tamara Reference Implementation + Case Study** (2 new resources)
Production reference implementation of an autonomous AI operations manager built on the Nervous System. Includes full architecture documentation, build-your-own guide, and case study with real metrics from managing 13 agents across 5 platforms.

## v1.7.4

**drift_audit** (free tier)
Configuration drift detection across 5 scopes: roles, versions, files, processes, and website. Scans source-of-truth files (family-roles.json, package.json, UNTOUCHABLE_FILES.txt) against all downstream references - HTML pages, JSON configs, markdown docs, and running PM2 processes. Change one file, drift_audit tells you everywhere else that needs updating. The closed loop that keeps your entire system consistent.

**Positioning: Auto mode decides what Claude CAN do. The Nervous System governs HOW it behaves while doing it.**

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

## MCP Tools (21)

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
| `drift_audit` | Configuration drift detection across roles, versions, files, processes, and website. Finds stale values everywhere. |

## Kill Switch

The `emergency_kill_switch` tool provides an emergency shutdown capability. Send a POST request to `/kill` with the kill switch secret to immediately stop all PM2 processes. Every activation is logged to the tamper-evident audit trail with SHA-256 hash chaining, so kill switch events cannot be hidden or altered after the fact.

- Requires authentication (kill switch secret)
- Logs to hash-chained audit trail
- Returns confirmation with affected process count

## Tamper-Evident Audit Trail

Every guardrail violation, kill switch activation, and dispatch event is recorded in a SHA-256 hash-chained audit log. Each entry includes the hash of the previous entry, making it cryptographically impossible to alter or delete past records without breaking the chain.

- Use `verify_audit_chain` to walk the entire chain and verify integrity
- Returns: valid/invalid status, entry count, and break point if tampered
- 99+ violations caught, 0 bypassed, 0 chain breaks

## Dispatch to LLM

The `dispatch_to_llm` tool enables a brain + agents architecture. Instead of one LLM session doing everything, complex tasks get dispatched to background agents that run independently under the same 7 rules.

- Checks available RAM (requires 500MB+)
- Enforces max 2 concurrent dispatches
- Returns PID and log file path for monitoring
- Every dispatched agent runs under the same nervous system guardrails

## EU AI Act Compliance

The Nervous System provides practical compliance tools for the EU AI Act. See the full compliance page at:

https://api.100levelup.com/family/eu-ai-act.html

## Production Reference: Tamara

Tamara is an autonomous AI operations manager built on the Nervous System framework. She manages 13 AI agents across 5 platforms, serving 175+ countries accessible from a $12/month VPS - without dedicated DevOps staff.

Tamara is the proof that the Nervous System works in production. She runs 60-minute autonomous check cycles, detects configuration drift, dispatches remediation agents, and reports to the human operator only when judgment is needed.

- **Case Study**: Use the `nervous-system://case-study` resource for full production metrics
- **Reference Implementation**: Use the `nervous-system://tamara-reference` resource for architecture details and build-your-own guide
- **Enterprise Support**: For organizations deploying AI agent fleets at scale, implementation consulting is available at wa.me/18184399770
- **Blog**: [Meet Tamara](https://api.100levelup.com/family/blog/meet-tamara.md) | [Why AI Agent Management Is the Next Infrastructure Layer](https://api.100levelup.com/family/blog/ai-agent-management.md)

## Resources (7)

- `nervous-system://framework` - The complete framework
- `nervous-system://quick-start` - Quick start guide
- `nervous-system://rules` - The 7 core rules
- `nervous-system://templates` - Templates for handoffs, worklogs, preflight
- `nervous-system://drift-audit` - Configuration drift detection
- `nervous-system://tamara-reference` - Tamara autonomous ops manager reference implementation
- `nervous-system://case-study` - Palyan Family AI System production case study

## Production Stats

From the live Palyan Family AI System deployment (Feb 28 - Mar 5, 2026):

- **58+** violations caught
- **29** edits blocked by preflight
- **100** files protected
- **0** rules bypassed
- **27** processes monitored
- **5** days continuous operation

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

## Integrations

Works with the major multi-agent platforms and any MCP client:

| Platform | Integration | Setup Time |
|----------|------------|------------|
| **[Ruflo (claude-flow)](./integrations/ruflo/)** | Plugin hooks into Queen-Worker pipeline | 10 min |
| **[Hivemind](./integrations/hivemind/)** | MCP connector with tool interception | 10 min |
| **[Anthropic Agent Teams](./integrations/agent-teams/)** | CLAUDE.md governance propagation | 10 min |
| **[Any MCP Client](./integrations/generic-mcp/)** | 3 lines of config | 5 min |

Each integration includes working code, example configs, and a step-by-step README.

## Agent Skills

The Nervous System is also available as an Agent Skill following the open [Agent Skills standard](https://agentskills.io). Install the governance skill to teach any AI agent (Claude, Codex, Cursor, Copilot, VS Code) how to enforce behavioral guardrails in multi-agent systems.

See `skills/multi-agent-governance/SKILL.md` for the full skill definition.

## Philosophy

> "LLMs can't reliably self-enforce promises. Guardrails work via preflight.sh, violation logs, and catching drift. Build enforcement systems, don't make promises."

If a guardrail can be violated by the thing it guards, it is not a guardrail. It is a suggestion.

Every rule in the Nervous System is enforced by an external mechanism: a shell script, a timer, a separate monitoring process. The LLM cannot override, circumvent, or ignore them.

## License

MIT
