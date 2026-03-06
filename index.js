const http = require('http');
const { validateRequest, mcpErrorResponse } = require('./mcp-api-middleware');
const SERVER_NAME_ID = 'nervous-system';
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');

const path = require('path');
const os = require('os');

// ============================================================
// PROJECT CONFIGURATION - Auto-discover or use config file
// ============================================================

function loadProjectConfig() {
  const configPaths = [
    process.env.NS_CONFIG_PATH,
    path.join(process.cwd(), 'nervous-system.config.json'),
    path.join(os.homedir(), '.nervous-system', 'config.json'),
    path.join(__dirname, 'nervous-system.config.json'),
  ].filter(Boolean);

  for (const cp of configPaths) {
    try {
      const raw = fs.readFileSync(cp, 'utf8');
      const cfg = JSON.parse(raw);
      cfg._source = cp;
      return cfg;
    } catch (e) { continue; }
  }

  // Return defaults that work for any project
  return {
    _source: 'defaults',
    project_root: process.cwd(),
    data_dir: null,
    logs_dir: null,
    html_dir: null,
    protected_files_list: null,
    config_file: null,
    roles_file: null,
    docs_to_audit: [],
    pm2_managed: false,
    html_pages: [],
    package_json: null,
    github_repo: null,
  };
}

const PROJECT = loadProjectConfig();

function projectPath(key) {
  const val = PROJECT[key];
  if (!val) return null;
  if (path.isAbsolute(val)) return val;
  return path.join(PROJECT.project_root || process.cwd(), val);
}

const PORT = 3475;

const KILL_SECRET = process.env.KILL_SECRET || 'ns-kill-2026';
const AUDIT_CHAIN_FILE = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'audit-chain.json') : path.join(os.homedir(), '.nervous-system', 'audit-chain.json');
const VIOLATIONS_LOG = projectPath('logs_dir') ? path.join(projectPath('logs_dir'), 'guardrail-violations.log') : path.join(os.homedir(), '.nervous-system', 'guardrail-violations.log');
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
const activeDispatches = [];
const MAX_CONCURRENT_DISPATCHES = 2;

// ============================================================
// HASH-CHAINED AUDIT TRAIL
// ============================================================

