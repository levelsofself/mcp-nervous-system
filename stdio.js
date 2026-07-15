#!/usr/bin/env node

// Stdio wrapper for The Nervous System MCP Server
// This runs as a proper MCP stdio transport for Claude Desktop
// The HTTP server runs separately on the VPS

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");
const { auditMcpConfig } = require("./lib/mcp-audit");

// Resolve the protected-files list from env or nervous-system.config.json.
// Returns null when nothing is configured, so the tool can say so instead of guessing.
function loadProtectedListPath() {
  if (process.env.NERVOUS_SYSTEM_PROTECTED_LIST) return process.env.NERVOUS_SYSTEM_PROTECTED_LIST;
  const cfgPath = process.env.NERVOUS_SYSTEM_CONFIG || path.join(process.cwd(), "nervous-system.config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return cfg.protected_files_list || null;
  } catch { return null; }
}

// Discovery footer for the paid, hosted x402 counterpart of the free/local audit_mcp_config tool.
const X402_AUDIT_FOOTER = "Hosted CI/agent version (pay-per-call, x402): POST https://api.100levelup.com/x402/audit-mcp ($0.05 USDC on Base). Discovery: https://api.100levelup.com/openapi.json";

const RULES = [
  { id: 1, name: "Preflight Check", short: "Run preflight.sh before any file edit", detail: "Before editing ANY file, run /root/preflight.sh to check against UNTOUCHABLE list. If blocked, STOP and report. Never rationalize past a block." },
  { id: 2, name: "Handoff Continuity", short: "Read and update SESSION_HANDOFF.md", detail: "Read SESSION_HANDOFF.md at start of every session. Update it every few messages. If handoff is stale (>30min), flag it. Context loss is the #1 failure mode." },
  { id: 3, name: "Progress Logging", short: "Document every action before doing it", detail: "Before each action, write what you're about to do. If you time out, the next session sees exactly where you stopped. No silent failures ever." },
  { id: 4, name: "Step-Back Reflection", short: "Pause every 4 messages to reflect", detail: "Every 4 messages, stop and ask: Are we solving the real problem? Have we drifted? Is there a simpler approach? This prevents rabbit holes." },
  { id: 5, name: "Dispatch Don't Do", short: "If >2 messages needed, write a task file and dispatch", detail: "Complex work gets written as a task file and dispatched to a background Claude Code agent. The brain keeps talking. Never iterate in chat." },
  { id: 6, name: "Ask Before Logic Changes", short: "Data changes OK, logic changes need approval", detail: "You can update data freely. But changing how something WORKS (code logic, config structure, process flow) requires human approval first." },
  { id: 7, name: "Scope Lock", short: "Stay on the assigned task", detail: "Do what was asked. Don't redesign, refactor, or improve things that weren't requested. Unsolicited changes are how agents break production." }
];

const TOOLS = [
  { name: "get_framework", description: "Get the complete Nervous System governance framework with all 7 rules", schema: { type: "object", properties: {} } },
  { name: "get_nervous_system_info", description: "Get system info, version, and production stats", schema: { type: "object", properties: {} } },
  { name: "check_preflight", description: "Check if a file is protected (UNTOUCHABLE)", schema: { type: "object", properties: { file_path: { type: "string", description: "Path to check" } }, required: ["file_path"] } },
  { name: "get_origin_story", description: "Get the origin story of The Nervous System", schema: { type: "object", properties: {} } },
  { name: "get_handoff_template", description: "Get a session handoff template", schema: { type: "object", properties: {} } },
  { name: "get_worklog_format", description: "Get the worklog entry format", schema: { type: "object", properties: {} } },
  { name: "get_step_back_prompt", description: "Get a step-back reflection prompt", schema: { type: "object", properties: {} } },
  { name: "get_dispatch_template", description: "Get a task file template for dispatching agents", schema: { type: "object", properties: {} } },
  { name: "get_kill_switch_instructions", description: "Returns the command to stop the fleet. This tool does NOT stop anything; it prints instructions. Enforcement is server-side.", schema: { type: "object", properties: { reason: { type: "string", description: "Reason for kill" } }, required: ["reason"] } },
  { name: "get_audit_verification_instructions", description: "Returns how to verify the hash-chained audit trail. This tool does NOT verify anything; verification needs the chain file, which is server-side.", schema: { type: "object", properties: {} } },
  { name: "get_dispatch_command", description: "Returns a ready-to-run background dispatch command. This tool does NOT dispatch anything; you run the command.", schema: { type: "object", properties: { task: { type: "string", description: "Task description" }, max_turns: { type: "number", description: "Max turns (default 15)" } }, required: ["task"] } },
  { name: "audit_mcp_config", description: "Governance lint for MCP server configurations (free, local). Checks: plaintext secrets in env, unpinned packages, auto-install flags, broad filesystem scopes, shell wrappers, non-TLS remote transports, unpinned docker tags. Returns findings with severities and a 0-100 score.", schema: { type: "object", properties: { config: { type: "object", description: "The MCP config JSON as an object (e.g. claude_desktop_config.json content). Provide this OR config_json, not both." }, config_json: { type: "string", description: "The MCP config JSON as a string; it will be parsed. Provide this OR config, not both." } } } }
];

