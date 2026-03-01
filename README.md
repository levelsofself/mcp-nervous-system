# The Nervous System - LLM Behavioral Enforcement Framework

Anthropic built the brain. This is the nervous system.

LLMs are powerful but they hurt themselves - they lose context between sessions, loop on problems instead of dispatching, silently fail without progress notes, edit protected files, drift from the real problem, and solve instead of asking. The Nervous System is a behavioral enforcement layer that wraps any LLM deployment with guardrails, handoffs, preflight checks, violation logging, and forced reflection cycles.

7 core rules. Battle-tested on a 12-member AI family running 24/7 on a single VPS.

## Tools

| Tool | Description |
|------|-------------|
| `get_framework` | Returns the complete nervous system framework - all behavioral rules, guardrails, and enforcement patterns |
| `session_handoff` | Get the session handoff system that solves context loss between LLM sessions. Templates, examples, best practices |
| `preflight_check` | Get the preflight check system that protects files from accidental LLM edits. Script pattern, enforcement flow, templates |
| `worklog` | Get the worklog pattern - continuous progress writing that prevents silent failures |
| `guardrail_rules` | Returns behavioral rules: DISPATCH DONT DO, ASK BEFORE TOUCHING, STEP BACK, WRITE PROGRESS, HAND OFF, PERMISSION PROTOCOL |
| `violation_logging` | Get the violation logging pattern - how to track, log, and enforce guardrail breaches |
| `step_back_check` | The 7-level reflection system. Forces the LLM to zoom out and ask whether current work serves the real mission |
| `get_nervous_system_info` | Overview of the entire nervous system - what it is, where it came from, how to implement it, what problems it solves |

## Resources

| URI | Name | Description |
|-----|------|-------------|
| `nervous-system://framework` | The Nervous System Framework | Complete behavioral enforcement framework for LLM management |
| `nervous-system://quick-start` | Quick Start Guide | How to implement the nervous system in your own LLM deployment |
| `nervous-system://rules` | The 7 Core Rules | All 7 behavioral rules with explanations and enforcement |
| `nervous-system://templates` | Templates | Ready-to-use templates for handoffs, worklogs, preflight, and untouchable lists |

## The 7 Core Rules

1. **DISPATCH DONT DO** - If a task takes more than 2 messages, write a task file and dispatch a background agent. Do not iterate.
2. **UNTOUCHABLE = UNTOUCHABLE** - Maintain a list of protected files. Run a preflight check before any edit. If blocked, STOP.
3. **WRITE PROGRESS AS YOU GO** - Before each action, note what you are about to do. If you time out, the next instance sees where you stopped.
4. **STEP BACK EVERY 4 MESSAGES** - Stop. See all 7 levels. Ask: are we solving the real problem? Say it to the human, then continue.
5. **DELEGATE AND RETURN** - When you dispatch a task, come back and talk to the human. Do not wait silently.
6. **ASK BEFORE TOUCHING** - Before modifying any system file, config, process, or provider: ask. Run preflight first.
7. **HAND OFF EVERY FEW MESSAGES** - Update the session handoff file every 3-4 exchanges.

## Setup as Custom MCP Connector

### Hosted (Recommended)

The server is live and ready to use:

```
URL: https://api.100levelup.com/mcp-ns/
Protocol: MCP 2024-11-05 (Streamable HTTP + SSE)
Authentication: None required
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "nervous-system": {
      "url": "https://api.100levelup.com/mcp-ns/"
    }
  }
}
```

### Self-Hosted

1. Clone this repo
2. Run `node server.js`
3. Server starts on port 3475

## What Problems It Solves

- **Context Loss** - LLM sessions are ephemeral. Session handoff files preserve continuity.
- **Infinite Loops** - LLMs debug the same error for 10+ messages. DISPATCH DONT DO stops this.
- **Silent Failures** - Sessions time out mid-task. WRITE PROGRESS makes every step visible.
- **Editing Protected Files** - LLMs break working systems with "improvements." Preflight checks block this.
- **Mission Drift** - LLMs zoom into details. STEP BACK forces reflection every 4 messages.
- **Solving Instead of Asking** - LLMs patch without checking. ASK BEFORE TOUCHING enforces consent.
- **Lost Progress on Timeout** - Multi-step tasks vanish. Continuous worklogs + handoffs preserve everything.

## Example Prompts

Try these with any MCP-connected AI assistant:

1. **"Show me the nervous system framework for managing LLMs"** - Returns the complete framework with all 7 core rules, permission protocol, and enforcement patterns.

2. **"How do I prevent my LLM from editing protected files?"** - Returns the preflight check system with script templates, enforcement flow, and untouchable file list patterns.

3. **"Give me a session handoff template"** - Returns a ready-to-use template for preserving context between LLM sessions.

4. **"What are the guardrail rules for LLM behavioral enforcement?"** - Returns all 6 guardrail rules with implementation details and violation signs.

5. **"How do I implement the nervous system in my own deployment?"** - Returns the 7-step implementation guide from file protection to reflection cycles.

## About

**The Nervous System** was built by Arthur Palyan to manage a 12-member AI family operating 24/7 on a single $12/month VPS. After months of LLMs breaking working systems, looping on problems, and losing context between sessions, the nervous system emerged as the behavioral enforcement layer that keeps the brain from hurting itself.

- Website: https://www.levelsofself.com
- Game: https://100levelup.com
- Privacy: https://api.100levelup.com/family/privacy.html
- MCP Privacy: https://api.100levelup.com/family/mcp-privacy.html

## Support

- Email: artpalyan@levelsofself.com
- Book a call: https://calendly.com/levelsofself/zoom

## License

MIT - see [LICENSE](LICENSE)