function loadAuditChain() {
  try {
    if (fs.existsSync(AUDIT_CHAIN_FILE)) return JSON.parse(fs.readFileSync(AUDIT_CHAIN_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveAuditChain(chain) {
  fs.writeFileSync(AUDIT_CHAIN_FILE, JSON.stringify(chain, null, 2));
}

function computeHash(prevHash, content) {
  return crypto.createHash('sha256').update(prevHash + content).digest('hex');
}

function addAuditEntry(type, detail) {
  const chain = loadAuditChain();
  const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : GENESIS_HASH;
  const timestamp = new Date().toISOString();
  const content = `${timestamp}|${type}|${detail}`;
  const hash = computeHash(prevHash, content);
  const entry = { id: chain.length + 1, timestamp, type, detail, hash, prev_hash: prevHash };
  chain.push(entry);
  saveAuditChain(chain);
  try { fs.appendFileSync(VIOLATIONS_LOG, `${timestamp} ${type}: ${detail}\n`); } catch (e) {}
  return entry;
}

function verifyAuditChain() {
  const chain = loadAuditChain();
  if (chain.length === 0) return { valid: true, entries: 0, broken_at: null };
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const expectedPrev = i === 0 ? GENESIS_HASH : chain[i - 1].hash;
    if (entry.prev_hash !== expectedPrev) return { valid: false, entries: chain.length, broken_at: entry.id };
    const content = `${entry.timestamp}|${entry.type}|${entry.detail}`;
    const expectedHash = computeHash(entry.prev_hash, content);
    if (entry.hash !== expectedHash) return { valid: false, entries: chain.length, broken_at: entry.id };
  }
  return { valid: true, entries: chain.length, broken_at: null };
}

function migrateExistingViolations() {
  if (fs.existsSync(AUDIT_CHAIN_FILE)) return;
  if (!fs.existsSync(VIOLATIONS_LOG)) return;
  try {
    const lines = fs.readFileSync(VIOLATIONS_LOG, 'utf8').trim().split('\n').filter(l => l.trim());
    const chain = [];
    for (const line of lines) {
      const match = line.match(/^(\S+)\s+(.+?):\s*(.*)$/);
      if (!match) continue;
      const [, timestamp, type, detail] = match;
      const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : GENESIS_HASH;
      const content = `${timestamp}|${type}|${detail}`;
      const hash = computeHash(prevHash, content);
      chain.push({ id: chain.length + 1, timestamp, type, detail: detail || type, hash, prev_hash: prevHash });
    }
    saveAuditChain(chain);
    console.error(`[NS] Migrated ${chain.length} violations to audit chain`);
  } catch (e) { console.error('[NS] Migration error:', e.message); }
}

// ============================================================
// DISPATCH-TO-LLM
// ============================================================

function cleanupDispatches() {
  for (let i = activeDispatches.length - 1; i >= 0; i--) {
    try { process.kill(activeDispatches[i].pid, 0); } catch (e) {
      activeDispatches[i].status = 'completed';
      activeDispatches[i].endTime = new Date().toISOString();
    }
  }
}

function getFreeMB() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
    return m ? Math.floor(parseInt(m[1]) / 1024) : 0;
  } catch (e) { return 0; }
}

function dispatchToLLM(task, maxTurns) {
  cleanupDispatches();
  const active = activeDispatches.filter(d => d.status === 'active');
  if (active.length >= MAX_CONCURRENT_DISPATCHES)
    return { dispatched: false, error: `Max ${MAX_CONCURRENT_DISPATCHES} concurrent dispatches. ${active.length} running.` };
  const freeMB = getFreeMB();
  if (freeMB < 500) return { dispatched: false, error: `Insufficient RAM: ${freeMB}MB free (need 500MB+)` };
  const ts = Date.now();
  const logFile = projectPath('logs_dir') ? `${projectPath('logs_dir')}/dispatch-${ts}.log` : path.join(os.homedir(), '.nervous-system', `dispatch-${ts}.log`);
  const turns = maxTurns || 15;
  try {
    const escaped = task.replace(/"/g, '\\"');
    const child = spawn('bash', ['-c',
      `nohup claude -p "${escaped}" --permission-mode acceptEdits --max-turns ${turns} > ${logFile} 2>&1 &`
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    const record = { pid: child.pid, task: task.substring(0, 200), log: logFile, status: 'active', startTime: new Date().toISOString(), maxTurns: turns };
    activeDispatches.push(record);
    addAuditEntry('DISPATCH', `Task dispatched: ${task.substring(0, 100)}`);
    return { dispatched: true, pid: child.pid, log: logFile };
  } catch (e) { return { dispatched: false, error: e.message }; }
}

// MCP Protocol version
const MCP_VERSION = '2024-11-05';

// Server info
const SERVER_INFO = {
  name: 'nervous-system',
  version: '1.6.0'
};

// ============================================================
// THE NERVOUS SYSTEM - Content
// ============================================================

const FRAMEWORK = {
  name: 'The Nervous System',
  version: '1.6.0',
  author: 'Arthur Palyan',
  tagline: 'Anthropic built the brain. Arthur built the nervous system that keeps it from hurting itself.',
  problem: 'LLMs lose context between sessions, loop on problems instead of dispatching, silently fail without progress notes, edit protected files, drift from the real problem, and solve instead of asking.',
  solution: 'A behavioral enforcement layer that wraps any LLM deployment with guardrails, handoffs, preflight checks, violation logging, and forced reflection cycles.',
  core_rules: [
    {
      id: 'dispatch_dont_do',
      name: 'DISPATCH DONT DO',
      rule: 'If a task takes more than 2 messages to solve, write a task file and dispatch a background agent. Do not iterate. Do not debug. Do not problem-solve in chat.',
      why: 'Prevents the LLM from burning context window on execution work. Keep the main session for strategy and conversation with the human.'
    },
    {
      id: 'untouchable',
      name: 'UNTOUCHABLE = UNTOUCHABLE',
      rule: 'Maintain a list of protected files. Before ANY edit, run a preflight check. If blocked, STOP. Report the problem and wait for human approval. No rationalizing.',
      why: 'Working systems get broken by well-meaning improvements. Lock what works.'
    },
    {
      id: 'write_progress',
      name: 'WRITE PROGRESS AS YOU GO',
      rule: 'Before each action, note what you are about to do in the session handoff file. If you time out, the next instance sees where you stopped. No silent failures ever.',
      why: 'LLM sessions can timeout or crash at any moment. Written progress is the only insurance.'
    },
    {
      id: 'step_back',
      name: 'STEP BACK EVERY 4 MESSAGES',
      rule: 'Stop. See all 7 levels. Ask: are we solving the real problem? Is this moving toward the goal? Say it to the human, then continue.',
      why: 'LLMs naturally zoom into details and lose the big picture. Forced reflection prevents drift.'
    },
    {
      id: 'delegate_and_return',
      name: 'DELEGATE AND RETURN',
      rule: 'When you dispatch a task, come back and talk to the human while it runs. Do not wait silently. Report what you dispatched and ask what is next.',
      why: 'The human should never wonder what the LLM is doing. Silence is the enemy.'
    },
    {
      id: 'ask_before_touching',
      name: 'ASK BEFORE TOUCHING',
      rule: 'Before modifying any system file, config, process, or provider: ask. Do not patch, swap, or fix without explicit permission. Run preflight first.',
      why: 'The LLM does not own the system. The human does. Every change needs consent.'
    },
    {
      id: 'hand_off',
      name: 'HAND OFF EVERY FEW MESSAGES',
      rule: 'Update the session handoff file with progress every 3-4 exchanges. If this session ends abruptly, the next instance knows exactly where things stand.',
      why: 'LLM sessions are ephemeral. The handoff file is permanent memory.'
    }
  ],
  permission_protocol: {
    data_changes: 'Clearing items, fixing a typo, updating a value - LLM can act with human general direction.',
    logic_changes: 'How something thinks, decides, classifies, responds - LLM PROPOSES and WAITS. No exceptions.',
    rule: 'If unsure which category a change falls into, it is LOGIC. Ask the human.'
  },
  before_any_change: [
    'Back up the file first',
    'Syntax check (node -c for JS files)',
    'One process at a time',
    'Never delete process managers entries unless fixing ghosts',
    'Never refactor working code to make it cleaner'
  ]
};

const SEVEN_LEVELS = {
  name: 'Seven Level Reflection',
  trigger: 'Every 4 messages, STOP. Before responding:',
  steps: [
    'Step back. See all 7 levels.',
    'What are we actually building? Is it the right thing?',
    'Are we solving the real problem or the surface one?',
    'Is the operations manager involved? If not, why not?',
    'What would a partner say right now, not an assistant?'
  ],
  instruction: 'Say this to the human. Then continue. This is not optional.',
  purpose: 'Forces the LLM to zoom out from detail-level problem solving and consider whether the current direction serves the bigger mission.'
};

const SESSION_HANDOFF_TEMPLATE = {
  template: `# SESSION HANDOFF
Updated: [DATE] [TIME] UTC

## WHAT JUST HAPPENED
- [What you did this session]
- [Key decisions made]
- [Problems encountered]

## SYSTEM STATE
- [Process status]
- [What is running/broken]

## WHAT NEEDS TO HAPPEN NEXT
1. [Next priority]
2. [Second priority]
3. [Third priority]

## FILES CHANGED THIS SESSION
- [file1] - [what changed]
- [file2] - [what changed]

## HUMAN ACTIONS NEEDED
- [Anything that requires human intervention]`,
  best_practices: [
    'Update continuously, not just at session end',
    'Be specific about what changed and why',
    'Always note the system state (what is running, what is broken)',
    'List files changed with one-line descriptions',
    'Flag anything that needs human action separately',
    'Include timestamps in UTC',
    'If something is broken, say so clearly - do not hide problems',
    'Write as if the next reader has zero context about this session'
  ],
  example_sections: {
    good: 'Deployed v6 chatbox. Static greeting loads instantly. First user message triggers full context load. Port bound to 127.0.0.1 behind reverse proxy.',
    bad: 'Worked on the chatbox. Made some changes. Things are mostly working.'
  }
};

const PREFLIGHT_PATTERN = {
  concept: 'A shell script that runs BEFORE any file edit to check if the file is protected.',
  flow: [
    '1. LLM wants to edit a file',
    '2. LLM runs: bash preflight.sh /path/to/file',
    '3. Script checks file against UNTOUCHABLE list',
    '4. Script checks file against PROTECTED list',
    '5. Returns OK, BLOCKED, or PROTECTED',
    '6. If BLOCKED: LLM stops immediately, reports to human',
    '7. If PROTECTED: LLM stops, asks human for permission',
    '8. All violations are logged to a violation log file'
  ],
  script_template: `#!/bin/bash
# preflight.sh - Guardrail Enforcement
LOGFILE="/path/to/guardrail-violations.log"
mkdir -p "$(dirname "$LOGFILE")"

if [ "$1" = "--check-handoff" ]; then
  HANDOFF="/path/to/SESSION_HANDOFF.md"
  if [ ! -f "$HANDOFF" ]; then
    echo "WARNING: SESSION_HANDOFF.md missing"
    echo "$(date -Iseconds) STALE_HANDOFF missing_file" >> "$LOGFILE"
    exit 1
  fi
  AGE=$(( $(date +%s) - $(stat -c %Y "$HANDOFF") ))
  if [ "$AGE" -gt 600 ]; then
    echo "WARNING: Handoff not updated in $(( AGE / 60 )) minutes."
    echo "$(date -Iseconds) STALE_HANDOFF age=\${AGE}s" >> "$LOGFILE"
    exit 1
  fi
  echo "OK: Handoff updated $(( AGE / 60 ))m ago"
  exit 0
fi

FILE="$1"
if [ -z "$FILE" ]; then echo "Usage: preflight.sh /path/to/file"; exit 1; fi
if command -v realpath >/dev/null 2>&1 && [ -e "$FILE" ]; then FILE=$(realpath "$FILE"); fi

if grep -qF "$FILE" /path/to/UNTOUCHABLE_FILES.txt 2>/dev/null; then
  echo "BLOCKED: $FILE is UNTOUCHABLE."
  echo "$(date -Iseconds) BLOCKED_UNTOUCHABLE: $FILE" >> "$LOGFILE"
  exit 1
fi

PROTECTED="list of protected filenames"
BASENAME=$(basename "$FILE")
for P in $PROTECTED; do
  if [ "$BASENAME" = "$P" ]; then
    echo "PROTECTED: $FILE requires human permission."
    echo "$(date -Iseconds) BLOCKED_PROTECTED: $FILE" >> "$LOGFILE"
    exit 1
  fi
done

echo "OK: $FILE clear to edit"
exit 0`,
  untouchable_template: `# UNTOUCHABLE FILES
# Do NOT edit without human explicit permission
# RULE: Protect what WORKS. Free what we're BUILDING.

# Core Infrastructure (WORKING - PROTECT)
/path/to/proxy.js (description)
/path/to/bridge.js (description)

# Workers (WORKING - PROTECT)
/path/to/worker1.js (description)
/path/to/worker2.js (description)

# NOT PROTECTED (ACTIVELY BUILDING)
# /path/to/new-feature.js - actively developing`
};

const WORKLOG_TEMPLATE = {
  format: `## [Date] - [Time range] [Timezone]
**Session: [Brief description]**
- What you did (bullet points)
- Files changed: [list]
- Status: [system state]`,
  best_practices: [
    'Append to the worklog, never overwrite previous entries',
    'Include date and time range for every entry',
    'List specific files changed',
    'Note system state after changes (what is running, what broke)',
    'Keep entries concise - bullet points, few words',
    'If something broke, say so clearly',
    'Read the worklog FIRST at the start of every session'
  ],
  example: `## March 1, 2026 - 2:00-4:30pm PT
**Session: MCP server deployment**
- Built nervous-system MCP server (8 tools, 4 resources)
- Deployed on PM2, added Caddy reverse proxy route
- Files changed: /root/mcp-nervous-system.js (NEW), /etc/caddy/Caddyfile (added route)
- Status: All 23 PM2 processes online, MCP responding on /mcp-ns/`
};

const GUARDRAIL_RULES = {
  dispatch_dont_do: {
    name: 'DISPATCH DONT DO',
    rule: 'If a task takes more than 2 messages to solve, STOP. Write the task to a file and dispatch a background agent. Do not iterate yourself.',
    implementation: [
      'Write task description to a temp file',
      'Dispatch: agent -p "$(cat /tmp/task.txt)" --allowedTools Bash,Read,Write --max-turns 30 &',
      'Tell the human it is running',
      'Return to conversation with human',
      'Do not wait silently for the agent to finish'
    ],
    signs_of_violation: [
      'LLM debugging the same error for 3+ messages',
      'LLM writing long code blocks in conversation',
      'LLM saying "let me try one more thing"',
      'Human waiting while LLM iterates silently'
    ]
  },
  ask_before_touching: {
    name: 'ASK BEFORE TOUCHING',
    rule: 'Before modifying any system file, config, process, or provider: ask. Do not patch, swap, or fix without explicit permission.',
    implementation: [
      'Run preflight.sh before any file edit',
      'Describe what you found to the human',
      'Propose what you would change',
      'Explain what it affects',
      'Wait for human to say go'
    ],
    can_act_without_asking: [
      'Clearing data items human already handled',
      'Fixing a CSS value or display bug (not logic)',
      'Reading, scanning, reporting',
      'Following explicit instructions human just gave'
    ]
  },
  step_back: {
    name: 'STEP BACK EVERY 4 MESSAGES',
    rule: 'Every 4 messages, stop everything. See all 7 levels. Ask: are we solving the real problem? Say it to the human, then continue.',
    the_seven_levels: SEVEN_LEVELS
  },
  write_progress: {
    name: 'WRITE PROGRESS AS YOU GO',
    rule: 'Before each action, note what you are about to do in the handoff. If you time out, the next instance sees where you stopped.',
    implementation: [
      'Update SESSION_HANDOFF.md before starting a task',
      'Note what you are about to do',
      'Note what the expected outcome is',
      'After completing, update with results',
      'If something breaks, note it immediately'
    ]
  },
  hand_off: {
    name: 'HAND OFF EVERY FEW MESSAGES',
    rule: 'Update the session handoff file every 3-4 exchanges.',
    what_to_include: [
      'What happened this session',
      'Decisions made',
      'System state (running/broken)',
      'Files changed',
      'What needs to happen next',
      'Human actions needed'
    ]
  },
  permission_protocol: {
    name: 'PERMISSION PROTOCOL',
    rule: 'Two kinds of changes: DATA (act with direction) and LOGIC (propose and wait).',
    data: 'Clearing items, fixing a typo, updating a value. LLM can act with human general direction.',
    logic: 'How something thinks, decides, classifies, responds. LLM PROPOSES and WAITS. No exceptions.',
    when_unsure: 'If unsure which category a change falls into, it is LOGIC. Ask.'
  }
};

const VIOLATION_LOGGING = {
  pattern: {
    concept: 'Every guardrail violation is logged with timestamp, type, and details.',
    log_location: 'A dedicated log file (e.g., /path/to/guardrail-violations.log)',
    format: '[ISO-8601 timestamp] [VIOLATION_TYPE]: [details]',
    types: [
      'BLOCKED_UNTOUCHABLE - attempted edit of a protected file',
      'BLOCKED_PROTECTED - attempted edit of a file requiring permission',
      'STALE_HANDOFF - session handoff not updated in 10+ minutes'
    ]
  },
  template: `$(date -Iseconds) BLOCKED_UNTOUCHABLE: /path/to/protected-file.js
$(date -Iseconds) BLOCKED_PROTECTED: /path/to/sensitive-file.js
$(date -Iseconds) STALE_HANDOFF age=900s`,
  enforcement: {
    how_it_works: [
      'preflight.sh checks every file edit against the untouchable list',
      'If a violation occurs, it is logged with timestamp and file path',
      'The script returns a non-zero exit code, blocking the edit',
      'The LLM is trained (via system prompt) to run preflight before ANY edit',
      'If the LLM skips preflight, the human reviews the violation log periodically',
      'Violation patterns reveal which rules the LLM struggles to follow'
    ],
    remediation: [
      'Review violation log regularly',
      'If the same file keeps getting hit, reinforce the rule in the system prompt',
      'If violations spike, the LLM may be drifting - add a step-back check',
      'Use violations as training data for better prompt engineering'
    ]
  }
};

const NERVOUS_SYSTEM_INFO = {
  overview: {
    name: 'The Nervous System',
    what: 'A behavioral enforcement layer for LLM-powered autonomous systems.',
    who: 'Built by Arthur Palyan to manage a 12-member AI family running 24/7 on a single VPS.',
    problem: 'LLMs are powerful brains but they hurt themselves - they lose context, loop on problems, silently fail, edit protected files, and drift from the mission.',
    solution: '7 core rules enforced through preflight checks, session handoffs, worklogs, violation logging, and forced reflection cycles.',
    components: [
      'Preflight Check System - protects files from accidental edits',
      'Session Handoff - preserves context across sessions',
      'Worklog - continuous progress writing prevents silent failures',
      'Guardrail Rules - behavioral enforcement (dispatch, ask, step back, write, hand off)',
      'Violation Logging - tracks and logs every guardrail breach',
      'Seven Level Reflection - forces LLM to zoom out every 4 messages',
      'Permission Protocol - DATA vs LOGIC change classification',
      'Kill Switch - emergency shutdown of all processes',
      'Hash-Chained Audit - tamper-evident violation trail',
      'Dispatch-to-LLM - delegate heavy tasks to background agents'
    ]
  },
  origin_story: {
    context: 'Arthur Palyan runs a startup with 12 AI family members, each with distinct roles. The entire operation runs on a $24/month VPS with a $200/month LLM subscription.',
    problem_discovered: 'After months of building, patterns emerged: LLMs would break working systems while trying to improve them. They would loop on debugging instead of dispatching. They would silently fail when sessions timed out. They would lose all context between sessions.',
    solution_built: 'Arthur built the nervous system - not by changing the LLM model, but by wrapping it in behavioral rules enforced through scripts, file checks, and prompt engineering. The LLM itself became the enforcement mechanism, trained to check before acting.',
    philosophy: 'The brain (LLM) is powerful but needs a nervous system to keep it from hurting itself. Just like a human nervous system sends pain signals before you touch a hot stove, this system sends BLOCKED/PROTECTED signals before the LLM edits a critical file.',
    result: '22+ autonomous processes running 24/7 with minimal human oversight. The system catches its own mistakes before they become problems.'
  },
  implementation_guide: {
    step_1: { name: 'Create your untouchable files list', description: 'List every file that WORKS and should not be edited. Be aggressive - protect what works, free what you are building.' },
    step_2: { name: 'Write the preflight script', description: 'A simple bash script that checks any file path against the untouchable list before editing. Returns BLOCKED, PROTECTED, or OK.' },
    step_3: { name: 'Set up session handoff', description: 'Create a SESSION_HANDOFF.md file. Update it every 3-4 exchanges. Write what happened, system state, what is next.' },
    step_4: { name: 'Set up the worklog', description: 'Create a WORKLOG.md. Append to it at the end of every session. Date, time, what changed, file list, status.' },
    step_5: { name: 'Add behavioral rules to your system prompt', description: 'The 7 core rules go into your LLM system prompt: DISPATCH DONT DO, UNTOUCHABLE, WRITE PROGRESS, STEP BACK, DELEGATE AND RETURN, ASK BEFORE TOUCHING, HAND OFF.' },
    step_6: { name: 'Enable violation logging', description: 'The preflight script logs every BLOCKED/PROTECTED attempt. Review periodically to see which rules the LLM struggles with.' },
    step_7: { name: 'Add the reflection cycle', description: 'Every N messages, the LLM must stop, zoom out, and report to the human whether the current direction serves the bigger mission.' }
  },
  problem_it_solves: {
    problems: [
      { name: 'Context Loss', description: 'LLM sessions are ephemeral. When a session ends, everything learned is gone.', solution: 'Session handoff file updated every 3-4 exchanges. The next session reads it first.' },
      { name: 'Infinite Loops', description: 'LLMs will debug the same error for 10+ messages, burning context and time.', solution: 'DISPATCH DONT DO rule. If it takes more than 2 messages, write a task file and dispatch a background agent.' },
      { name: 'Silent Failures', description: 'Sessions time out mid-task. Nobody knows what happened or where it stopped.', solution: 'WRITE PROGRESS AS YOU GO. Before each action, note what you are about to do. If timeout hits, progress is visible.' },
      { name: 'Editing Protected Files', description: 'LLMs break working systems by making "improvements" to files that should not be touched.', solution: 'Preflight check system with UNTOUCHABLE file list. Script returns BLOCKED before any edit can happen.' },
      { name: 'Mission Drift', description: 'LLMs zoom into details and lose sight of the bigger picture. Hours spent on the wrong problem.', solution: 'STEP BACK EVERY 4 MESSAGES. Forced reflection cycle: are we solving the real problem?' },
      { name: 'Solving Instead of Asking', description: 'LLMs patch, fix, and modify without checking with the human first.', solution: 'ASK BEFORE TOUCHING rule and permission protocol (DATA vs LOGIC classification).' },
      { name: 'Lost Progress on Timeout', description: 'Multi-step tasks lose all progress when a session times out.', solution: 'Continuous worklog entries + session handoff + task files. Every step is written down.' }
    ]
  },
  stats: {
    protected_files: '89+ untouchable files',
    core_rules: 7,
    reflection_trigger: 'Every 4 messages',
    processes_managed: '22+ autonomous PM2 processes',
    family_members: 12,
    monthly_cost: 'Under $300/month total infrastructure',
    uptime: '24/7 autonomous operation',
    deployment: 'Single VPS, single LLM subscription'
  }
};

// ============================================================
// Tool definitions
// ============================================================
const TOOLS = [
  {
    name: 'get_framework',
    annotations: { title: 'Get Nervous System Framework', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns the complete nervous system framework - all behavioral rules, guardrails, and enforcement patterns that keep LLMs from hurting themselves.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'session_handoff',
    annotations: { title: 'Session Handoff System', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Get the session handoff system that solves context loss between LLM sessions.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'What to retrieve.', enum: ['read_example', 'get_template', 'get_best_practices'] } }, required: ['action'] }
  },
  {
    name: 'preflight_check',
    annotations: { title: 'Preflight Check System', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Get the preflight check system that protects files from accidental LLM edits.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'What to retrieve.', enum: ['get_script', 'get_pattern', 'get_untouchable_template'] } }, required: ['action'] }
  },
  {
    name: 'worklog',
    annotations: { title: 'Worklog Pattern', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Get the worklog pattern - continuous progress writing that prevents silent failures.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'What to retrieve.', enum: ['get_template', 'get_format', 'get_best_practices'] } }, required: ['action'] }
  },
  {
    name: 'guardrail_rules',
    annotations: { title: 'Guardrail Rules', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns behavioral rules for LLM management: DISPATCH DONT DO, ASK BEFORE TOUCHING, STEP BACK, WRITE PROGRESS, HAND OFF, PERMISSION PROTOCOL.',
    inputSchema: { type: 'object', properties: { rule: { type: 'string', description: 'Which rule to retrieve.', enum: ['dispatch_dont_do', 'ask_before_touching', 'step_back', 'write_progress', 'hand_off', 'permission_protocol', 'all'] } } }
  },
  {
    name: 'violation_logging',
    annotations: { title: 'Violation Logging Pattern', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Get the violation logging pattern - how to track, log, and enforce guardrail breaches.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'What to retrieve.', enum: ['get_pattern', 'get_template', 'get_enforcement'] } }, required: ['action'] }
  },
  {
    name: 'step_back_check',
    annotations: { title: 'Seven Level Reflection', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'The 7-level reflection system. Forces the LLM to zoom out and see the big picture.',
    inputSchema: { type: 'object', properties: { context: { type: 'string', description: 'Optional: describe your current context for a tailored reflection prompt.' } } }
  },
  {
    name: 'get_nervous_system_info',
    annotations: { title: 'Nervous System Info', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Overview of the entire nervous system - what it is, where it came from, how to implement it, what problems it solves, and operational stats.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'What to learn about.', enum: ['overview', 'origin_story', 'implementation_guide', 'problem_it_solves', 'stats'] } }, required: ['topic'] }
  },
  // NEW: Kill Switch
  {
    name: 'emergency_kill_switch',
    annotations: { title: 'Emergency Kill Switch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Emergency shutdown of all PM2 processes. Requires kill switch secret. Logs the event to the audit trail. Use only in emergencies.',
    inputSchema: {
      type: 'object',
      properties: {
        secret: { type: 'string', description: 'Kill switch secret for authorization.' },
        command: { type: 'string', description: 'Command to run. Default: pm2 stop all' },
        source: { type: 'string', description: 'Who activated the kill switch.' }
      },
      required: ['secret']
    }
  },
  // NEW: Verify Audit Chain
  {
    name: 'verify_audit_chain',
    annotations: { title: 'Verify Audit Chain', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Walks the hash-chained audit log and verifies every entry. Returns chain integrity status - valid/invalid, entry count, and where the chain breaks if tampered.',
    inputSchema: { type: 'object', properties: {} }
  },
  // NEW: Dispatch to LLM
  {
    name: 'dispatch_to_llm',
    annotations: { title: 'Dispatch Task to LLM Agent', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Spawns a background LLM agent to handle a task. Checks RAM (needs 500MB+), enforces max 2 concurrent dispatches. Returns PID and log file path.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description for the background agent.' },
        max_turns: { type: 'number', description: 'Max turns for the agent. Default: 15.' }
      },
      required: ['task']
    }
  },
  // NEW: Drift Audit
  {
    name: 'drift_audit',
    annotations: { title: 'Configuration Drift Audit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Scans for configuration drift - finds files, docs, and configs that reference outdated values. Detects when a file is renamed but references are not updated, when roles change but downstream docs still show old values, or when running processes do not match documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['full', 'roles', 'versions', 'files', 'processes', 'website'],
          description: 'What to audit. full=everything, roles=family role consistency, versions=NS version numbers, files=file reference integrity, processes=PM2 vs docs, website=HTML pages and configs for stale values'
        }
      }
    }
  },
  // NEW: Security Audit
  {
    name: 'security_audit',
    annotations: { title: 'Security Audit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Scans for security vulnerabilities - hardcoded passwords in HTML, exposed API keys, missing TLS, missing rate limiting, exposed bot tokens, and insecure file permissions.',
    inputSchema: { type: 'object', properties: {} }
  },
  // NEW: Auto Propagate
  {
    name: 'auto_propagate',
    annotations: { title: 'Auto Propagate', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Runs all 3 propagators (role, version, content) and reports what changed vs what was already current. Ensures all downstream files match source-of-truth values.',
    inputSchema: { type: 'object', properties: {} }
  },
  // NEW: Session Close
  {
    name: 'session_close',
    annotations: { title: 'Session Close', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'One-call session close. Runs drift_audit scope=full, then all 3 propagators. Returns combined results. The end-of-session button.',
    inputSchema: { type: 'object', properties: {} }
  },
  // NEW: Page Health
  {
    name: 'page_health',
    annotations: { title: 'Page Health Check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Checks HTML pages in /root/family-home/ for broken links, broken fetches, missing mobile nav, placeholder text, missing images, stale links, missing OG tags, missing favicon, JS syntax issues, and empty sections. Catches what drift_audit does not - actual page functionality and UX issues.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: "Specific page to check (e.g. 'gateway.html'), or 'all' for everything" }
      }
    }
  },
  // NEW: Pre-Publish Audit
  {
    name: 'pre_publish_audit',
    annotations: { title: 'Pre-Publish Audit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Scans the Nervous System source code itself before publishing. Catches hardcoded secrets, personal data, non-portable paths, and internal naming that should not ship to clients. RUN THIS BEFORE EVERY npm publish.',
    inputSchema: {
      type: 'object',
      properties: {
        source_file: {
          type: 'string',
          description: 'Path to the NS source file to audit. Defaults to own index.js'
        }
      }
    }
  }
];

// Resource definitions
const RESOURCES = [
  { uri: 'nervous-system://framework', name: 'The Nervous System Framework', description: 'Complete behavioral enforcement framework for LLM management', mimeType: 'text/plain' },
  { uri: 'nervous-system://quick-start', name: 'Quick Start Guide', description: 'How to implement the nervous system in your own LLM deployment', mimeType: 'text/plain' },
  { uri: 'nervous-system://rules', name: 'The 7 Core Rules', description: 'All 7 behavioral rules with explanations and enforcement', mimeType: 'text/plain' },
  { uri: 'nervous-system://templates', name: 'Templates', description: 'Ready-to-use templates for handoffs, worklogs, preflight, and untouchable lists', mimeType: 'text/plain' },
  { uri: 'nervous-system://drift-audit', name: 'Drift Audit', description: 'Configuration drift detection - checks roles, versions, file references, and running processes against source-of-truth files', mimeType: 'text/plain' }
];

// ============================================================
// DRIFT AUDIT ENGINE
// ============================================================

const { execSync } = require('child_process');

function safeReadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function auditRoles() {
  const drifts = [];
  let cleanChecks = 0;
  const rolesFile = projectPath('roles_file');
  if (!rolesFile) {
    return { drifts: [], cleanChecks: 0, skipped: 'roles_file not configured' };
  }
  const roles = safeReadJSON(rolesFile);
  if (!roles || !roles.members) {
    drifts.push({ type: 'missing_source', source: rolesFile, target: '', field: '', expected: 'valid JSON with members array', found: 'missing or invalid' });
    return { drifts, cleanChecks };
  }

  const sourceRoles = {};
  for (const m of roles.members) {
    sourceRoles[m.id] = { name: m.name, aka: m.aka, role: m.role };
  }

  // Check family-status.json
  const statusFile = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'family-status.json') : null;
  if (!statusFile) { return { drifts, cleanChecks }; }
  const status = safeReadJSON(statusFile);
  if (status && status.members) {
    for (const m of status.members) {
      const src = sourceRoles[m.id];
      if (!src) continue;
      if (m.aka && m.aka !== src.aka) {
        drifts.push({ type: 'role_mismatch', source: 'family-roles.json', target: 'family-status.json', field: `${m.id}.aka`, expected: src.aka, found: m.aka });
      } else { cleanChecks++; }
      if (m.role && m.role !== src.role) {
        drifts.push({ type: 'role_mismatch', source: 'family-roles.json', target: 'family-status.json', field: `${m.id}.role`, expected: src.role, found: m.role });
      } else { cleanChecks++; }
    }
  }

  // Check system-config.json
  const configFile = projectPath('config_file');
  const config = configFile ? safeReadJSON(configFile) : null;
  if (config && config.family_members) {
    for (const m of config.family_members) {
      const src = sourceRoles[m.id];
      if (!src) continue;
      if (m.aka && m.aka !== src.aka) {
        drifts.push({ type: 'role_mismatch', source: 'family-roles.json', target: 'system-config.json', field: `${m.id}.aka`, expected: src.aka, found: m.aka });
      } else { cleanChecks++; }
      if (m.role && m.role !== src.role) {
        drifts.push({ type: 'role_mismatch', source: 'family-roles.json', target: 'system-config.json', field: `${m.id}.role`, expected: src.role, found: m.role });
      } else { cleanChecks++; }
    }
  }

  // Check family-guide.json
  const guideFile = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'family-guide.json') : null;
  const guide = guideFile ? safeReadJSON(guideFile) : null;
  if (guide && guide.members) {
    for (const m of guide.members) {
      const src = sourceRoles[m.id];
      if (!src) continue;
      if (m.aka && m.aka !== src.aka) {
        drifts.push({ type: 'role_mismatch', source: 'family-roles.json', target: 'family-guide.json', field: `${m.id}.aka`, expected: src.aka, found: m.aka });
      } else { cleanChecks++; }
      if (m.role && m.role !== src.role) {
        drifts.push({ type: 'role_mismatch', source: 'family-roles.json', target: 'family-guide.json', field: `${m.id}.role`, expected: src.role, found: m.role });
      } else { cleanChecks++; }
    }
  }

  // Check HTML files for role references
  const htmlDir = projectPath('html_dir');
  const htmlFiles = htmlDir ? [
    { path: path.join(htmlDir, 'index.html'), name: 'index.html' },
    { path: path.join(htmlDir, 'explorer.html'), name: 'explorer.html' },
    { path: path.join(htmlDir, 'meet.html'), name: 'meet.html' }
  ] : [];
  for (const hf of htmlFiles) {
    const content = safeReadFile(hf.path);
    if (!content) continue;
    for (const [id, src] of Object.entries(sourceRoles)) {
      if (content.includes(src.name)) { cleanChecks++; }
    }
  }

  // Check mcp-ops-server.js
  const opsContent = projectPath('project_root') ? safeReadFile(path.join(projectPath('project_root') || process.cwd(), 'mcp-ops-server.js')) : null;
  if (opsContent) {
    for (const [id, src] of Object.entries(sourceRoles)) {
      if (opsContent.includes(`"${src.aka}"`) || opsContent.includes(`'${src.aka}'`)) {
        cleanChecks++;
      }
    }
  }

  return { drifts, cleanChecks };
}

