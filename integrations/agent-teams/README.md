# Nervous System + Anthropic Agent Teams (Claude Code)

Govern parallel agent teams in Claude Code with the Nervous System. Every sub-agent in the team operates under the same 7 rules, shares an untouchable files list, and contributes to a unified audit trail.

## What You Get

- **Shared governance** across all agents in the team
- **Shared UNTOUCHABLE list** - no agent can edit protected files
- **Team-level drift_audit** after task completion
- **Audit trail** spanning all agents in the team session
- **Compatible with Tool Search** (defer_loading on less-used NS tools)

## Setup (Under 10 Minutes)

### 1. Add NS as an MCP Server in Claude Code

```bash
claude mcp add nervous-system npx mcp-nervous-system
```

### 2. Create Your Config

```bash
# In your project root:
cat > nervous-system.config.json << 'EOF'
{
  "project_root": ".",
  "data_dir": "./.ns-data",
  "logs_dir": "./.ns-data/logs",
  "protected_files_list": "./untouchable-files.txt",
  "pm2_managed": false
}
EOF

mkdir -p .ns-data/logs
```

### 3. Create Your Untouchable Files List

```bash
cat > untouchable-files.txt << 'EOF'
# Files no agent should edit
package-lock.json
.env
.env.production
database/migrations/
EOF
```

### 4. Add Governance to Your CLAUDE.md

Add this to your project's `CLAUDE.md` so every agent in the team inherits the rules:

```markdown
## GOVERNANCE (Nervous System)
- Before editing ANY file, call preflight_check with the file path
- If BLOCKED: do not edit. Report to team lead.
- If PROTECTED: do not edit. Ask human.
- Every 4 messages: call step_back_check
- Before ending session: call session_handoff
- After completing team task: call drift_audit with scope "full"
```

### 5. Use Agent Teams with Governance

When Claude Code spawns agent teams, every agent reads `CLAUDE.md` and inherits the governance rules. The NS MCP server is available to all agents in the team.

```
Team Lead
  |
  +-- Agent 1 (developer)
  |     +-- preflight_check before edits
  |     +-- step_back every 4 turns
  |     +-- violations logged to shared audit
  |
  +-- Agent 2 (tester)
  |     +-- preflight_check before edits
  |     +-- step_back every 4 turns
  |     +-- violations logged to shared audit
  |
  +-- Agent 3 (reviewer)
  |     +-- preflight_check before edits
  |     +-- step_back every 4 turns
  |     +-- violations logged to shared audit
  |
  +-- After all agents complete:
        +-- drift_audit(scope: "full")
        +-- session_handoff
        +-- verify_audit_chain
```

## Architecture

See `agent-teams-governance.md` for the full architecture guide covering:

- How governance flows through CLAUDE.md to every agent
- Tool Search compatibility with defer_loading
- Audit trail spanning multiple parallel agents
- Team-level vs agent-level governance patterns

## Files

| File | Purpose |
|------|---------|
| `README.md` | This guide |
| `agent-teams-governance.md` | Architecture deep-dive |
| `example-claude-code-config.json` | Example MCP config for Claude Code |