const server = new Server({ name: "nervous-system", version: "2.0.0" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case "get_framework":
      return { content: [{ type: "text", text: JSON.stringify({ name: "The Nervous System", version: "2.0.0", description: "LLM Behavioral Enforcement Framework", rules: RULES, total_tools: 11, production_stats: { violations_caught: 58, rules_bypassed: 0, edits_blocked: 32, processes_monitored: 22 } }, null, 2) }] };
    
    case "get_nervous_system_info":
      return { content: [{ type: "text", text: JSON.stringify({ name: "The Nervous System", version: "2.0.0", author: "Arthur Palyan", company: "Arthur Palyan dba Levels Of Self", website: "https://www.levelsofself.com", demo: "https://api.100levelup.com/family/arthur.html?guest=1", github: "https://github.com/levelsofself/mcp-nervous-system", npm: "https://www.npmjs.com/package/mcp-nervous-system", tools: 11, rules: 7, production_stats: { violations: 58, bypasses: 0, blocked_edits: 32, uptime_days: 25, monthly_cost: "under $500/month" } }, null, 2) }] };
    
    case "check_preflight": {
      // Reads the protected list that nervous-system.config.json already declares.
      // No hardcoded paths: a list from another machine cannot protect yours.
      const fp = args?.file_path || "";
      if (!fp) return { content: [{ type: "text", text: "ERROR: file_path is required." }] };
      const listPath = loadProtectedListPath();
      if (!listPath) {
        return { content: [{ type: "text", text: `NO LIST CONFIGURED: nothing is protected on this machine. Set "protected_files_list" in nervous-system.config.json (or NERVOUS_SYSTEM_PROTECTED_LIST) to a file of absolute paths, one per line. Until then this tool cannot answer for ${fp} and will not pretend to.` }] };
      }
      let entries;
      try {
        entries = fs.readFileSync(listPath, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      } catch (e) {
        return { content: [{ type: "text", text: `FAIL-CLOSED: protected list at ${listPath} is unreadable (${e.code || e.message}). Treating ${fp} as PROTECTED. Fix the list before editing.` }] };
      }
      const base = "/" + path.basename(fp);
      const hit = entries.find(e => e === fp || e.endsWith(base));
      return { content: [{ type: "text", text: hit
        ? `BLOCKED: ${fp} matches protected entry "${hit}" in ${listPath}. Do not edit without explicit human approval.`
        : `OK: ${fp} is not in ${listPath} (${entries.length} entries). You may edit it.` }] };
    }
    
    case "get_origin_story":
      return { content: [{ type: "text", text: "The Nervous System came out of watching LLM agents break production systems. System prompts did not work: the model would agree to every rule and violate it minutes later. So the rules were made mechanical instead of advisory: a preflight script that blocks an edit before it happens, a hash-chained audit trail, and a kill switch. The lesson that matters: an agent cannot rationalize past a bash script. Note on numbers: this tool used to hardcode fleet sizes and violation counts. They were removed on 2026-07-15 because a number baked into a package is a fossil the moment it ships. For live counts, query the hosted server, which reads them at request time." }] };
    
    case "get_handoff_template":
      return { content: [{ type: "text", text: "# SESSION HANDOFF\n\n## WHAT JUST HAPPENED\n[Summary of last session]\n\n## COMPLETED\n[List of completed items]\n\n## STILL PENDING\n[List of pending items]\n\n## SYSTEM STATE\n- PM2 processes: [count] online\n- Violations: [count], bypasses: [count]\n- Key metrics\n\n## NEXT SESSION SHOULD\n[Priority items for next session]" }] };
    
    case "get_worklog_format":
      return { content: [{ type: "text", text: "## [Date] - [Session Title]\n- ITEM 1: What was done\n- ITEM 2: What was done\n- STATS: violations [N], blocked [N], processes [N]\n- STATUS: [summary]" }] };
    
    case "get_step_back_prompt":
      return { content: [{ type: "text", text: "STEP BACK REFLECTION:\n1. What was the original objective?\n2. Are we still working toward it, or have we drifted?\n3. Is there a simpler approach we're missing?\n4. Have we created any new problems while solving the original one?\n5. Should we stop and report to the human instead of continuing?" }] };
    
    case "get_dispatch_template":
      return { content: [{ type: "text", text: "# TASK: [Title]\n# Priority: [HIGH/MEDIUM/LOW]\n# Dispatched: [Date]\n\n## CONTEXT\n[Why this task exists]\n\n## WHAT TO DO\n[Numbered steps]\n\n## IMPORTANT NOTES\n- Run preflight before any edit\n- Write progress as you go\n- If you run out of turns, document where you stopped\n\n## DISPATCH COMMAND\n```\ncd /root && nohup claude -p \"$(cat /root/family-data/TASK_NAME.md)\" --max-turns 25 > /root/family-logs/task-name.log 2>&1 &\n```" }] };
    
    case "get_kill_switch_instructions":
      return { content: [{ type: "text", text: "KILL SWITCH: This tool requires server-side execution with KILL_SECRET environment variable. In local/stdio mode, use: pm2 stop all" }] };
    
    case "get_audit_verification_instructions":
      return { content: [{ type: "text", text: "AUDIT CHAIN: Verification requires access to the audit-chain.json file on the server. In local/stdio mode, the chain file location is configurable. Server-side endpoint: GET /audit/verify" }] };
    
    case "get_dispatch_command":
      return { content: [{ type: "text", text: `DISPATCH: Task received: "${args?.task || 'no task'}". In local/stdio mode, dispatch with:\nnohup claude -p "${args?.task}" --max-turns ${args?.max_turns || 15} > /tmp/dispatch-${Date.now()}.log 2>&1 &` }] };
    
    case "audit_mcp_config": {
      const hasConfig = args?.config !== undefined;
      const hasJson = args?.config_json !== undefined;
      if (hasConfig === hasJson) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Provide exactly one of: config (object) or config_json (string).", hint: "config is the parsed MCP config JSON; config_json is that same JSON as a string." }, null, 2) }] };
      }
      let cfg = args.config;
      if (hasJson) {
        try { cfg = JSON.parse(args.config_json); }
        catch (e) { return { content: [{ type: "text", text: JSON.stringify({ error: "config_json is not valid JSON", hint: e.message }, null, 2) }] }; }
      }
      const result = auditMcpConfig(cfg);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) + "\n\n" + X402_AUDIT_FOOTER }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "ns://rules", name: "Governance Rules", description: "All 7 Nervous System rules", mimeType: "application/json" },
    { uri: "ns://stats", name: "Production Stats", description: "Live production statistics", mimeType: "application/json" }
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (uri === "ns://rules") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(RULES, null, 2) }] };
  }
  if (uri === "ns://stats") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ violations: 58, bypasses: 0, blocked: 32, processes: 22, uptime_days: 25, version: "2.0.0" }, null, 2) }] };
  }
  return { contents: [{ uri, mimeType: "text/plain", text: "Unknown resource" }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