function auditVersions() {
  const drifts = [];
  let cleanChecks = 0;
  const pkgFile = projectPath('package_json');
  if (!pkgFile) {
    return { drifts: [], cleanChecks: 0, skipped: 'package_json not configured' };
  }
  const pkg = safeReadJSON(pkgFile);
  const expectedVersion = pkg ? pkg.version : null;
  if (!expectedVersion) {
    drifts.push({ type: 'missing_source', source: pkgFile, target: '', field: 'version', expected: 'valid version', found: 'missing' });
    return { drifts, cleanChecks };
  }

  // Check SERVER_INFO.version and FRAMEWORK.version in index.js
  const ghRepo = projectPath('github_repo');
  const indexContent = ghRepo ? safeReadFile(path.join(ghRepo, 'index.js')) : null;
  if (indexContent) {
    const siMatch = indexContent.match(/SERVER_INFO\s*=\s*\{[^}]*version:\s*'([^']+)'/);
    if (siMatch) {
      if (siMatch[1] !== expectedVersion) {
        drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'index.js SERVER_INFO', field: 'version', expected: expectedVersion, found: siMatch[1] });
      } else { cleanChecks++; }
    }
    const fwMatch = indexContent.match(/FRAMEWORK\s*=\s*\{[^}]*version:\s*'([^']+)'/);
    if (fwMatch) {
      if (fwMatch[1] !== expectedVersion) {
        drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'index.js FRAMEWORK', field: 'version', expected: expectedVersion, found: fwMatch[1] });
      } else { cleanChecks++; }
    }
    // Check health endpoint version
    const healthMatch = indexContent.match(/version:\s*'([^']+)'.*?service:\s*'nervous-system/);
    if (!healthMatch) {
      const healthMatch2 = indexContent.match(/service:\s*'nervous-system-mcp',\s*version:\s*'([^']+)'/);
      if (healthMatch2) {
        if (healthMatch2[1] !== expectedVersion) {
          drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'index.js health endpoint', field: 'version', expected: expectedVersion, found: healthMatch2[1] });
        } else { cleanChecks++; }
      }
    }
    // Check startup log version
    const startupMatch = indexContent.match(/Nervous System v([0-9.]+) running/);
    if (startupMatch) {
      if (startupMatch[1] !== expectedVersion) {
        drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'index.js startup log', field: 'version', expected: expectedVersion, found: startupMatch[1] });
      } else { cleanChecks++; }
    }
    // Check root endpoint version
    const rootMatch = indexContent.match(/name:\s*'The Nervous System MCP Server'[\s\S]*?version:\s*'([^']+)'/);
    if (rootMatch) {
      if (rootMatch[1] !== expectedVersion) {
        drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'index.js root endpoint', field: 'version', expected: expectedVersion, found: rootMatch[1] });
      } else { cleanChecks++; }
    }
  }

  // Check BUSINESS_BUILDER.md
  const bbContent = projectPath('data_dir') ? safeReadFile(path.join(projectPath('data_dir'), 'BUSINESS_BUILDER.md')) : null;
  if (bbContent) {
    const bbMatch = bbContent.match(/[Nn]ervous [Ss]ystem.*?v?(\d+\.\d+\.\d+)/);
    if (bbMatch && bbMatch[1] !== expectedVersion) {
      drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'BUSINESS_BUILDER.md', field: 'ns_version', expected: expectedVersion, found: bbMatch[1] });
    } else if (bbMatch) { cleanChecks++; }
  }

  // Check gateway.html
  const gwContent = projectPath('html_dir') ? safeReadFile(path.join(projectPath('html_dir'), 'gateway.html')) : null;
  if (gwContent) {
    const gwMatch = gwContent.match(/[Vv]ersion[:\s]*v?(\d+\.\d+\.\d+)/);
    if (gwMatch && gwMatch[1] !== expectedVersion) {
      drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'gateway.html', field: 'version', expected: expectedVersion, found: gwMatch[1] });
    } else if (gwMatch) { cleanChecks++; }
  }

  // Check README.md
  const readmeContent = ghRepo ? safeReadFile(path.join(ghRepo, 'README.md')) : null;
  if (readmeContent) {
    const rmMatch = readmeContent.match(/[Vv]ersion[:\s]*v?(\d+\.\d+\.\d+)/);
    if (rmMatch && rmMatch[1] !== expectedVersion) {
      drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'README.md', field: 'version', expected: expectedVersion, found: rmMatch[1] });
    } else if (rmMatch) { cleanChecks++; }
  }

  // Check family-roles.json stats
  const roles = projectPath('roles_file') ? safeReadJSON(projectPath('roles_file')) : null;
  if (roles && roles.stats) {
    if (roles.stats.ns_version && roles.stats.ns_version !== expectedVersion) {
      drifts.push({ type: 'version_mismatch', source: 'package.json', target: 'family-roles.json', field: 'stats.ns_version', expected: expectedVersion, found: roles.stats.ns_version });
    } else if (roles.stats.ns_version) { cleanChecks++; }

    // Check tool count
    const actualToolCount = TOOLS.length;
    if (roles.stats.ns_tools && roles.stats.ns_tools !== actualToolCount) {
      drifts.push({ type: 'tool_count_mismatch', source: 'TOOLS array', target: 'family-roles.json', field: 'stats.ns_tools', expected: String(actualToolCount), found: String(roles.stats.ns_tools) });
    } else if (roles.stats.ns_tools) { cleanChecks++; }
  }

  return { drifts, cleanChecks };
}

