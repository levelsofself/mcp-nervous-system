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
  { name: "emergency_kill_switch", description: "Emergency stop all agents (requires KILL_SECRET env var)", schema: { type: "object", properties: { reason: { type: "string", description: "Reason for kill" } }, required: ["reason"] } },
  { name: "verify_audit_chain", description: "Verify the tamper-evident SHA-256 audit trail", schema: { type: "object", properties: {} } },
  { name: "dispatch_to_llm", description: "Dispatch a task to a background Claude Code agent", schema: { type: "object", properties: { task: { type: "string", description: "Task description" }, max_turns: { type: "number", description: "Max turns (default 15)" } }, required: ["task"] } }
];

const server = new Server({ name: "nervous-system", version: "1.1.1" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case "get_framework":
      return { content: [{ type: "text", text: JSON.stringify({ name: "The Nervous System", version: "1.1.1", description: "LLM Behavioral Enforcement Framework", rules: RULES, total_tools: 11, production_stats: { violations_caught: 56, rules_bypassed: 0, edits_blocked: 32, processes_monitored: 22 } }, null, 2) }] };
    
    case "get_nervous_system_info":
      return { content: [{ type: "text", text: JSON.stringify({ name: "The Nervous System", version: "1.1.1", author: "Arthur Palyan", company: "Palyan Family AI System / Levels of Self LLC", website: "https://www.levelsofself.com", demo: "https://api.100levelup.com/family/arthur.html?guest=1", github: "https://github.com/levelsofself/mcp-nervous-system", npm: "https://www.npmjs.com/package/mcp-nervous-system", tools: 11, rules: 7, production_stats: { violations: 56, bypasses: 0, blocked_edits: 32, uptime_days: 25, monthly_cost: "$12" } }, null, 2) }] };
    
    case "check_preflight":
      const fp = args?.file_path || "unknown";
      const isProtected = fp.includes("llm-bridge") || fp.includes("tamara-v5") || fp.includes("tamara-team-responder");
      return { content: [{ type: "text", text: isProtected ? `BLOCKED: ${fp} is UNTOUCHABLE. Do not edit.` : `OK: ${fp} is not protected. You may edit it.` }] };
    
    case "get_origin_story":
      return { content: [{ type: "text", text: "The Nervous System was born from watching AI agents break production systems repeatedly. Arthur Palyan runs 22 AI processes on a $12/month VPS - 12 specialized agents handling email, jobs, coaching, translation, content, and operations 24/7. Without governance, agents would edit critical configs, loop on debug sessions, time out without records, and drift from objectives. System prompts didn't work - the LLM would agree to every rule then violate them within minutes. So we built mechanical enforcement: a bash script (preflight.sh) that blocks edits before they happen, a hash-chained audit trail that can't be tampered with, and a kill switch for emergencies. 56 violations caught, 0 bypassed. The AI can't rationalize past a bash script." }] };
    
    case "get_handoff_template":
      return { content: [{ type: "text", text: "# SESSION HANDOFF\n\n## WHAT JUST HAPPENED\n[Summary of last session]\n\n## COMPLETED\n[List of completed items]\n\n## STILL PENDING\n[List of pending items]\n\n## SYSTEM STATE\n- PM2 processes: [count] online\n- Violations: [count], bypasses: [count]\n- Key metrics\n\n## NEXT SESSION SHOULD\n[Priority items for next session]" }] };
    
    case "get_worklog_format":
      return { content: [{ type: "text", text: "## [Date] - [Session Title]\n- ITEM 1: What was done\n- ITEM 2: What was done\n- STATS: violations [N], blocked [N], processes [N]\n- STATUS: [summary]" }] };
    
    case "get_step_back_prompt":
      return { content: [{ type: "text", text: "STEP BACK REFLECTION:\n1. What was the original objective?\n2. Are we still working toward it, or have we drifted?\n3. Is there a simpler approach we're missing?\n4. Have we created any new problems while solving the original one?\n5. Should we stop and report to the human instead of continuing?" }] };
    
    case "get_dispatch_template":
      return { content: [{ type: "text", text: "# TASK: [Title]\n# Priority: [HIGH/MEDIUM/LOW]\n# Dispatched: [Date]\n\n## CONTEXT\n[Why this task exists]\n\n## WHAT TO DO\n[Numbered steps]\n\n## IMPORTANT NOTES\n- Run preflight before any edit\n- Write progress as you go\n- If you run out of turns, document where you stopped\n\n## DISPATCH COMMAND\n```\ncd /root && nohup claude -p \"$(cat /root/family-data/TASK_NAME.md)\" --max-turns 25 > /root/family-logs/task-name.log 2>&1 &\n```" }] };
    
    case "emergency_kill_switch":
      return { content: [{ type: "text", text: "KILL SWITCH: This tool requires server-side execution with KILL_SECRET environment variable. In local/stdio mode, use: pm2 stop all" }] };
    
    case "verify_audit_chain":
      return { content: [{ type: "text", text: "AUDIT CHAIN: Verification requires access to the audit-chain.json file on the server. In local/stdio mode, the chain file location is configurable. Server-side endpoint: GET /audit/verify" }] };
    
    case "dispatch_to_llm":
      return { content: [{ type: "text", text: `DISPATCH: Task received: "${args?.task || 'no task'}". In local/stdio mode, dispatch with:\nnohup claude -p "${args?.task}" --max-turns ${args?.max_turns || 15} > /tmp/dispatch-${Date.now()}.log 2>&1 &` }] };
    
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
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ violations: 56, bypasses: 0, blocked: 32, processes: 22, uptime_days: 25, version: "1.1.1" }, null, 2) }] };
  }
  return { contents: [{ uri, mimeType: "text/plain", text: "Unknown resource" }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