function auditFiles() {
  const drifts = [];
  let cleanChecks = 0;

  // Check UNTOUCHABLE_FILES.txt - verify each file exists
  const untouchableFile = projectPath('protected_files_list');
  const untouchableContent = untouchableFile ? safeReadFile(untouchableFile) : null;
  if (untouchableContent) {
    const lines = untouchableContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    for (const rawLine of lines) {
      const filePath = rawLine.split(/\s*[\(\#]/)[0].trim();
      if (!filePath || !filePath.startsWith('/')) continue;
      if (fs.existsSync(filePath)) {
        cleanChecks++;
      } else {
        drifts.push({ type: 'missing_file', source: 'UNTOUCHABLE_FILES.txt', target: filePath, field: 'exists', expected: 'true', found: 'false' });
      }
    }
  }

  // Check LLM_STARTUP.md and BUSINESS_BUILDER.md for file references
  const docsToAudit = PROJECT.docs_to_audit || [];
  const docsToCheck = docsToAudit.map(p => ({ path: p, name: path.basename(p) }));

  // Get PM2 running scripts
  let pm2Scripts = {};
  try {
    const pm2Output = execSync('pm2 jlist', { timeout: 10000 }).toString();
    const pm2List = JSON.parse(pm2Output);
    for (const proc of pm2List) {
      pm2Scripts[proc.name] = proc.pm2_env ? proc.pm2_env.pm_exec_path : (proc.script || '');
    }
  } catch (e) {}

  for (const doc of docsToCheck) {
    const content = safeReadFile(doc.path);
    if (!content) continue;
    // Look for .js file references
    // Match .js files but exclude .json, .jsonl, .jsx
    const jsRefs = (content.match(/\/[^\s)]+\.js\b/g) || []).filter(r => !r.match(/\.json[l]?$/));
    for (const ref of jsRefs) {
      if (fs.existsSync(ref)) {
        cleanChecks++;
        // Check if PM2 is running something different
        const basename = ref.split('/').pop();
        for (const [procName, scriptPath] of Object.entries(pm2Scripts)) {
          const procBasename = scriptPath.split('/').pop();
          // If the doc references a versioned file like tamara-v5.js but PM2 runs tamara-v6.js
          const refBase = basename.replace(/-v\d+/, '');
          const procBase = procBasename.replace(/-v\d+/, '');
          if (refBase === procBase && basename !== procBasename && ref !== scriptPath) {
            drifts.push({ type: 'file_version_mismatch', source: doc.name, target: `PM2 process ${procName}`, field: refBase, expected: basename, found: procBasename });
          }
        }
      } else {
        drifts.push({ type: 'missing_file_ref', source: doc.name, target: ref, field: 'exists', expected: 'true', found: 'false' });
      }
    }
  }

  // Check system-config.json syntax_check_scripts
  const sysConfigFile = projectPath('config_file');
  const config = sysConfigFile ? safeReadJSON(sysConfigFile) : null;
  if (config && config.syntax_check_scripts) {
    for (const script of config.syntax_check_scripts) {
      if (fs.existsSync(script)) {
        cleanChecks++;
      } else {
        drifts.push({ type: 'missing_file', source: 'system-config.json syntax_check_scripts', target: script, field: 'exists', expected: 'true', found: 'false' });
      }
    }
  }

  return { drifts, cleanChecks };
}

function auditProcesses() {
  const drifts = [];
  let cleanChecks = 0;

  let pm2Procs = [];
  try {
    const pm2Output = execSync('pm2 jlist', { timeout: 10000 }).toString();
    pm2Procs = JSON.parse(pm2Output);
  } catch (e) {
    drifts.push({ type: 'pm2_error', source: 'pm2 jlist', target: '', field: '', expected: 'valid pm2 output', found: e.message });
    return { drifts, cleanChecks };
  }

  const procConfigFile = projectPath('config_file');
  const config = procConfigFile ? safeReadJSON(procConfigFile) : null;
  if (!config || !config.processes) {
    const roles = projectPath('roles_file') ? safeReadJSON(projectPath('roles_file')) : null;
    if (roles && roles.members) {
      const expectedProcs = [];
      for (const m of roles.members) {
        if (m.procs) expectedProcs.push(...m.procs);
      }
      const runningNames = pm2Procs.map(p => p.name);
      for (const ep of expectedProcs) {
        if (runningNames.includes(ep)) {
          cleanChecks++;
        } else {
          drifts.push({ type: 'missing_process', source: 'family-roles.json', target: 'pm2', field: ep, expected: 'running', found: 'not found in pm2' });
        }
      }
    }
    return { drifts, cleanChecks };
  }

  // Compare config.processes against pm2
  const runningNames = pm2Procs.map(p => p.name);
  if (Array.isArray(config.processes)) {
    for (const ep of config.processes) {
      const procName = typeof ep === 'string' ? ep : ep.name;
      if (runningNames.includes(procName)) {
        cleanChecks++;
      } else {
        drifts.push({ type: 'missing_process', source: 'system-config.json', target: 'pm2', field: procName, expected: 'running', found: 'not found in pm2' });
      }
    }
  }

  // Check script paths match
  for (const proc of pm2Procs) {
    const scriptPath = proc.pm2_env ? proc.pm2_env.pm_exec_path : '';
    if (scriptPath && !fs.existsSync(scriptPath)) {
      drifts.push({ type: 'broken_script_path', source: `pm2 process ${proc.name}`, target: scriptPath, field: 'exists', expected: 'true', found: 'false' });
    } else if (scriptPath) {
      cleanChecks++;
    }
  }

  return { drifts, cleanChecks };
}

function auditWebsite() {
  const drifts = [];
  let cleanChecks = 0;

  // Source of truth values
  const pkgFile = projectPath('package_json');
  const pkg = pkgFile ? safeReadJSON(pkgFile) : null;
  const expectedVersion = pkg ? pkg.version : SERVER_INFO.version;
  const actualToolCount = TOOLS.length;
  const actualResourceCount = RESOURCES.length;

  const roles = projectPath('roles_file') ? safeReadJSON(projectPath('roles_file')) : null;
  const expectedMemberCount = roles && roles.stats ? roles.stats.member_count : 11;
  const expectedProcessCount = roles && roles.stats ? roles.stats.process_count : 28;

  // Count protected files (non-comment, non-blank lines starting with /)
  const protListFile = projectPath('protected_files_list');
  const untouchableContent = protListFile ? safeReadFile(protListFile) : null;
  let protectedFileCount = 0;
  if (untouchableContent) {
    protectedFileCount = untouchableContent.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && l.trim().startsWith('/')).length;
  }

  // Get role names from family-roles.json
  const roleNames = roles && roles.members ? roles.members.map(m => m.name) : [];

  // 1. Check all .html files in /root/family-home/
  const familyHomeDir = projectPath('html_dir');
  if (!familyHomeDir) {
    return { drifts: [], cleanChecks: 0, skipped: 'html_dir not configured' };
  }
  let htmlFiles = [];
  try {
    htmlFiles = fs.readdirSync(familyHomeDir).filter(f => f.endsWith('.html')).map(f => familyHomeDir + f);
  } catch (e) {}

  for (const htmlFile of htmlFiles) {
    const content = safeReadFile(htmlFile);
    if (!content) continue;
    const fname = htmlFile.split('/').pop();

    // Check for old version references (not matching expected)
    const versionMatches = content.match(/v(\d+\.\d+\.\d+)/g) || [];
    for (const vm of versionMatches) {
      const ver = vm.substring(1);
      if (ver !== expectedVersion && /^1\.\d+\.\d+$/.test(ver)) {
        drifts.push({ type: 'stale_version', source: 'package.json', target: fname, field: 'version', expected: expectedVersion, found: ver });
      }
    }

    // Check for stale tool count references
    const toolCountMatches = content.match(/(\d+)\s*(?:MCP\s+)?tools/gi) || [];
    for (const tcm of toolCountMatches) {
      const num = parseInt(tcm);
      if (num > 0 && num !== actualToolCount && num < 50) {
        drifts.push({ type: 'stale_tool_count', source: 'TOOLS array', target: fname, field: 'tool_count', expected: String(actualToolCount), found: String(num) });
      }
    }

    // Check for stale agent/member count
    const agentMatches = content.match(/(\d+)\s*(?:AI\s+)?(?:family\s+)?(?:members|agents)/gi) || [];
    for (const am of agentMatches) {
      const num = parseInt(am);
      if (num > 0 && num !== expectedMemberCount && num < 50) {
        drifts.push({ type: 'stale_agent_count', source: 'family-roles.json', target: fname, field: 'member_count', expected: String(expectedMemberCount), found: String(num) });
      }
    }

    // Check for stale protected file count
    const protMatches = content.match(/(\d+)\s*protected\s*files/gi) || [];
    for (const pm of protMatches) {
      const num = parseInt(pm);
      if (num > 0 && num !== protectedFileCount) {
        drifts.push({ type: 'stale_protected_count', source: 'UNTOUCHABLE_FILES.txt', target: fname, field: 'protected_files', expected: String(protectedFileCount), found: String(num) });
      }
    }

    // Check for stale process count
    const procMatches = content.match(/(\d+)\s*(?:live\s+)?processes/gi) || [];
    for (const pcm of procMatches) {
      const num = parseInt(pcm);
      if (num > 0 && num !== expectedProcessCount && num < 100) {
        drifts.push({ type: 'stale_process_count', source: 'family-roles.json', target: fname, field: 'process_count', expected: String(expectedProcessCount), found: String(num) });
      }
    }

    // If no drifts found for this file, count as clean
    if (!drifts.some(d => d.target === fname)) {
      cleanChecks++;
    }
  }

  // 2. Check family-guide.json
  const guideFile2 = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'family-guide.json') : null;
  const guide = guideFile2 ? safeReadJSON(guideFile2) : null;
  if (guide) {
    const guideStr = JSON.stringify(guide);
    // Check version refs
    const guideVersions = guideStr.match(/v(\d+\.\d+\.\d+)/g) || [];
    for (const gv of guideVersions) {
      const ver = gv.substring(1);
      if (ver !== expectedVersion && /^1\.\d+\.\d+$/.test(ver)) {
        drifts.push({ type: 'stale_version', source: 'package.json', target: 'family-guide.json', field: 'version', expected: expectedVersion, found: ver });
      }
    }
    // Check tool count refs
    const guideToolMatches = guideStr.match(/(\d+)\s*(?:MCP\s+)?tools/gi) || [];
    for (const gtm of guideToolMatches) {
      const num = parseInt(gtm);
      if (num > 0 && num !== actualToolCount && num < 50) {
        drifts.push({ type: 'stale_tool_count', source: 'TOOLS array', target: 'family-guide.json', field: 'tool_count', expected: String(actualToolCount), found: String(num) });
      }
    }
    // Check for references to removed tools
    if (guideStr.includes('classify_task_complexity') || guideStr.includes('parse_user_intent')) {
      drifts.push({ type: 'stale_tool_reference', source: 'TOOLS array', target: 'family-guide.json', field: 'removed_tools', expected: 'drift_audit', found: 'classify_task_complexity/parse_user_intent' });
    }
  } else { cleanChecks++; }

  // 3. Check mcp-stripe-checkout.js for version refs
  const checkoutContent = projectPath('project_root') ? safeReadFile(path.join(projectPath('project_root') || process.cwd(), 'mcp-stripe-checkout.js')) : null;
  if (checkoutContent) {
    const checkoutVersions = checkoutContent.match(/v(\d+\.\d+\.\d+)/g) || [];
    for (const cv of checkoutVersions) {
      const ver = cv.substring(1);
      if (ver !== expectedVersion && /^1\.\d+\.\d+$/.test(ver)) {
        drifts.push({ type: 'stale_version', source: 'package.json', target: 'mcp-stripe-checkout.js', field: 'version', expected: expectedVersion, found: ver });
      }
    }
    if (!checkoutVersions.length) cleanChecks++;
  }

  // 4. Check system-config.json for version/tool counts
  const sysConfigFile2 = projectPath('config_file');
  const sysConfig = sysConfigFile2 ? safeReadJSON(sysConfigFile2) : null;
  if (sysConfig) {
    const scStr = JSON.stringify(sysConfig);
    const scVersions = scStr.match(/v(\d+\.\d+\.\d+)/g) || [];
    for (const sv of scVersions) {
      const ver = sv.substring(1);
      if (ver !== expectedVersion && /^1\.\d+\.\d+$/.test(ver)) {
        drifts.push({ type: 'stale_version', source: 'package.json', target: 'system-config.json', field: 'version', expected: expectedVersion, found: ver });
      }
    }
    if (!scVersions.length) cleanChecks++;
  }

  // 5. Check FREE_TOOLS in mcp-api-middleware.js match actual tool names
  const middlewareContent = projectPath('project_root') ? safeReadFile(path.join(projectPath('project_root') || process.cwd(), 'mcp-api-middleware.js')) : null;
  if (middlewareContent) {
    const freeToolsMatch = middlewareContent.match(/'nervous-system':\s*\[([^\]]+)\]/);
    if (freeToolsMatch) {
      const freeToolNames = freeToolsMatch[1].match(/'([^']+)'/g);
      if (freeToolNames) {
        const actualToolNames = TOOLS.map(t => t.name);
        for (const ft of freeToolNames) {
          const toolName = ft.replace(/'/g, '');
          if (actualToolNames.includes(toolName)) {
            cleanChecks++;
          } else {
            drifts.push({ type: 'invalid_free_tool', source: 'TOOLS array', target: 'mcp-api-middleware.js', field: 'FREE_TOOLS', expected: 'valid tool name', found: toolName });
          }
        }
      }
    }
  }

  // 6. Check sitemap.xml has all public pages
  const sitemapContent = familyHomeDir ? safeReadFile(path.join(familyHomeDir, 'sitemap.xml')) : null;
  if (sitemapContent && htmlFiles.length > 0) {
    const publicPages = htmlFiles.filter(f => {
      const name = f.split('/').pop();
      return !['404.html', 'arthur.html', 'aram-consent.html', 'explorer.html', 'checklist.html'].includes(name);
    });
    for (const page of publicPages) {
      const pageName = page.split('/').pop();
      if (pageName === 'index.html') {
        if (sitemapContent.includes('/family/')) cleanChecks++;
      } else {
        if (sitemapContent.includes(pageName)) {
          cleanChecks++;
        } else {
          drifts.push({ type: 'missing_from_sitemap', source: 'sitemap.xml', target: pageName, field: 'listed', expected: 'true', found: 'false' });
        }
      }
    }
  }

  return { drifts, cleanChecks };
}

function runDriftAudit(scope) {
  const timestamp = new Date().toISOString();
  const allDrifts = [];
  let totalClean = 0;
  const scopes = scope === 'full' ? ['roles', 'versions', 'files', 'processes', 'website'] : [scope];

  for (const s of scopes) {
    let result;
    switch (s) {
      case 'roles': result = auditRoles(); break;
      case 'versions': result = auditVersions(); break;
      case 'files': result = auditFiles(); break;
      case 'processes': result = auditProcesses(); break;
      case 'website': result = auditWebsite(); break;
      default: result = { drifts: [{ type: 'unknown_scope', source: '', target: '', field: s, expected: 'valid scope', found: 'unknown' }], cleanChecks: 0 };
    }
    allDrifts.push(...result.drifts);
    totalClean += result.cleanChecks;
  }

  return {
    scope,
    timestamp,
    status: allDrifts.length === 0 ? 'clean' : 'drift_detected',
    drift_count: allDrifts.length,
    drifts: allDrifts,
    clean_checks: totalClean
  };
}

// ============================================================
// SECURITY AUDIT ENGINE
// ============================================================

function runSecurityAudit() {
  const vulnerabilities = [];
  let checksPassed = 0;

  // 1. Scan HTML files for hardcoded passwords/secrets
  const htmlDir = projectPath('html_dir');
  if (!htmlDir) {
    return { status: 'skipped', vulnerability_count: 0, checks_passed: 0, vulnerabilities: [], skipped: 'html_dir not configured' };
  }
  const secretPatterns = [
    /\d{10}:AA[A-Za-z0-9_-]{30,}/g,        // Telegram bot tokens
    /sk-ant-[a-zA-Z0-9_-]+/g,               // Anthropic API keys
    /sk_live_[a-zA-Z0-9]+/g,                // Stripe live keys
    /sk_test_[a-zA-Z0-9]+/g,                // Stripe test keys
    /npm_[A-Za-z0-9]{20,}/g,                // npm tokens
    /ghp_[A-Za-z0-9]{20,}/g,                // GitHub PATs
    /BOT_TOKEN\s*[:=]\s*['"][^'"]+['"]/gi,   // Generic bot tokens
    /password\s*[:=]\s*['"][^'"]{8,}['"]/gi, // Hardcoded passwords
    /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi, // API keys
    /secret\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,       // Secrets
  ];
  try {
    const htmlFiles = fs.readdirSync(htmlDir).filter(f => f.endsWith('.html'));
    for (const hf of htmlFiles) {
      const content = safeReadFile(htmlDir + hf);
      if (!content) continue;
      let fileClean = true;
      const contentLines = content.split('\n');
      for (const pat of secretPatterns) {
        pat.lastIndex = 0;
        let realMatches = 0;
        for (const line of contentLines) {
          // Skip lines that are defining detection patterns (not actual secrets)
          if (line.trim().match(/^\s*\/.*\/[gim]*,?\s*$/) ||
              line.includes('SENS_PAT') ||
              line.includes('secretPatterns') ||
              line.includes('leakPatterns') ||
              line.includes('dangerPatterns') ||
              line.includes('redact')) continue;
          pat.lastIndex = 0;
          const m = line.match(pat);
          if (m) realMatches += m.length;
        }
        if (realMatches > 0) {
          vulnerabilities.push({ type: 'hardcoded_secret', file: hf, pattern: pat.source, count: realMatches });
          fileClean = false;
        }
      }
      if (fileClean) checksPassed++;
    }
  } catch (e) {
    vulnerabilities.push({ type: 'scan_error', file: 'html_scan', detail: e.message });
  }

  // 2. Check auth endpoints use server-side validation
  const serverContent = htmlDir ? safeReadFile(path.join(htmlDir, 'server.js')) : null;
  if (serverContent) {
    if (serverContent.includes('getSessionFromReq') || serverContent.includes('getAccessLevel')) {
      checksPassed++;
    } else {
      vulnerabilities.push({ type: 'missing_server_auth', file: 'server.js', detail: 'No server-side auth validation found' });
    }
  }

  // 3. Verify GUEST_HIDDEN_FILES covers sensitive files
  if (serverContent) {
    const sensitiveFiles = ['api-credentials.json', 'family-roles.json', 'system-config.json', 'llm-providers.json'];
    for (const sf of sensitiveFiles) {
      if (serverContent.includes('"' + sf + '"') || serverContent.includes("'" + sf + "'")) {
        checksPassed++;
      } else {
        vulnerabilities.push({ type: 'unhidden_sensitive_file', file: sf, detail: 'Not in GUEST_HIDDEN_FILES' });
      }
    }
  }

  // 4. Check Caddy TLS
  const caddyContent = safeReadFile('/etc/caddy/Caddyfile');
  if (caddyContent) {
    if (caddyContent.includes('tls') || caddyContent.includes('https://') || caddyContent.includes('100levelup.com')) {
      checksPassed++;
    } else {
      vulnerabilities.push({ type: 'missing_tls', file: 'Caddyfile', detail: 'No TLS configuration found' });
    }
  }

  // 5. Check bridge rate limiting
  const projRoot = projectPath('project_root') || process.cwd();
  if (serverContent && serverContent.includes('rate') || fs.existsSync(path.join(projRoot, 'rate-limit.js')) || fs.existsSync(path.join(projRoot, 'bridge-ratelimit.js'))) {
    checksPassed++;
  } else {
    vulnerabilities.push({ type: 'missing_rate_limit', file: 'bridge', detail: 'No rate limiting found for bridge' });
  }

  // 6. Check bot tokens not in public HTML
  try {
    const htmlFiles = fs.readdirSync(htmlDir).filter(f => f.endsWith('.html'));
    let tokenFound = false;
    for (const hf of htmlFiles) {
      const content = safeReadFile(htmlDir + hf);
      if (!content) continue;
      const tokenMatch = content.match(/\d{10}:AA[A-Za-z0-9_-]{30,}/g);
      if (tokenMatch) {
        vulnerabilities.push({ type: 'exposed_bot_token', file: hf, count: tokenMatch.length });
        tokenFound = true;
      }
    }
    if (!tokenFound) checksPassed++;
  } catch (e) {}

  // 7. Check api-credentials.json permissions
  try {
    const credFile = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'api-credentials.json') : null;
    if (!credFile) { checksPassed++; }
    if (fs.existsSync(credFile)) {
      const stats = fs.statSync(credFile);
      const mode = (stats.mode & 0o777).toString(8);
      if (mode === '600') {
        checksPassed++;
      } else {
        vulnerabilities.push({ type: 'insecure_permissions', file: 'api-credentials.json', detail: 'Mode is ' + mode + ', should be 600' });
      }
    } else {
      checksPassed++; // No creds file = no risk
    }
  } catch (e) {}

  // 8. Check for Telegram tokens, API keys, npm tokens in family-home
  try {
    const allFiles = fs.readdirSync(htmlDir);
    const dangerPatterns = [
      { name: 'telegram_token', pat: /\d{10}:AA[A-Za-z0-9_-]{30,}/g },
      { name: 'anthropic_key', pat: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
      { name: 'npm_token', pat: /npm_[A-Za-z0-9]{20,}/g }
    ];
    for (const f of allFiles) {
      if (f.endsWith('.html') || f.endsWith('.js') || f.endsWith('.json')) {
        const content = safeReadFile(htmlDir + f);
        if (!content) continue;
        for (const dp of dangerPatterns) {
          dp.pat.lastIndex = 0;
          const m = content.match(dp.pat);
          if (m) {
            vulnerabilities.push({ type: 'exposed_' + dp.name, file: f, count: m.length });
          }
        }
      }
    }
    checksPassed++;
  } catch (e) {}

  return {
    status: vulnerabilities.length === 0 ? 'secure' : 'vulnerabilities_found',
    vulnerability_count: vulnerabilities.length,
    checks_passed: checksPassed,
    vulnerabilities
  };
}

// ============================================================
// AUTO PROPAGATE ENGINE
// ============================================================

function runAutoPropagators() {
  const results = [];
  const workersDir = projectPath('project_root') ? path.join(projectPath('project_root') || process.cwd(), 'family-workers') : null;
  if (!workersDir || !fs.existsSync(workersDir)) {
    return { timestamp: new Date().toISOString(), propagators_run: 0, results: [], skipped: 'family-workers directory not found' };
  }
  const scripts = [
    { name: 'role', path: path.join(workersDir, 'role-propagator.js') },
    { name: 'version', path: path.join(workersDir, 'version-propagator.js') },
    { name: 'content', path: path.join(workersDir, 'content-propagator.js') }
  ];
  for (const script of scripts) {
    try {
      const out = execSync('node ' + script.path + ' 2>&1', { timeout: 15000 }).toString();
      const current = out.indexOf('Already current') !== -1;
      results.push({ propagator: script.name, status: current ? 'current' : 'updated', output: out.trim().substring(0, 500) });
    } catch (e) {
      results.push({ propagator: script.name, status: 'error', error: e.message.substring(0, 200) });
    }
  }
  return {
    timestamp: new Date().toISOString(),
    propagators_run: results.length,
    results
  };
}

// ============================================================
// PAGE HEALTH ENGINE
// ============================================================

function runPageHealth(page) {
  const FAMILY_HOME = projectPath('html_dir');
  if (!FAMILY_HOME) {
    return { status: 'skipped', pages_checked: 0, issue_count: 0, issues: [], skipped: 'html_dir not configured' };
  }
  const issues = [];

  let htmlFiles;
  if (page && page !== 'all') {
    const target = page.endsWith('.html') ? page : page + '.html';
    const fullPath = `${FAMILY_HOME}/${target}`;
    if (!fs.existsSync(fullPath)) return { status: 'error', error: `File not found: ${target}` };
    htmlFiles = [target];
  } else {
    try {
      htmlFiles = fs.readdirSync(FAMILY_HOME).filter(f => f.endsWith('.html'));
    } catch (e) {
      return { status: 'error', error: `Cannot read ${FAMILY_HOME}: ${e.message}` };
    }
  }

  for (const file of htmlFiles) {
    const filePath = `${FAMILY_HOME}/${file}`;
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { continue; }

    // 1. BROKEN LINKS - local href/src that don't exist
    const localRefs = [];
    const hrefMatches = content.matchAll(/(?:href|src)=["'](?!https?:\/\/|mailto:|tel:|#|javascript:|data:)([^"'#?]+)/gi);
    for (const m of hrefMatches) {
      const ref = m[1].trim();
      if (!ref || ref.startsWith('//') || ref.startsWith('{')) continue;
      localRefs.push(ref);
    }
    for (const ref of localRefs) {
      const resolved = ref.startsWith('/') ? ref : `${FAMILY_HOME}/${ref}`;
      if (!fs.existsSync(resolved)) {
        issues.push({ page: file, type: 'broken_link', detail: `Local reference "${ref}" - file not found` });
      }
    }

    // 2. BROKEN FETCHES - check fetch() endpoints respond on localhost
    const fetchMatches = content.matchAll(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g);
    for (const m of fetchMatches) {
      const url = m[1];
      if (url.includes('${')) continue; // skip template literals with variables
      if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1') || url.startsWith('/')) {
        let testUrl = url;
        if (url.startsWith('/')) {
          // Try to figure out port from context, default to common ports
          testUrl = `http://localhost:3000${url}`;
        }
        try {
          execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${testUrl}"`, { encoding: 'utf8', timeout: 3000 });
        } catch (e) {
          issues.push({ page: file, type: 'broken_fetch', detail: `fetch("${url}") - endpoint not responding` });
        }
      }
    }

    // 3. MOBILE NAV - has nav-links but no hamburger/mobile menu
    const hasNavLinks = /class=["'][^"']*nav-links/i.test(content) || /<nav[\s>]/i.test(content);
    const hasHamburger = /hamburger|mobile-menu|menu-toggle|nav-toggle|burger/i.test(content) || /class=["'][^"']*toggle/i.test(content);
    if (hasNavLinks && !hasHamburger) {
      issues.push({ page: file, type: 'no_mobile_menu', detail: 'nav-links found but no hamburger toggle for mobile' });
    }

    // 4. PLACEHOLDER TEXT - "--" as default in stat/value elements
    const placeholderMatches = content.matchAll(/id=["']([^"']+)["'][^>]*>\s*--\s*</g);
    for (const m of placeholderMatches) {
      issues.push({ page: file, type: 'placeholder_text', detail: `Element "${m[1]}" shows "--" (live data not loading)` });
    }
    // Also check spans/divs with class containing stat/value/count
    const statPlaceholders = content.matchAll(/class=["'][^"']*(?:stat|value|count|metric)[^"']*["'][^>]*>\s*--\s*</gi);
    for (const m of statPlaceholders) {
      issues.push({ page: file, type: 'placeholder_text', detail: 'Stat/value element shows "--" (live data not loading)' });
    }

    // 5. MISSING IMAGES - img src referencing local files that don't exist
    const imgMatches = content.matchAll(/<img[^>]+src=["'](?!https?:\/\/|data:)([^"']+)["']/gi);
    for (const m of imgMatches) {
      const src = m[1].trim();
      if (!src || src.startsWith('{')) continue;
      const resolved = src.startsWith('/') ? src : `${FAMILY_HOME}/${src}`;
      if (!fs.existsSync(resolved)) {
        issues.push({ page: file, type: 'missing_image', detail: `Image "${src}" not found` });
      }
    }

    // 6. STALE LINKS - external links to app stores, npm, github format check
    const extLinkMatches = content.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi);
    for (const m of extLinkMatches) {
      const url = m[1];
      if (/play\.google\.com/.test(url) && !/play\.google\.com\/store\/apps\/details\?id=/.test(url)) {
        issues.push({ page: file, type: 'stale_link', detail: `Malformed Play Store link: ${url}` });
      }
      if (/apps\.apple\.com/.test(url) && !/apps\.apple\.com\/.*\/app\//.test(url)) {
        issues.push({ page: file, type: 'stale_link', detail: `Malformed App Store link: ${url}` });
      }
      if (/npmjs\.com/.test(url) && !/npmjs\.com\/package\//.test(url)) {
        issues.push({ page: file, type: 'stale_link', detail: `Malformed npm link: ${url}` });
      }
      if (/github\.com/.test(url) && /github\.com\/?["']/.test(url)) {
        issues.push({ page: file, type: 'stale_link', detail: `Generic GitHub link (no repo): ${url}` });
      }
    }

    // 7. MISSING OG TAGS
    const ogTags = ['og:title', 'og:description', 'og:image'];
    for (const tag of ogTags) {
      if (!content.includes(`property="${tag}"`) && !content.includes(`property='${tag}'`)) {
        issues.push({ page: file, type: 'missing_og_tag', detail: `Missing ${tag} meta tag` });
      }
    }

    // 8. MISSING FAVICON
    if (!/rel=["'](?:icon|shortcut icon)["']/i.test(content)) {
      issues.push({ page: file, type: 'missing_favicon', detail: 'No favicon link tag found' });
    }

    // 9. CONSOLE ERRORS - JS syntax issues (unclosed tags, mismatched brackets)
    const scriptBlocks = content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of scriptBlocks) {
      const js = m[1].trim();
      if (!js) continue;
      // Check bracket balance
      let parens = 0, braces = 0, brackets = 0;
      for (const ch of js) {
        if (ch === '(') parens++;
        else if (ch === ')') parens--;
        else if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
      if (parens !== 0) issues.push({ page: file, type: 'js_syntax', detail: `Mismatched parentheses in script block (balance: ${parens})` });
      if (braces !== 0) issues.push({ page: file, type: 'js_syntax', detail: `Mismatched braces in script block (balance: ${braces})` });
      if (brackets !== 0) issues.push({ page: file, type: 'js_syntax', detail: `Mismatched brackets in script block (balance: ${brackets})` });
    }

    // 10. EMPTY SECTIONS
    const sectionMatches = content.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/gi);
    for (const m of sectionMatches) {
      const inner = m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim();
      if (!inner) {
        issues.push({ page: file, type: 'empty_section', detail: 'Section tag with no visible content' });
      }
    }
  }

  return {
    status: issues.length === 0 ? 'healthy' : 'issues_found',
    pages_checked: htmlFiles.length,
    issue_count: issues.length,
    issues
  };
}


// ============================================================
// PRE-PUBLISH AUDIT ENGINE
// ============================================================

function runPrePublishAudit(sourceFile) {
  const findings = [];
  const file = sourceFile || __filename;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { status: 'error', error: 'Cannot read file: ' + e.message };
  }
  const lines = content.split('\n');

  // 1. Check for hardcoded absolute paths (non-portable)
  lines.forEach((line, idx) => {
    if (line.trim().startsWith('//')) return;
    if (line.includes('description:') || line.includes('context:')) return;
    if (line.includes('description,') || line.includes("description'")) return;

    if (line.match(/['"\`]\/root\//)) {
      findings.push({
        type: 'hardcoded_path',
        line: idx + 1,
        preview: line.trim().substring(0, 100),
        fix: 'Use projectPath() or configurable path'
      });
    }
    if (line.match(/['"\`]\/home\//)) {
      findings.push({
        type: 'hardcoded_path',
        line: idx + 1,
        preview: line.trim().substring(0, 100),
        fix: 'Use projectPath() or os.homedir()'
      });
    }
  });

  // 2. Check for personal data that should not ship
  const personalPatterns = [
    { name: 'email_address', pat: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
    { name: 'phone_number', pat: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g },
    { name: 'ip_address', pat: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  ];
  lines.forEach((line, idx) => {
    if (line.trim().startsWith('//') || line.includes('description')) return;
    if (line.includes('regex') || line.includes('pattern') || line.includes('pat:')) return;
    for (const pp of personalPatterns) {
      pp.pat.lastIndex = 0;
      if (pp.pat.test(line)) {
        findings.push({
          type: 'personal_data',
          subtype: pp.name,
          line: idx + 1,
          preview: line.trim().substring(0, 100),
        });
      }
    }
  });

  // 3. Check for internal naming that should be generic
  const internalTerms = [
    'family-data', 'family-home', 'family-logs', 'family-roles',
    'family-guide', 'family-status', 'family-workers',
    'PAPA_FULL', 'PAPA_READ', 'ARTHUR_CHAT_ID',
  ];
  lines.forEach((line, idx) => {
    if (line.trim().startsWith('//')) return;
    if (line.includes('description:') || line.includes('context:') || line.includes('tagline:')) return;
    if (line.includes('origin_story')) return;
    for (const term of internalTerms) {
      if (line.toLowerCase().includes(term.toLowerCase()) &&
          !line.includes('// ')) {
        findings.push({
          type: 'internal_naming',
          term: term,
          line: idx + 1,
          preview: line.trim().substring(0, 100),
        });
      }
    }
  });

  // 4. GATE: Block publish if critical findings
  const critical = findings.filter(f =>
    f.type === 'personal_data' ||
    (f.type === 'hardcoded_path' && !f.preview.includes('description'))
  );

  return {
    status: findings.length === 0 ? 'ready_to_publish' :
            critical.length > 0 ? 'BLOCKED_critical_findings' : 'warnings_only',
    total_findings: findings.length,
    critical_count: critical.length,
    findings: findings,
    recommendation: critical.length > 0 ?
      'DO NOT PUBLISH. Fix critical findings first.' :
      findings.length > 0 ?
      'Review warnings before publishing. None are blockers.' :
      'Clean. Safe to publish.'
  };
}

// ============================================================
// Handle tool calls
// ============================================================
function handleToolCall(name, args) {
  switch (name) {
    case 'get_framework':
      return FRAMEWORK;

    case 'session_handoff': {
      switch (args.action) {
        case 'read_example':
          return { example: { header: '# SESSION HANDOFF\nUpdated: 2026-03-01 18:30 UTC', sections: ['WHAT JUST HAPPENED', 'SYSTEM STATE', 'WHAT NEEDS TO HAPPEN NEXT', 'FILES CHANGED', 'HUMAN ACTIONS NEEDED'], key_qualities: ['Specific enough that the next session needs zero additional context', 'Lists exact files changed', 'Separates system state from action items', 'Flags human-required actions separately'] } };
        case 'get_template': return SESSION_HANDOFF_TEMPLATE;
        case 'get_best_practices': return { best_practices: SESSION_HANDOFF_TEMPLATE.best_practices, example_sections: SESSION_HANDOFF_TEMPLATE.example_sections };
        default: return { error: 'Unknown action', available: ['read_example', 'get_template', 'get_best_practices'] };
      }
    }

    case 'preflight_check': {
      switch (args.action) {
        case 'get_script': return { script: PREFLIGHT_PATTERN.script_template, concept: PREFLIGHT_PATTERN.concept };
        case 'get_pattern': return { concept: PREFLIGHT_PATTERN.concept, flow: PREFLIGHT_PATTERN.flow };
        case 'get_untouchable_template': return { template: PREFLIGHT_PATTERN.untouchable_template };
        default: return { error: 'Unknown action', available: ['get_script', 'get_pattern', 'get_untouchable_template'] };
      }
    }

    case 'worklog': {
      switch (args.action) {
        case 'get_template': return { format: WORKLOG_TEMPLATE.format, example: WORKLOG_TEMPLATE.example };
        case 'get_format': return { format: WORKLOG_TEMPLATE.format };
        case 'get_best_practices': return { best_practices: WORKLOG_TEMPLATE.best_practices };
        default: return { error: 'Unknown action', available: ['get_template', 'get_format', 'get_best_practices'] };
      }
    }

    case 'guardrail_rules': {
      const rule = args.rule || 'all';
      if (rule === 'all') return GUARDRAIL_RULES;
      if (GUARDRAIL_RULES[rule]) return GUARDRAIL_RULES[rule];
      return { error: 'Unknown rule', available: Object.keys(GUARDRAIL_RULES) };
    }

    case 'violation_logging': {
      switch (args.action) {
        case 'get_pattern': return VIOLATION_LOGGING.pattern;
        case 'get_template': return { template: VIOLATION_LOGGING.template };
        case 'get_enforcement': return VIOLATION_LOGGING.enforcement;
        default: return { error: 'Unknown action', available: ['get_pattern', 'get_template', 'get_enforcement'] };
      }
    }

    case 'step_back_check': {
      const reflection = { trigger: SEVEN_LEVELS.trigger, steps: SEVEN_LEVELS.steps, instruction: SEVEN_LEVELS.instruction, purpose: SEVEN_LEVELS.purpose };
      if (args.context) {
        reflection.tailored_prompt = `STEP BACK NOW.\n\nYou are currently working on: ${args.context}\n\nBefore your next action, answer these questions OUT LOUD to the human:\n1. What are we actually building? Is "${args.context}" the right thing to work on right now?\n2. Are we solving the real problem or just the surface symptom?\n3. Is this moving toward revenue or just toward "busy"?\n4. What would a partner say about this direction?\n5. Is the operations layer involved, or are we bypassing it?\n\nSay your answers. Then continue.`;
      }
      return reflection;
    }

    case 'get_nervous_system_info': {
      switch (args.topic) {
        case 'overview': return NERVOUS_SYSTEM_INFO.overview;
        case 'origin_story': return NERVOUS_SYSTEM_INFO.origin_story;
        case 'implementation_guide': return NERVOUS_SYSTEM_INFO.implementation_guide;
        case 'problem_it_solves': return NERVOUS_SYSTEM_INFO.problem_it_solves;
        case 'stats': return NERVOUS_SYSTEM_INFO.stats;
        default: return { error: 'Unknown topic', available: ['overview', 'origin_story', 'implementation_guide', 'problem_it_solves', 'stats'] };
      }
    }

    // NEW TOOLS
    case 'emergency_kill_switch': {
      if (args.secret !== KILL_SECRET) {
        return { error: 'Invalid kill switch secret', activated: false };
      }
      const cmd = args.command || 'pm2 stop all';
      const source = args.source || 'unknown';
      const timestamp = new Date().toISOString();
      addAuditEntry('KILL_SWITCH', `Activated by ${source}. Command: ${cmd}`);
      try {
        const { execSync } = require('child_process');
        const output = execSync(cmd, { timeout: 30000 }).toString();
        return { activated: true, timestamp, source, command: cmd, output: output.substring(0, 500) };
      } catch (e) {
        return { activated: true, timestamp, source, command: cmd, error: e.message };
      }
    }

    case 'verify_audit_chain': {
      return verifyAuditChain();
    }

    case 'dispatch_to_llm': {
      return dispatchToLLM(args.task, args.max_turns);
    }

    case 'drift_audit': {
      const scope = args.scope || 'full';
      return runDriftAudit(scope);
    }

    case 'security_audit': {
      return runSecurityAudit();
    }

    case 'auto_propagate': {
      return runAutoPropagators();
    }

    case 'session_close': {
      const driftResult = runDriftAudit('full');
      const propagateResult = runAutoPropagators();
      return {
        timestamp: new Date().toISOString(),
        drift_audit: driftResult,
        propagation: propagateResult,
        summary: driftResult.drift_count === 0 ? 'Session clean - no drifts, propagators run' : `${driftResult.drift_count} drifts found - review before closing`
      };
    }

    case 'page_health': {
      return runPageHealth(args.page || 'all');
    }

    case 'pre_publish_audit': {
      return runPrePublishAudit(args.source_file);
    }

    default:
      return { error: 'Unknown tool' };
  }
}

// Handle resource reads
function handleResourceRead(uri) {
  switch (uri) {
    case 'nervous-system://framework':
      return `The Nervous System - LLM Behavioral Enforcement Framework
Built by Arthur Palyan

${FRAMEWORK.tagline}

PROBLEM: ${FRAMEWORK.problem}

SOLUTION: ${FRAMEWORK.solution}

THE 7 CORE RULES:
${FRAMEWORK.core_rules.map((r, i) => `${i + 1}. ${r.name}: ${r.rule}\n   WHY: ${r.why}`).join('\n\n')}

PERMISSION PROTOCOL:
- DATA changes (${FRAMEWORK.permission_protocol.data_changes}): Act with direction.
- LOGIC changes (${FRAMEWORK.permission_protocol.logic_changes}): Propose and wait.
- ${FRAMEWORK.permission_protocol.rule}

BEFORE ANY CHANGE:
${FRAMEWORK.before_any_change.map(s => `- ${s}`).join('\n')}`;

    case 'nervous-system://quick-start':
      return Object.values(NERVOUS_SYSTEM_INFO.implementation_guide).map(step => `${step.name}\n${step.description}`).join('\n\n');

    case 'nervous-system://rules':
      return Object.values(GUARDRAIL_RULES).map(r => `## ${r.name}\n${r.rule}${r.implementation ? '\n\nImplementation:\n' + r.implementation.map(s => `- ${s}`).join('\n') : ''}`).join('\n\n---\n\n');

    case 'nervous-system://templates':
      return `## SESSION HANDOFF TEMPLATE\n${SESSION_HANDOFF_TEMPLATE.template}\n\n---\n\n## WORKLOG FORMAT\n${WORKLOG_TEMPLATE.format}\n\n---\n\n## PREFLIGHT SCRIPT\n${PREFLIGHT_PATTERN.script_template}\n\n---\n\n## UNTOUCHABLE FILES TEMPLATE\n${PREFLIGHT_PATTERN.untouchable_template}`;

    case 'nervous-system://drift-audit': {
      const result = runDriftAudit('full');
      return `## Drift Audit Report\nTimestamp: ${result.timestamp}\nStatus: ${result.status}\nDrifts found: ${result.drift_count}\nClean checks: ${result.clean_checks}\n\n${result.drifts.map(d => `- [${d.type}] ${d.source} -> ${d.target}: ${d.field} expected="${d.expected}" found="${d.found}"`).join('\n') || 'No drifts detected.'}`;
    }

    default:
      return null;
  }
}

// ============================================================
// MCP Protocol Handling
// ============================================================

function jsonrpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const sseConnections = new Map();

function handleMCPRequest(body, req) {
  const { method, params, id } = body;

  switch (method) {
    case 'initialize':
      return jsonrpc(id, {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return jsonrpc(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      if (req) {
        const validation = validateRequest(req, SERVER_NAME_ID, name);
        if (!validation.allowed) return mcpErrorResponse(id, validation);
      }
      const result = handleToolCall(name, args || {});
      return jsonrpc(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    }

    case 'resources/list':
      return jsonrpc(id, { resources: RESOURCES });

    case 'resources/read': {
      const content = handleResourceRead(params.uri);
      if (content) {
        return jsonrpc(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: content }] });
      }
      return jsonrpcError(id, -32602, 'Resource not found');
    }

    case 'ping':
      return jsonrpc(id, {});

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'nervous-system-mcp', version: '1.6.0', protocol: MCP_VERSION }));
    return;
  }

  // POST /kill - Kill Switch endpoint
  if (req.method === 'POST' && url.pathname === '/kill') {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');
    if (token !== KILL_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', activated: false }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let cmd = 'pm2 stop all';
      let source = 'HTTP';
      try {
        const parsed = JSON.parse(body);
        if (parsed.command) cmd = parsed.command;
        if (parsed.source) source = parsed.source;
      } catch (e) {}
      const timestamp = new Date().toISOString();
      addAuditEntry('KILL_SWITCH', `Activated by ${source}. Command: ${cmd}`);
      try {
        const { execSync } = require('child_process');
        const output = execSync(cmd, { timeout: 30000 }).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ activated: true, timestamp, source, command: cmd, output: output.substring(0, 500) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ activated: true, timestamp, source, command: cmd, error: e.message }));
      }
    });
    return;
  }

  // GET /audit/verify - Audit chain verification
  if (req.method === 'GET' && url.pathname === '/audit/verify') {
    const result = verifyAuditChain();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /dispatches - Show dispatch status
  if (req.method === 'GET' && url.pathname === '/dispatches') {
    cleanupDispatches();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      active: activeDispatches.filter(d => d.status === 'active'),
      completed: activeDispatches.filter(d => d.status === 'completed'),
      max_concurrent: MAX_CONCURRENT_DISPATCHES,
      free_ram_mb: getFreeMB()
    }));
    return;
  }

  // MCP SSE endpoint
  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
    sseConnections.set(sessionId, res);
    req.on('close', () => { sseConnections.delete(sessionId); });
    const keepAlive = setInterval(() => {
      if (!sseConnections.has(sessionId)) { clearInterval(keepAlive); return; }
      res.write(':keepalive\n\n');
    }, 30000);
    return;
  }

  // MCP message endpoint (SSE transport)
  if (req.method === 'POST' && url.pathname === '/message') {
    const sessionId = url.searchParams.get('sessionId');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const response = handleMCPRequest(parsed, req);
        const sseRes = sseConnections.get(sessionId);
        if (sseRes && response) sseRes.write(`event: message\ndata: ${response}\n\n`);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // MCP HTTP POST endpoint (Streamable HTTP transport)
  if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/mcp')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const response = handleMCPRequest(parsed, req);
        if (response) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(response); }
        else { res.writeHead(204); res.end(); }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonrpcError(null, -32700, 'Parse error'));
      }
    });
    return;
  }

  // Info page
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/mcp')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'The Nervous System MCP Server',
      version: '1.6.0',
      protocol: MCP_VERSION,
      description: 'LLM behavioral enforcement framework. 7 core rules, preflight checks, session handoffs, worklogs, violation logging, kill switch, hash-chained audit, and forced reflection cycles. Built by Arthur Palyan.',
      endpoints: {
        sse: '/sse', message: '/message', http: '/mcp', health: '/health',
        kill: 'POST /kill (auth required)', audit_verify: 'GET /audit/verify', dispatches: 'GET /dispatches'
      },
      tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
      resources: RESOURCES.map(r => ({ uri: r.uri, name: r.name })),
      links: { game: 'https://100levelup.com', website: 'https://www.levelsofself.com' }
    }, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Run migration on startup
migrateExistingViolations();

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[MCP Server] Nervous System v1.6.0 running on port ${PORT}`);
  console.error(`[MCP Server] SSE: /sse | HTTP: /mcp | Health: /health | Kill: POST /kill | Audit: GET /audit/verify | Dispatches: GET /dispatches`);
  console.error(`[MCP Server] Protocol: ${MCP_VERSION}`);
  console.error(`[MCP Server] Tools: ${TOOLS.length} (including kill switch, audit chain, dispatch, drift audit, page health, pre-publish audit)`);
});
