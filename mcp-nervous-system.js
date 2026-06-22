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

function dispatchToLLM(task, maxTurns, permissions) {
  cleanupDispatches();
  const active = activeDispatches.filter(d => d.status === 'active');
  if (active.length >= MAX_CONCURRENT_DISPATCHES)
    return { dispatched: false, error: `Max ${MAX_CONCURRENT_DISPATCHES} concurrent dispatches. ${active.length} running.` };
  const freeMB = getFreeMB();
  if (freeMB < 500) return { dispatched: false, error: `Insufficient RAM: ${freeMB}MB free (need 500MB+)` };
  const ts = Date.now();
  const logFile = projectPath('logs_dir') ? `${projectPath('logs_dir')}/dispatch-${ts}.log` : path.join(os.homedir(), '.nervous-system', `dispatch-${ts}.log`);
  const turns = maxTurns || 15;
  // Write task-level permissions if provided
  if (permissions && Array.isArray(permissions) && permissions.length > 0) {
    try {
      const permData = {
        permissions: permissions.map(function(fp) {
          return { file: fp, reason: 'Granted via dispatch_to_llm', granted_at: Date.now() / 1000 };
        })
      };
      fs.writeFileSync('/root/family-data/task-permissions.json', JSON.stringify(permData, null, 2));
    } catch (e) {}
  }

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
  version: '1.11.0'
};

// ============================================================
// THE NERVOUS SYSTEM - Content
// ============================================================

const FRAMEWORK = {
  name: 'The Nervous System',
  version: '1.11.0',
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
    },
    {
      id: 'confirm_destructive_intent',
      name: 'CONFIRM BEFORE DESTROYING',
      rule: 'Before ANY destructive action (stopping processes, deleting files, removing configs, disabling services), restate what you are about to do and what you understood the instruction to be. If the instruction contains exclusions (skip X, except Y, not Z, other than W), parse them FIRST and list what is EXCLUDED before listing what will be acted on. Never assume. If ambiguous, ask.',
      why: 'A misread instruction cost a client their running bots. The LLM read "skip stop the bots" as "stop the bots" instead of "skip that task." Destructive actions are irreversible in production. One wrong parse can take down customer systems, lose data, or break trust. The cost of confirming is 5 seconds. The cost of not confirming is unbounded.',
      enforcement: 'The preflight system should flag any command containing pm2 stop, pm2 delete, rm, kill, pkill, drop, truncate, disable, or revoke. Before execution, the LLM must output: DESTRUCTIVE ACTION: [what I will do]. EXCLUDED: [what I will NOT do]. UNDERSTOOD INSTRUCTION: [restatement]. If no exclusions exist, state "No exclusions." If the human did not confirm, do not execute.',
      real_world_example: 'Arthur said "Skip stop the Instagram bots" meaning DO NOT stop them. The LLM parsed it as an instruction TO stop them. All 4 bots went down. Recovery was fast but in a client deployment this could mean lost customers, missed messages, or broken SLAs.'
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
    context: 'Arthur Palyan runs a startup with 12 AI family members, each with distinct roles. The entire operation runs on a ~$48/month VPS with a $200/month LLM subscription, about $375/month all in.',
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
    monthly_cost: 'Under $500/month total infrastructure (about $375 actual)',
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
    inputSchema: { type: 'object', properties: { rule: { type: 'string', description: 'Which rule to retrieve.', enum: ['dispatch_dont_do', 'ask_before_touching', 'step_back', 'write_progress', 'hand_off', 'confirm_destructive_intent', 'permission_protocol', 'all'] } } }
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
        max_turns: { type: 'number', description: 'Max turns for the agent. Default: 15.' },
        permissions: { type: 'array', items: { type: 'string' }, description: 'File paths the agent is allowed to edit (bypasses UNTOUCHABLE for these files). Expires after 24h.' }
      },
      required: ['task']
    }
  },
  // NEW: Drift Audit
  {
    name: 'drift_audit',
    annotations: { title: 'Configuration Drift Audit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Scans for configuration drift - finds files, docs, and configs that reference outdated values. Detects when a file is renamed but references are not updated, when roles change but downstream docs still show old values, when running processes do not match documentation, when bots fail compliance with the 6 universal standards, or when family members in family-roles.json are missing from downstream locations. Scopes: roles, versions, files, processes, website, platforms, docs, bots, members.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['full', 'roles', 'versions', 'files', 'processes', 'website', 'docs', 'members', 'session_facts'],
          description: 'What to audit. full=everything, roles=family role consistency, versions=NS version numbers, files=file reference integrity, processes=PM2 vs docs, website=HTML pages and configs for stale values, docs=compares reality (pm2, ports, crons, dept folders) against BUSINESS_BUILDER.md, LLM_STARTUP.md, family-roles.json, members=checks every downstream location for missing family members from family-roles.json'
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
  // NEW: Propagate Family Member
  {
    name: 'propagate_family_member',
    annotations: { title: 'Propagate Family Member', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Checks family-roles.json as source of truth, detects missing members in all downstream locations, and auto-fixes what it can (family-status.json, system-config.json, HTML counts). Flags UNTOUCHABLE files for manual fix. Run after adding/removing a family member.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'If true, only report what would change without making changes. Default: false' }
      }
    }
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
  },
  // NEW: MCP Analyzer
  {
    name: 'mcp_analyzer',
    annotations: { title: 'MCP Analyzer', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Analyzes your project structure and generates a tailored CLAUDE.md with the most useful tools for your workflow. Use mode=analyze to see recommendations, mode=write to generate CLAUDE.md, mode=reload to re-scan and update. Turns the NS from generic tools into a trained assistant that knows your project.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['analyze', 'write', 'reload'], description: 'analyze=show recommendations, write=generate CLAUDE.md, reload=re-scan and update CLAUDE.md' },
        output_path: { type: 'string', description: 'Where to write CLAUDE.md. Defaults to project root.' }
      }
    }
  },
  // NEW: Self-Check
  {
    name: 'self_check',
    annotations: { title: 'Self-Check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Runs automated self-diagnosis on the Nervous System. Checks for: rate-limiting own operations, secrets in source code, info leakage in tool output, hardcoded paths, missing smoke tests, and version desync. Run before every publish and as part of security audits.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // NEW: Bot Compliance Check
  {
    name: 'bot_compliance_check',
    annotations: { title: 'Bot Compliance Check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Checks all public bot files against the 6 mandatory universal standards: (1) thinking message with 3-sec delay, (2) persistent typing indicator, (3) owner self-identification, (4) acceptance philosophy in prompt, (5) read receipts, (6) session summary extraction. Returns pass/fail per bot per standard.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Check a specific bot file path, or omit to check all 10 public bots' }
      }
    }
  },
  {
    name: 'usage_report',
    annotations: { title: 'Usage Report', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Check API token usage per bot per day. Shows which bots are consuming the most tokens and flags anomalies. Use this to monitor costs and catch runaway knowledge files.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to show (default: 3)' }
      }
    }
  },
  // v1.10.0 Infrastructure Tools
  {
    name: 'check_dependencies',
    annotations: { title: 'Dependency Mapper', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Generate dependency map showing which files each PM2 process requires. Returns dependency-map.json content.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_snapshot',
    annotations: { title: 'System Snapshot', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Create full system snapshot with one-command rollback script. Returns snapshot location, file count, and RESTORE.sh path.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'check_session_diff',
    annotations: { title: 'Session Diff', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Show what changed since last session - files modified, processes changed, alerts triggered. Returns SESSION_DIFF.md content.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fix_doc_drift',
    annotations: { title: 'Doc Drift Fixer', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Auto-fix drift between docs and reality (process counts, versions, port numbers). Use dry_run=true to preview changes.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'If true, only report drift without fixing. Default: true' }
      }
    }
  },
  {
    name: 'get_health_status',
    annotations: { title: 'Health Dashboard', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Generate current system health snapshot - RAM, disk, CPU, process states, crash loops, and alerts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'test_deployment',
    annotations: { title: 'Deployment Tester', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Run 5-step test pipeline on a file before deployment: preflight, syntax, dependencies, ports, memory.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Path to file to test before deployment' }
      },
      required: ['filepath']
    }
  },
  {
    name: 'check_page_changes',
    annotations: { title: 'Page Changelog', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Detect changes to public pages since last check. Returns list of changed pages with diffs.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Specific page to check (family, gateway, health), or omit for all' },
        since: { type: 'string', description: 'ISO date to check changes since (e.g. 2026-03-01)' }
      }
    }
  },
  {
    name: 'check_archive_safety',
    annotations: { title: 'Archive Safety Check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Check if a file is safe to archive - verifies it is not in use by active PM2 processes, not required by other files, and not in the untouchable list.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Path to file to check for archive safety' }
      },
      required: ['filepath']
    }
  },
  // NEW: Accountability Check
  {
    name: 'accountability_check',
    annotations: {
      title: 'Accountability Check',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Detects when an LLM agent fabricated a solution instead of finding the real one. Scans for: placeholder credentials next to real ones in backups, duplicate files/directories serving the same purpose, config files with defaults when populated versions exist elsewhere, and recently created workarounds for things that already exist. Run this after every session to catch fabrication before it costs time and money.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['full', 'credentials', 'duplicates', 'workarounds'],
          description: 'What to check. full = all checks. credentials = scan for placeholder keys next to real ones. duplicates = find files/dirs that duplicate existing ones. workarounds = detect recently created alternatives to existing resources.'
        },
        path: {
          type: 'string',
          description: 'Specific path to check (default: project root)'
        }
      }
    }
  },
  // NEW: Session Persist - save facts from chat to disk
  {
    name: 'session_persist',
    annotations: { title: 'Session Persist', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Persists a fact from the current session to disk. Use during conversation to save research findings, decisions, confirmations, credentials, contacts, deadlines, partner info, or API results. Facts are stored in /root/family-data/session-facts/{date}.jsonl and auto-processed into business-builder files.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['research', 'decision', 'confirmation', 'credential', 'contact', 'deadline', 'partner', 'api_result'], description: 'Type of fact being persisted' },
        title: { type: 'string', description: 'Short label for the fact' },
        content: { type: 'string', description: 'The actual information to save' },
        source: { type: 'string', description: 'Where this came from: chat, manus, web_search, agent' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Search tags for this fact' }
      },
      required: ['category', 'title', 'content']
    }
  },
  // Discovery Briefing - proactive intel tool
  {
    name: 'discovery_briefing',
    annotations: { title: 'Discovery Briefing', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Returns a structured intelligence briefing of discoveries relevant to your project. Reads user config to determine interests (AI updates, competitors, grants, gov contracts, trends). Items tagged [USE NOW], [WATCH], [OPPORTUNITY], [THREAT]. Run discovery-scanner.js via cron to keep data fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'anthropic', 'ecosystem', 'trending', 'government', 'competitors', 'techstack', 'grants'],
          description: 'Filter briefing by category. Default: all'
        },
        context: {
          type: 'string',
          description: 'Set to "auto" to read project config for relevance filtering. Default: auto'
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
  { uri: 'nervous-system://drift-audit', name: 'Drift Audit', description: 'Configuration drift detection - checks roles, versions, file references, and running processes against source-of-truth files', mimeType: 'text/plain' },
  { uri: 'nervous-system://tamara-reference', name: 'Tamara Reference Implementation', description: 'Autonomous AI operations manager - reference implementation for managing AI agent fleets using the Nervous System framework', mimeType: 'text/plain' },
  { uri: 'nervous-system://case-study', name: 'Palyan Family AI System Case Study', description: 'Production case study: 13 agents, 5 platforms, 175 countries, under $500/month - autonomous AI operations at scale', mimeType: 'text/plain' },
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

function auditPlatforms() {
  const drifts = [];
  let cleanChecks = 0;

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync('/root/family-data/platform-features.json', 'utf8'));
  } catch (e) {
    return { drifts: [{ type: 'platform_registry_missing', source: '/root/family-data/platform-features.json', target: '', field: 'exists', expected: 'true', found: 'false' }], cleanChecks: 0 };
  }

  const featurePatterns = {
    property_lookup: /require\(.*harout-property-lookup.*\)|propertyLookup/,
    calendly_booking: /calendly|book_calendly/i,
    write_log: /write_log/,
    doc_generation: /generateNDA|generateDoc|doc-generator/,
    nda_generation: /generateNDA|generateDoc|doc-generator/,
    doc_generation_via_link: /api\.100levelup\.com\/family\/docs|doc-generator/,
    ip_agreement: /ip.?agreement|generateIP/i,
    pdf_sending: /sendDocument|send.*pdf/i,
    admin_commands: /admin|\/start|isAdmin/i,
    tool_execution: /tool|function_call|executeTool/i,
    search_resource: /search_resource|searchResource/i,
    coaching: /coach|system.*prompt|openai|anthropic/i,
    legal_qa: /legal|lawyer|counsel|system.*prompt|openai|anthropic/i,
    real_estate_qa: /real.?estate|property|system.*prompt|openai|anthropic/i,
    translation: /translat/i,
    multilingual_support: /translat|language/i,
    fitness_training: /fitness|training|workout|system.*prompt|openai|anthropic/i,
    program_design: /program|routine|plan/i,
    client_notes: /notes|client.*note/i,
    accounting: /account|tax|bookkeep|system.*prompt|openai|anthropic/i,
    tax_prep: /tax/i,
    bookkeeping: /bookkeep|ledger|account/i,
    file_processing: /file|upload|attachment/i,
    csv_processing: /csv|comma.?separated/i,
    pdf_processing: /pdf|document.*process/i,
    youth_empowerment: /youth|empower|system.*prompt|openai|anthropic/i,
    training_sales: /training|sales|program/i,
    calendar_management: /calendar|schedule|booking/i,
    gang_consulting: /gang|consult|intervention/i,
    listing_management: /listing|mls|manage/i,
    lead_tracking: /lead|track|crm/i,
    nod_nts: /nod|nts|notice.*default/i,
    fix_flip: /fix.*flip|flip.*fix|rehab/i
  };

  for (const [memberName, member] of Object.entries(registry.members)) {
    for (const [platformName, platform] of Object.entries(member.platforms)) {
      const botFile = platform.file;

      if (!fs.existsSync(botFile)) {
        drifts.push({
          type: 'platform_file_missing',
          source: memberName + '/' + platformName,
          target: botFile,
          field: 'exists',
          expected: 'true',
          found: 'false'
        });
        continue;
      }

      let fileContent;
      try {
        fileContent = fs.readFileSync(botFile, 'utf8');
      } catch (e) {
        drifts.push({
          type: 'platform_file_unreadable',
          source: memberName + '/' + platformName,
          target: botFile,
          field: 'readable',
          expected: 'true',
          found: 'false'
        });
        continue;
      }

      for (const feature of platform.features) {
        const pattern = featurePatterns[feature];
        if (pattern) {
          if (pattern.test(fileContent)) {
            cleanChecks++;
          } else {
            drifts.push({
              type: 'platform_feature_missing',
              source: memberName + '/' + platformName,
              target: botFile,
              field: feature,
              expected: 'present_in_code',
              found: 'not_found'
            });
          }
        } else {
          // Fallback: check for the feature name as a string
          if (fileContent.includes(feature)) {
            cleanChecks++;
          } else {
            drifts.push({
              type: 'platform_feature_missing',
              source: memberName + '/' + platformName,
              target: botFile,
              field: feature,
              expected: 'present_in_code',
              found: 'not_found'
            });
          }
        }
      }
    }
  }

  return { drifts, cleanChecks };
}

// ============================================================
// DOC DRIFT AUDIT - Compares REALITY against DOCS
// ============================================================

function auditBotCompliance() {
  const drifts = [];
  let cleanChecks = 0;
  const compliance = runBotComplianceCheck();
  for (const r of compliance.results) {
    for (const [standard, check] of Object.entries(r.standards)) {
      if (check.pass) {
        cleanChecks++;
      } else {
        drifts.push({
          type: 'bot_compliance',
          source: r.file,
          target: 'BOT_BUILD_TEMPLATE.md',
          field: standard,
          expected: 'implemented',
          found: check.detail
        });
      }
    }
  }
  return { drifts, cleanChecks };
}

function auditDocs() {
  const drifts = [];
  let cleanChecks = 0;

  // 1A. Process drift: pm2 vs docs
  let pm2Procs = [];
  try {
    pm2Procs = JSON.parse(execSync('pm2 jlist', { timeout: 10000 }).toString());
  } catch (e) {
    drifts.push({ type: 'doc_pm2_error', source: 'pm2', target: 'docs', field: 'pm2_access', expected: 'readable', found: e.message });
  }

  const pm2Names = {};
  for (const p of pm2Procs) {
    pm2Names[p.name] = p.pm2_env ? p.pm2_env.status : 'unknown';
  }

  // Extract process tables from BUSINESS_BUILDER.md and LLM_STARTUP.md
  const bbPath = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'BUSINESS_BUILDER.md') : null;
  const startupPath = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'LLM_STARTUP.md') : null;
  const rolesPath = projectPath('roles_file');

  const bbContent = bbPath ? safeReadFile(bbPath) : null;
  const startupContent = startupPath ? safeReadFile(startupPath) : null;

  function extractProcessNames(mdContent, docName) {
    const names = {};
    if (!mdContent) return names;
    // Match table rows like: | name | file | purpose |
    const lines = mdContent.split('\n');
    let inProcessTable = false;
    for (const line of lines) {
      if (line.match(/\|\s*Name\s*\|\s*File\s*\|\s*Purpose/i) || line.match(/PM2 PROCESSES/i)) {
        inProcessTable = true;
        continue;
      }
      if (inProcessTable && line.match(/^\|[-\s|]+\|$/)) continue; // separator row
      if (inProcessTable && line.startsWith('|')) {
        const cells = line.split('|').map(c => c.trim()).filter(c => c);
        if (cells.length >= 2) {
          const name = cells[0];
          if (name && !name.match(/^(Name|---|Port|Schedule)/i)) {
            names[name] = docName;
          }
        }
      } else if (inProcessTable && !line.startsWith('|') && line.trim()) {
        inProcessTable = false;
      }
    }
    return names;
  }

  const bbProcs = extractProcessNames(bbContent, 'BUSINESS_BUILDER.md');
  const startupProcs = extractProcessNames(startupContent, 'LLM_STARTUP.md');

  // Merge doc process names
  const allDocProcs = { ...bbProcs, ...startupProcs };

  // Flag: processes in pm2 but not in any doc
  for (const name of Object.keys(pm2Names)) {
    if (allDocProcs[name]) {
      cleanChecks++;
    } else {
      drifts.push({ type: 'doc_process_undocumented', source: 'pm2', target: 'docs', field: name, expected: 'documented', found: 'not in any doc process table' });
    }
  }

  // Flag: processes in docs but not in pm2
  for (const [name, doc] of Object.entries(allDocProcs)) {
    if (pm2Names[name] !== undefined) {
      cleanChecks++;
    } else {
      drifts.push({ type: 'doc_process_missing_from_pm2', source: doc, target: 'pm2', field: name, expected: 'in pm2', found: 'not found' });
    }
  }

  // 1B. Family member drift: dept folders vs family-roles.json
  const roles = rolesPath ? safeReadJSON(rolesPath) : null;
  if (roles && roles.members) {
    const roleIds = new Set(roles.members.map(m => m.id).filter(Boolean));
    const roleNames = new Set(roles.members.map(m => (m.name || '').toLowerCase()));

    // Scan /root/dept-* directories
    const projRoot = projectPath('project_root') || '/root';
    try {
      const deptDirs = fs.readdirSync(projRoot).filter(d => d.startsWith('dept-') && fs.statSync(path.join(projRoot, d)).isDirectory());
      for (const dir of deptDirs) {
        const deptName = dir.replace('dept-', '');
        // Check if this dept name matches any member id or name
        const hasMatch = roleIds.has(deptName) ||
          roleNames.has(deptName) ||
          (deptName === 'uncle-lou' && (roleIds.has('lou') || roleNames.has('uncle lou')));
        if (hasMatch) {
          cleanChecks++;
        } else {
          drifts.push({ type: 'doc_dept_no_member', source: dir, target: 'family-roles.json', field: deptName, expected: 'member entry', found: 'no matching member' });
        }
      }
    } catch (e) {}

    // Check members have matching dept or process
    for (const m of roles.members) {
      const memberId = m.id || (m.name || '').toLowerCase();
      const deptPath = path.join(projRoot, 'dept-' + memberId);
      const altDeptPath = memberId === 'lou' ? path.join(projRoot, 'dept-uncle-lou') : null;
      const hasProcs = m.procs && m.procs.length > 0;
      const hasDept = fs.existsSync(deptPath) || (altDeptPath && fs.existsSync(altDeptPath));
      const hasPm2 = m.pm2_process ? pm2Names[m.pm2_process] !== undefined : false;

      if (hasDept || hasProcs || hasPm2) {
        cleanChecks++;
      } else {
        drifts.push({ type: 'doc_member_no_presence', source: 'family-roles.json', target: 'system', field: memberId, expected: 'dept folder or pm2 process', found: 'neither found' });
      }
    }

    // Check member_count accuracy
    if (roles.stats && roles.stats.member_count !== roles.members.length) {
      drifts.push({ type: 'doc_stats_mismatch', source: 'family-roles.json', target: 'stats.member_count', field: 'member_count', expected: String(roles.members.length), found: String(roles.stats.member_count) });
    } else if (roles.stats) {
      cleanChecks++;
    }
  }

  // 1C. Port drift: ss vs docs
  let listeningPorts = [];
  try {
    const ssOutput = execSync('ss -tlnp 2>/dev/null', { timeout: 5000 }).toString();
    const portMatches = ssOutput.matchAll(/:(\d+)\s/g);
    const portSet = new Set();
    for (const m of portMatches) {
      const port = parseInt(m[1]);
      if (port >= 3000 && port < 4000) portSet.add(port);
    }
    listeningPorts = Array.from(portSet);
  } catch (e) {}

  if (bbContent && listeningPorts.length > 0) {
    // Extract documented ports from BUSINESS_BUILDER.md
    const docPorts = new Set();
    const portMatches = bbContent.matchAll(/:(\d{4})\b/g);
    for (const m of portMatches) {
      const port = parseInt(m[1]);
      if (port >= 3000 && port < 4000) docPorts.add(port);
    }

    for (const port of listeningPorts) {
      if (docPorts.has(port)) {
        cleanChecks++;
      } else {
        drifts.push({ type: 'doc_port_undocumented', source: 'ss -tlnp', target: 'BUSINESS_BUILDER.md', field: ':' + port, expected: 'documented', found: 'listening but not in docs' });
      }
    }

    for (const port of docPorts) {
      if (listeningPorts.includes(port)) {
        cleanChecks++;
      } else {
        drifts.push({ type: 'doc_port_not_listening', source: 'BUSINESS_BUILDER.md', target: 'ss -tlnp', field: ':' + port, expected: 'listening', found: 'not active' });
      }
    }
  }

  // 1D. Doc freshness
  const docsToCheck = [
    bbPath,
    startupPath,
    rolesPath,
    projectPath('data_dir') ? path.join(projectPath('data_dir'), 'SESSION_HANDOFF.md') : null
  ].filter(Boolean);

  const now = Date.now();
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  for (const docPath of docsToCheck) {
    try {
      const stat = fs.statSync(docPath);
      const age = now - stat.mtimeMs;
      const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
      const docName = path.basename(docPath);
      if (age > SEVEN_DAYS) {
        drifts.push({ type: 'doc_stale', source: docName, target: '', field: 'last_modified', expected: 'within 7 days', found: ageDays + ' days ago' });
      } else if (age > THREE_DAYS) {
        drifts.push({ type: 'doc_aging', source: docName, target: '', field: 'last_modified', expected: 'within 3 days', found: ageDays + ' days ago' });
      } else {
        cleanChecks++;
      }
    } catch (e) {
      drifts.push({ type: 'doc_missing', source: path.basename(docPath), target: '', field: 'exists', expected: 'true', found: 'false' });
    }
  }

  // 1E. Cron drift
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { timeout: 5000 }).toString();
    const lines = crontab.split('\n');
    const activeCrons = lines.filter(l => l.trim() && !l.startsWith('#'));
    const commentedCrons = lines.filter(l => l.startsWith('# STOPPED') || (l.startsWith('#') && l.includes('.js') && !l.startsWith('# =') && !l.startsWith('# Only') && !l.startsWith('# All') && !l.startsWith('# PALYAN')));

    // Check if BUSINESS_BUILDER mentions crons that are now stopped
    if (bbContent) {
      // Look for worker references in the doc that mention "Cron" schedules
      const cronRefs = bbContent.matchAll(/\|\s*([^\|]+\.(?:js|py))\s*\|[^\|]*\|\s*(?:Cron[^\|]*)\|/gi);
      for (const m of cronRefs) {
        const workerFile = m[1].trim();
        const basename = workerFile.split('/').pop();
        // Check if this cron is commented out
        const isStopped = commentedCrons.some(c => c.includes(basename));
        if (isStopped) {
          drifts.push({ type: 'doc_cron_stopped', source: 'BUSINESS_BUILDER.md', target: 'crontab', field: basename, expected: 'active (per doc)', found: 'STOPPED in crontab' });
        } else {
          cleanChecks++;
        }
      }
    }

    // Check for active crons not mentioned in docs
    for (const cron of activeCrons) {
      const scriptMatch = cron.match(/([^\s/]+\.(?:js|py))/);
      if (!scriptMatch) continue;
      const scriptName = scriptMatch[1];
      if (bbContent && bbContent.includes(scriptName)) {
        cleanChecks++;
      } else {
        drifts.push({ type: 'doc_cron_undocumented', source: 'crontab', target: 'BUSINESS_BUILDER.md', field: scriptName, expected: 'documented', found: 'active cron not in docs' });
      }
    }
  } catch (e) {}

  return { drifts, cleanChecks };
}

// ============================================================
// MEMBER PROPAGATION AUDIT
// Checks that every member in family-roles.json exists in all
// downstream locations. Catches the Corona/Soriano problem.
// ============================================================

function auditMembers() {
  const drifts = [];
  let cleanChecks = 0;
  const rolesFile = projectPath('roles_file');
  if (!rolesFile) return { drifts: [], cleanChecks: 0, skipped: 'roles_file not configured' };
  const roles = safeReadJSON(rolesFile);
  if (!roles || !roles.members) {
    drifts.push({ type: 'members_missing_source', source: rolesFile, target: '', field: '', expected: 'valid JSON with members array', found: 'missing or invalid' });
    return { drifts, cleanChecks };
  }

  const sourceIds = roles.members.map(function(m) { return m.id; });
  const sourceCount = roles.members.length;

  // Helper: check a downstream location for missing member IDs
  function checkDownstream(name, ids, filePath) {
    if (ids.length !== sourceCount) {
      drifts.push({ type: 'member_count_mismatch', source: 'family-roles.json', target: name, field: 'count', expected: String(sourceCount), found: String(ids.length) });
    }
    for (var i = 0; i < sourceIds.length; i++) {
      var sid = sourceIds[i];
      if (ids.indexOf(sid) === -1) {
        drifts.push({ type: 'member_missing', source: 'family-roles.json', target: name, field: sid, expected: 'present', found: 'missing' });
      }
    }
    // Check for extra IDs not in source
    for (var j = 0; j < ids.length; j++) {
      if (sourceIds.indexOf(ids[j]) === -1) {
        drifts.push({ type: 'member_extra', source: 'family-roles.json', target: name, field: ids[j], expected: 'not present', found: 'extra member in downstream' });
      }
    }
    if (!drifts.some(function(d) { return d.target === name; })) cleanChecks++;
  }

  // 1. family-status.json (cache)
  var statusFile = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'family-status.json') : null;
  if (statusFile) {
    var status = safeReadJSON(statusFile);
    if (status && Array.isArray(status)) {
      var statusIds = status.filter(function(m) { return m.id !== 'papa'; }).map(function(m) { return m.id; });
      checkDownstream('family-status.json', statusIds, statusFile);
    } else if (status && status.members) {
      var statusIds2 = status.members.map(function(m) { return m.id; });
      checkDownstream('family-status.json', statusIds2, statusFile);
    }
  }

  // 2. system-config.json family array
  var configFile = projectPath('config_file');
  if (configFile) {
    var config = safeReadJSON(configFile);
    if (config && config.family) {
      // system-config includes Arthur/papa as first entry
      var configNames = config.family.filter(function(m) { return m.name !== 'Arthur'; }).map(function(m) { return m.name; });
      var sourceNames = roles.members.map(function(m) { return m.name; });
      for (var k = 0; k < sourceNames.length; k++) {
        if (configNames.indexOf(sourceNames[k]) === -1) {
          drifts.push({ type: 'member_missing', source: 'family-roles.json', target: 'system-config.json', field: sourceNames[k], expected: 'present', found: 'missing' });
        }
      }
      if (!drifts.some(function(d) { return d.target === 'system-config.json' && d.type === 'member_missing'; })) cleanChecks++;
    }
  }

  // 3. family-home/index.html PROFILES and MS objects
  var htmlDir = projectPath('html_dir');
  if (htmlDir) {
    var indexContent = safeReadFile(path.join(htmlDir, 'index.html'));
    if (indexContent) {
      // Check PROFILES object - extract top-level keys (lines like "  name:  {")
      var profileIds = [];
      var profileStart = indexContent.indexOf('PROFILES = {');
      if (profileStart === -1) profileStart = indexContent.indexOf('PROFILES={');
      if (profileStart !== -1) {
        var profileBlock = indexContent.substring(profileStart, indexContent.indexOf('};', profileStart) + 2);
        var profileLines = profileBlock.split('\n');
        for (var pl = 0; pl < profileLines.length; pl++) {
          var pmatch = profileLines[pl].match(/^\s+(\w+)\s*:/);
          if (pmatch && pmatch[1] !== 'papa') profileIds.push(pmatch[1]);
        }
      }
      checkDownstream('index.html PROFILES', profileIds, path.join(htmlDir, 'index.html'));

      // Check MS colors object - same line-based approach
      var msIds = [];
      var msStart = indexContent.indexOf('const MS = {');
      if (msStart === -1) msStart = indexContent.indexOf('const MS={');
      if (msStart !== -1) {
        var msBlock = indexContent.substring(msStart, indexContent.indexOf('};', msStart) + 2);
        var msLines = msBlock.split('\n');
        for (var ml = 0; ml < msLines.length; ml++) {
          var mmatch = msLines[ml].match(/^\s+(\w+)\s*:/);
          if (mmatch && mmatch[1] !== 'papa') msIds.push(mmatch[1]);
        }
      }
      checkDownstream('index.html MS colors', msIds, path.join(htmlDir, 'index.html'));
    }

    // 4. meet.html - check member count in text
    var meetContent = safeReadFile(path.join(htmlDir, 'meet.html'));
    if (meetContent) {
      var meetCountMatches = meetContent.match(/(\d+)\s*AI\s*family\s*members/gi) || [];
      for (var mc = 0; mc < meetCountMatches.length; mc++) {
        var num = parseInt(meetCountMatches[mc]);
        // Total includes papa (+1)
        if (num > 0 && num !== sourceCount + 1 && num !== sourceCount) {
          drifts.push({ type: 'member_count_mismatch', source: 'family-roles.json', target: 'meet.html', field: 'member_count_text', expected: String(sourceCount + 1), found: String(num) });
        }
      }
      if (!drifts.some(function(d) { return d.target === 'meet.html'; })) cleanChecks++;
    }
  }

  // 5. family-home/server.js COLORS map, soulPaths, publicPersonas
  var serverFile = htmlDir ? path.join(htmlDir, 'server.js') : null;
  if (serverFile) {
    var serverContent = safeReadFile(serverFile);
    if (serverContent) {
      // COLORS map
      var colorsMatch = serverContent.match(/COLORS\s*=\s*\{([^}]+)\}/);
      if (colorsMatch) {
        var colorKeys = colorsMatch[1].match(/(\w+)\s*:/g) || [];
        var colorIds = colorKeys.map(function(k) { return k.replace(/\s*:/, '').trim(); }).filter(function(k) { return k !== 'papa'; });
        checkDownstream('server.js COLORS', colorIds, serverFile);
      }

      // soulPaths map
      var soulMatch = serverContent.match(/soulPaths\s*=\s*\{([^}]+)\}/);
      if (soulMatch) {
        var soulKeys = soulMatch[1].match(/(\w+)\s*:/g) || [];
        var soulIds = soulKeys.map(function(k) { return k.replace(/\s*:/, '').trim(); });
        checkDownstream('server.js soulPaths', soulIds, serverFile);
      }

      // publicPersonas object - multi-line, find keys
      var personaIds = [];
      var personaMatches = serverContent.match(/publicPersonas\s*=\s*\{/);
      if (personaMatches) {
        // Extract from publicPersonas to its closing - look for member keys
        var personaStart = serverContent.indexOf('publicPersonas = {');
        if (personaStart !== -1) {
          var personaBlock = serverContent.substring(personaStart, personaStart + 5000);
          var pKeyMatches = personaBlock.match(/^\s+(\w+)\s*:\s*`/gm) || [];
          personaIds = pKeyMatches.map(function(k) { return k.trim().replace(/\s*:\s*`$/, ''); });
        }
      }
      if (personaIds.length > 0) {
        checkDownstream('server.js publicPersonas', personaIds, serverFile);
      }
    }
  }

  // 6. tamara-v6.js writeFamilyStatus array (UNTOUCHABLE - flag only)
  var tamaraFile = projectPath('project_root') ? path.join(projectPath('project_root') || process.cwd(), 'tamara-v6.js') : null;
  if (tamaraFile) {
    var tamaraContent = safeReadFile(tamaraFile);
    if (tamaraContent) {
      var wfsMatch = tamaraContent.match(/writeFamilyStatus/);
      if (wfsMatch) {
        // Check if each member ID appears in the file
        for (var ti = 0; ti < sourceIds.length; ti++) {
          if (tamaraContent.indexOf("'" + sourceIds[ti] + "'") === -1 && tamaraContent.indexOf('"' + sourceIds[ti] + '"') === -1) {
            drifts.push({ type: 'member_missing_untouchable', source: 'family-roles.json', target: 'tamara-v6.js (UNTOUCHABLE)', field: sourceIds[ti], expected: 'present in writeFamilyStatus', found: 'missing - FLAG ONLY, do not edit' });
          }
        }
        if (!drifts.some(function(d) { return d.target === 'tamara-v6.js (UNTOUCHABLE)'; })) cleanChecks++;
      }
    }
  }

  // 7. bots-app/public/index.html - agent count in footer/text
  var botsAppIndex = projectPath('project_root') ? path.join(projectPath('project_root') || process.cwd(), 'bots-app', 'public', 'index.html') : null;
  if (botsAppIndex) {
    var botsContent = safeReadFile(botsAppIndex);
    if (botsContent) {
      var botsCountMatches = botsContent.match(/(\d+)\s*agents/gi) || [];
      for (var bc = 0; bc < botsCountMatches.length; bc++) {
        var bNum = parseInt(botsCountMatches[bc]);
        if (bNum > 0 && bNum !== sourceCount + 1 && bNum !== sourceCount) {
          drifts.push({ type: 'member_count_mismatch', source: 'family-roles.json', target: 'bots-app/index.html', field: 'agent_count', expected: String(sourceCount + 1), found: String(bNum) });
        }
      }
      if (!drifts.some(function(d) { return d.target === 'bots-app/index.html'; })) cleanChecks++;
    }
  }

  return { drifts, cleanChecks };
}

// ============================================================
// MEMBER PROPAGATION ENGINE
// Auto-fixes downstream files when family-roles.json changes.
// ============================================================

function runMemberPropagation(dryRun) {
  var timestamp = new Date().toISOString();
  var actions = [];
  var flags = [];

  var rolesFile = projectPath('roles_file');
  if (!rolesFile) return { timestamp: timestamp, status: 'skipped', reason: 'roles_file not configured' };
  var roles = safeReadJSON(rolesFile);
  if (!roles || !roles.members) return { timestamp: timestamp, status: 'error', reason: 'family-roles.json missing or invalid' };

  var sourceIds = roles.members.map(function(m) { return m.id; });
  var sourceCount = roles.members.length;

  // 1. family-status.json - just delete it, Tamara regenerates
  var statusFile = projectPath('data_dir') ? path.join(projectPath('data_dir'), 'family-status.json') : null;
  if (statusFile && fs.existsSync(statusFile)) {
    var status = safeReadJSON(statusFile);
    if (status) {
      var statusArr = Array.isArray(status) ? status : (status.members || []);
      var statusIds = statusArr.filter(function(m) { return m.id !== 'papa'; }).map(function(m) { return m.id; });
      var missing = sourceIds.filter(function(id) { return statusIds.indexOf(id) === -1; });
      if (missing.length > 0) {
        if (!dryRun) {
          try { fs.unlinkSync(statusFile); } catch (e) {}
        }
        actions.push({ file: 'family-status.json', action: dryRun ? 'would_delete' : 'deleted', reason: 'Missing members: ' + missing.join(', ') + '. Tamara will regenerate.' });
      }
    }
  }

  // 2. system-config.json - add missing members
  var configFile = projectPath('config_file');
  if (configFile) {
    var config = safeReadJSON(configFile);
    if (config && config.family) {
      var configNames = config.family.map(function(m) { return m.name; });
      var missingMembers = roles.members.filter(function(m) { return configNames.indexOf(m.name) === -1; });
      if (missingMembers.length > 0) {
        if (!dryRun) {
          for (var i = 0; i < missingMembers.length; i++) {
            var mm = missingMembers[i];
            config.family.push({
              name: mm.name,
              role: mm.role,
              procs: mm.procs || [],
              desc: mm.desc || ''
            });
          }
          try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2)); } catch (e) {}
        }
        actions.push({ file: 'system-config.json', action: dryRun ? 'would_add' : 'added', members: missingMembers.map(function(m) { return m.name; }) });
      }
    }
  }

  // 3. HTML page counts - update agent/member count text
  var htmlDir = projectPath('html_dir');
  if (htmlDir) {
    var htmlFiles = [];
    try { htmlFiles = fs.readdirSync(htmlDir).filter(function(f) { return f.endsWith('.html'); }); } catch (e) {}
    var totalWithPapa = sourceCount + 1; // family-roles + papa
    for (var hi = 0; hi < htmlFiles.length; hi++) {
      var htmlPath = path.join(htmlDir, htmlFiles[hi]);
      var content = safeReadFile(htmlPath);
      if (!content) continue;
      var changed = false;
      // Replace stale agent/member counts
      var updated = content.replace(/(\d+)\s*(AI\s+)?(?:family\s+)?(?:members|agents)/gi, function(match, num) {
        var n = parseInt(num);
        if (n > 0 && n !== totalWithPapa && n !== sourceCount && n < 50) {
          changed = true;
          return match.replace(num, String(totalWithPapa));
        }
        return match;
      });
      if (changed) {
        if (!dryRun) {
          try { fs.writeFileSync(htmlPath, updated); } catch (e) {}
        }
        actions.push({ file: htmlFiles[hi], action: dryRun ? 'would_update_count' : 'updated_count', new_count: totalWithPapa });
      }
    }

    // Also check bots-app
    var botsIndex = projectPath('project_root') ? path.join(projectPath('project_root') || process.cwd(), 'bots-app', 'public', 'index.html') : null;
    if (botsIndex && fs.existsSync(botsIndex)) {
      var botsContent = safeReadFile(botsIndex);
      if (botsContent) {
        var botsChanged = false;
        var botsUpdated = botsContent.replace(/(\d+)\s*agents/gi, function(match, num) {
          var n = parseInt(num);
          if (n > 0 && n !== totalWithPapa && n !== sourceCount && n < 50) {
            botsChanged = true;
            return match.replace(num, String(totalWithPapa));
          }
          return match;
        });
        if (botsChanged) {
          if (!dryRun) {
            try { fs.writeFileSync(botsIndex, botsUpdated); } catch (e) {}
          }
          actions.push({ file: 'bots-app/index.html', action: dryRun ? 'would_update_count' : 'updated_count', new_count: totalWithPapa });
        }
      }
    }
  }

  // 4. Flag UNTOUCHABLE files that need manual updates
  // tamara-v6.js
  var tamaraFile = projectPath('project_root') ? path.join(projectPath('project_root') || process.cwd(), 'tamara-v6.js') : null;
  if (tamaraFile) {
    var tamaraContent = safeReadFile(tamaraFile);
    if (tamaraContent) {
      var tamaraMissing = sourceIds.filter(function(id) {
        return tamaraContent.indexOf("'" + id + "'") === -1 && tamaraContent.indexOf('"' + id + '"') === -1;
      });
      if (tamaraMissing.length > 0) {
        flags.push({ file: 'tamara-v6.js', status: 'UNTOUCHABLE', missing_members: tamaraMissing, action_needed: 'Add member IDs to writeFamilyStatus array' });
      }
    }
  }

  // family-home/index.html PROFILES and MS (UNTOUCHABLE for auto-edit per task)
  if (htmlDir) {
    var indexContent = safeReadFile(path.join(htmlDir, 'index.html'));
    if (indexContent) {
      var profileIds2 = [];
      var pStart = indexContent.indexOf('PROFILES = {');
      if (pStart === -1) pStart = indexContent.indexOf('PROFILES={');
      if (pStart !== -1) {
        var pBlock = indexContent.substring(pStart, indexContent.indexOf('};', pStart) + 2);
        var pLines = pBlock.split('\n');
        for (var pli = 0; pli < pLines.length; pli++) {
          var pm = pLines[pli].match(/^\s+(\w+)\s*:/);
          if (pm && pm[1] !== 'papa') profileIds2.push(pm[1]);
        }
      }
      var profileMissing = sourceIds.filter(function(id) { return profileIds2.indexOf(id) === -1; });
      if (profileMissing.length > 0) {
        flags.push({ file: 'index.html PROFILES', status: 'NEEDS_UPDATE', missing_members: profileMissing, action_needed: 'Add PROFILES entries with avatar, role, desc, relation' });
      }

      var msIds2 = [];
      var mStart = indexContent.indexOf('const MS = {');
      if (mStart === -1) mStart = indexContent.indexOf('const MS={');
      if (mStart !== -1) {
        var mBlock = indexContent.substring(mStart, indexContent.indexOf('};', mStart) + 2);
        var mLines = mBlock.split('\n');
        for (var mli = 0; mli < mLines.length; mli++) {
          var mm2 = mLines[mli].match(/^\s+(\w+)\s*:/);
          if (mm2 && mm2[1] !== 'papa') msIds2.push(mm2[1]);
        }
      }
      var msMissing = sourceIds.filter(function(id) { return msIds2.indexOf(id) === -1; });
      if (msMissing.length > 0) {
        flags.push({ file: 'index.html MS colors', status: 'NEEDS_UPDATE', missing_members: msMissing, action_needed: 'Add color scheme entries' });
      }
    }
  }

  // server.js soulPaths, publicPersonas, COLORS
  var serverFile = htmlDir ? path.join(htmlDir, 'server.js') : null;
  if (serverFile) {
    var serverContent = safeReadFile(serverFile);
    if (serverContent) {
      var colorsMatch = serverContent.match(/COLORS\s*=\s*\{([^}]+)\}/);
      if (colorsMatch) {
        var colorKeys = colorsMatch[1].match(/(\w+)\s*:/g) || [];
        var colorIds = colorKeys.map(function(k) { return k.replace(/\s*:/, '').trim(); }).filter(function(k) { return k !== 'papa'; });
        var colorMissing = sourceIds.filter(function(id) { return colorIds.indexOf(id) === -1; });
        if (colorMissing.length > 0) {
          flags.push({ file: 'server.js COLORS', status: 'UNTOUCHABLE', missing_members: colorMissing, action_needed: 'Add color entries for missing members' });
        }
      }
      var soulMatch = serverContent.match(/soulPaths\s*=\s*\{([^}]+)\}/);
      if (soulMatch) {
        var soulKeys = soulMatch[1].match(/(\w+)\s*:/g) || [];
        var soulIds = soulKeys.map(function(k) { return k.replace(/\s*:/, '').trim(); });
        var soulMissing = sourceIds.filter(function(id) { return soulIds.indexOf(id) === -1; });
        if (soulMissing.length > 0) {
          flags.push({ file: 'server.js soulPaths', status: 'UNTOUCHABLE', missing_members: soulMissing, action_needed: 'Add SOUL.md path entries' });
        }
      }
      // publicPersonas
      var personaStart = serverContent.indexOf('publicPersonas = {');
      if (personaStart !== -1) {
        var personaBlock = serverContent.substring(personaStart, personaStart + 5000);
        var pKeyMatches = personaBlock.match(/^\s+(\w+)\s*:\s*`/gm) || [];
        var personaIds = pKeyMatches.map(function(k) { return k.trim().replace(/\s*:\s*`$/, ''); });
        var personaMissing = sourceIds.filter(function(id) { return personaIds.indexOf(id) === -1; });
        if (personaMissing.length > 0) {
          flags.push({ file: 'server.js publicPersonas', status: 'UNTOUCHABLE', missing_members: personaMissing, action_needed: 'Add public persona templates' });
        }
      }
    }
  }

  return {
    timestamp: timestamp,
    dry_run: dryRun,
    status: (actions.length === 0 && flags.length === 0) ? 'all_current' : 'propagation_needed',
    auto_fixed: actions,
    manual_flags: flags,
    source_member_count: sourceCount,
    source_ids: sourceIds
  };
}

function runDriftAudit(scope) {
  const timestamp = new Date().toISOString();
  const allDrifts = [];
  let totalClean = 0;
  const scopes = scope === 'full' ? ['roles', 'versions', 'files', 'processes', 'website', 'platforms', 'docs', 'bots', 'members', 'session_facts'] : [scope];

  for (const s of scopes) {
    let result;
    switch (s) {
      case 'roles': result = auditRoles(); break;
      case 'versions': result = auditVersions(); break;
      case 'files': result = auditFiles(); break;
      case 'processes': result = auditProcesses(); break;
      case 'website': result = auditWebsite(); break;
      case 'platforms': result = auditPlatforms(); break;
      case 'docs': result = auditDocs(); break;
      case 'bots': result = auditBotCompliance(); break;
      case 'members': result = auditMembers(); break;
      case 'session_facts': result = auditSessionFacts(); break;
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


  // Merge self-check findings into security audit
  try {
    const selfCheck = runSelfCheck();
    if (selfCheck.findings && selfCheck.findings.length > 0) {
      for (const f of selfCheck.findings) {
        vulnerabilities.push({ type: "self_check_" + f.type, severity: f.severity, detail: f.message, fix: f.fix });
      }
    }
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
// Infrastructure Script Runner (v1.10.0)
// ============================================================
function runInfraScript(scriptPath, args) {
  var timestamp = new Date().toISOString();
  try {
    if (!fs.existsSync(scriptPath)) {
      return { error: 'Script not found: ' + scriptPath, timestamp: timestamp };
    }
    var cmd = 'node ' + JSON.stringify(scriptPath);
    if (args && args.length > 0) {
      cmd += ' ' + args.map(function(a) { return JSON.stringify(a); }).join(' ');
    }
    var output = execSync(cmd, { timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    // Try to parse as JSON, otherwise return raw
    try {
      var parsed = JSON.parse(output);
      parsed._timestamp = timestamp;
      parsed._script = path.basename(scriptPath);
      return parsed;
    } catch (e) {
      return { output: output.trim(), timestamp: timestamp, script: path.basename(scriptPath) };
    }
  } catch (e) {
    var stderr = e.stderr ? e.stderr.toString().substring(0, 500) : '';
    var stdout = e.stdout ? e.stdout.toString().substring(0, 2000) : '';
    // If script produced stdout, treat it as valid output (e.g. BLOCKED results)
    if (stdout) {
      try {
        var parsed = JSON.parse(stdout);
        parsed._timestamp = timestamp;
        parsed._script = path.basename(scriptPath);
        parsed._exitCode = e.status || 1;
        return parsed;
      } catch (pe) {
        return { output: stdout.trim(), exitCode: e.status || 1, timestamp: timestamp, script: path.basename(scriptPath) };
      }
    }
    return { error: e.message, stderr: stderr, timestamp: timestamp, script: path.basename(scriptPath) };
  }
}

function runInfraShell(scriptPath, args) {
  var timestamp = new Date().toISOString();
  try {
    if (!fs.existsSync(scriptPath)) {
      return { error: 'Script not found: ' + scriptPath, timestamp: timestamp };
    }
    var cmd = 'bash ' + JSON.stringify(scriptPath);
    if (args && args.length > 0) {
      cmd += ' ' + args.map(function(a) { return JSON.stringify(a); }).join(' ');
    }
    var output = execSync(cmd, { timeout: 30000, encoding: 'utf8' });
    return { output: output.trim(), timestamp: timestamp, script: path.basename(scriptPath) };
  } catch (e) {
    var stderr = e.stderr ? e.stderr.toString().substring(0, 500) : '';
    var stdout = e.stdout ? e.stdout.toString().substring(0, 2000) : '';
    if (stdout) {
      return { output: stdout.trim(), exitCode: e.status || 1, timestamp: timestamp, script: path.basename(scriptPath) };
    }
    return { error: e.message, stderr: stderr, timestamp: timestamp, script: path.basename(scriptPath) };
  }
}

// ============================================================
// SESSION PERSIST - Save facts from chat to disk
// ============================================================

function handleSessionPersist(args) {
  var category = args.category;
  var title = args.title;
  var content = args.content;
  var source = args.source || 'chat';
  var tags = args.tags || [];

  if (!category || !title || !content) {
    return { error: 'Missing required fields: category, title, content' };
  }

  var today = new Date().toISOString().split('T')[0];
  var timestamp = new Date().toISOString();
  var sessionId = 'session-' + today + '-' + process.pid;

  var fact = {
    timestamp: timestamp,
    session_id: sessionId,
    category: category,
    title: title,
    content: content,
    source: source,
    tags: tags,
    processed: false
  };

  // Write to session-facts JSONL
  var factsDir = '/root/family-data/session-facts';
  var factsFile = path.join(factsDir, today + '.jsonl');
  try {
    if (!fs.existsSync(factsDir)) fs.mkdirSync(factsDir, { recursive: true });
    fs.appendFileSync(factsFile, JSON.stringify(fact) + '\n');
  } catch (e) {
    return { error: 'Failed to write fact: ' + e.message };
  }

  // Auto-process into business-builder files
  var autoActions = [];

  if (category === 'confirmation') {
    var confDir = '/root/family-data/confirmations';
    var confFile = path.join(confDir, today + '.md');
    try {
      if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });
      var entry = '\n## ' + title + '\n- ' + timestamp + '\n- ' + content + '\n- Source: ' + source + '\n';
      fs.appendFileSync(confFile, entry);
      autoActions.push('Appended to confirmations/' + today + '.md');
    } catch (e) {
      autoActions.push('FAILED confirmations write: ' + e.message);
    }
  }

  if (category === 'research') {
    var resDir = '/root/family-data/research';
    var slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var resFile = path.join(resDir, slug + '.md');
    try {
      if (!fs.existsSync(resDir)) fs.mkdirSync(resDir, { recursive: true });
      var resEntry = '# ' + title + '\n\nDate: ' + today + '\nSource: ' + source + '\nTags: ' + tags.join(', ') + '\n\n' + content + '\n';
      if (fs.existsSync(resFile)) {
        fs.appendFileSync(resFile, '\n---\n\n## Update ' + timestamp + '\n\n' + content + '\n');
        autoActions.push('Appended to research/' + slug + '.md');
      } else {
        fs.writeFileSync(resFile, resEntry);
        autoActions.push('Created research/' + slug + '.md');
      }
    } catch (e) {
      autoActions.push('FAILED research write: ' + e.message);
    }
  }

  if (category === 'credential') {
    try {
      var credsFile = '/root/family-data/api-credentials.json';
      var creds = {};
      if (fs.existsSync(credsFile)) creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      if (!creds._session_persist_notes) creds._session_persist_notes = [];
      creds._session_persist_notes.push({ date: today, title: title, note: 'Review: ' + content.substring(0, 200) });
      fs.writeFileSync(credsFile, JSON.stringify(creds, null, 2));
      autoActions.push('Added credential note to api-credentials.json (manual review needed)');
    } catch (e) {
      autoActions.push('FAILED credential note: ' + e.message);
    }
  }

  if (category === 'partner') {
    try {
      var partnerFile = '/root/family-data/partner-tracker.json';
      var partners = {};
      if (fs.existsSync(partnerFile)) partners = JSON.parse(fs.readFileSync(partnerFile, 'utf8'));
      if (!partners._session_persist_notes) partners._session_persist_notes = [];
      partners._session_persist_notes.push({ date: today, title: title, content: content.substring(0, 500), tags: tags });
      fs.writeFileSync(partnerFile, JSON.stringify(partners, null, 2));
      autoActions.push('Added partner note to partner-tracker.json');
    } catch (e) {
      autoActions.push('FAILED partner note: ' + e.message);
    }
  }

  if (category === 'deadline') {
    autoActions.push('DEADLINE flagged - must be added to SESSION_HANDOFF.md manually: ' + title + ' - ' + content);
  }

  // Audit trail
  addAuditEntry('SESSION_PERSIST', category + ': ' + title);

  return {
    status: 'persisted',
    file: factsFile,
    fact: fact,
    auto_actions: autoActions,
    message: 'Fact saved. ' + autoActions.length + ' auto-action(s) triggered.'
  };
}

// ============================================================
// AUDIT SESSION FACTS - Check for unprocessed facts
// ============================================================

function auditSessionFacts() {
  var factsDir = '/root/family-data/session-facts';
  var today = new Date().toISOString().split('T')[0];
  var drifts = [];
  var cleanChecks = 0;

  // Check today's facts
  var todayFile = path.join(factsDir, today + '.jsonl');
  var facts = [];
  try {
    if (fs.existsSync(todayFile)) {
      var lines = fs.readFileSync(todayFile, 'utf8').trim().split('\n').filter(Boolean);
      facts = lines.map(function(line) { try { return JSON.parse(line); } catch (e) { return null; } }).filter(Boolean);
    }
  } catch (e) {}

  if (facts.length === 0) {
    cleanChecks++;
    return { drifts: drifts, cleanChecks: cleanChecks };
  }

  // Check if facts are reflected in handoff
  var handoffContent = '';
  try { handoffContent = fs.readFileSync('/root/family-data/SESSION_HANDOFF.md', 'utf8'); } catch (e) {}

  var worklogContent = '';
  try { worklogContent = fs.readFileSync('/root/family-data/WORKLOG.md', 'utf8'); } catch (e) {}

  var unreflected = [];
  for (var i = 0; i < facts.length; i++) {
    var f = facts[i];
    var titleLower = f.title.toLowerCase();
    // Check if title or key words appear in handoff or worklog
    var inHandoff = handoffContent.toLowerCase().indexOf(titleLower) !== -1;
    var inWorklog = worklogContent.toLowerCase().indexOf(titleLower) !== -1;
    if (!inHandoff && !inWorklog) {
      unreflected.push(f);
    } else {
      cleanChecks++;
    }
  }

  if (unreflected.length > 0) {
    drifts.push({
      type: 'session_facts_unreflected',
      source: 'session-facts/' + today + '.jsonl',
      target: 'SESSION_HANDOFF.md / WORKLOG.md',
      field: unreflected.length + ' facts',
      expected: 'All facts reflected in handoff/worklog',
      found: unreflected.map(function(f) { return f.category + ': ' + f.title; }).join('; ')
    });
  }

  // Check yesterday too
  var yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  var yesterdayFile = path.join(factsDir, yesterday + '.jsonl');
  try {
    if (fs.existsSync(yesterdayFile)) {
      var yLines = fs.readFileSync(yesterdayFile, 'utf8').trim().split('\n').filter(Boolean);
      var yFacts = yLines.map(function(line) { try { return JSON.parse(line); } catch (e) { return null; } }).filter(Boolean);
      var yUnreflected = yFacts.filter(function(f) {
        var tl = f.title.toLowerCase();
        return handoffContent.toLowerCase().indexOf(tl) === -1 && worklogContent.toLowerCase().indexOf(tl) === -1;
      });
      if (yUnreflected.length > 0) {
        drifts.push({
          type: 'session_facts_orphaned_yesterday',
          source: 'session-facts/' + yesterday + '.jsonl',
          target: 'SESSION_HANDOFF.md / WORKLOG.md',
          field: yUnreflected.length + ' facts from yesterday',
          expected: 'All facts reflected',
          found: yUnreflected.map(function(f) { return f.category + ': ' + f.title; }).join('; ')
        });
      } else {
        cleanChecks++;
      }
    }
  } catch (e) {}

  return { drifts: drifts, cleanChecks: cleanChecks };
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
      return dispatchToLLM(args.task, args.max_turns, args.permissions);
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

    case 'propagate_family_member': {
      return runMemberPropagation(args.dry_run || false);
    }

    case 'session_close': {
      // Cross-reference session facts BEFORE closing
      const sessionFactsResult = auditSessionFacts();
      const driftResult = runDriftAudit('full');
      const propagateResult = runAutoPropagators();
      const memberPropResult = runMemberPropagation(false);

      // Platform parity warnings
      let platformWarnings = [];
      try {
        const platformRegistry = JSON.parse(fs.readFileSync('/root/family-data/platform-features.json', 'utf8'));
        for (const [memberName, member] of Object.entries(platformRegistry.members)) {
          const platformKeys = Object.keys(member.platforms);
          if (platformKeys.length < 2) continue;
          // Collect all features across platforms for this member
          const allFeatures = new Set();
          for (const pKey of platformKeys) {
            for (const f of member.platforms[pKey].features) {
              allFeatures.add(f);
            }
          }
          // Check each platform for missing features
          for (const pKey of platformKeys) {
            const platformFeatures = new Set(member.platforms[pKey].features);
            const missing = [];
            for (const f of allFeatures) {
              if (!platformFeatures.has(f)) {
                missing.push(f);
              }
            }
            if (missing.length > 0) {
              platformWarnings.push({
                member: memberName,
                platform: pKey,
                missing_features: missing,
                note: 'Features available on other platforms but not this one'
              });
            }
          }
        }
      } catch (e) {
        // platform-features.json not available, skip warnings
      }

      // Check for platform-specific drifts
      const platformDrifts = driftResult.drifts.filter(function(d) { return d.type && d.type.startsWith('platform_'); });

      // Extract doc-specific drifts for blockers
      const docDrifts = driftResult.drifts.filter(function(d) { return d.type && d.type.startsWith('doc_'); });
      const docDriftWarnings = [];
      if (docDrifts.length > 0) {
        const stale = docDrifts.filter(function(d) { return d.type === 'doc_stale' || d.type === 'doc_aging'; });
        const undocumented = docDrifts.filter(function(d) { return d.type === 'doc_process_undocumented'; });
        const missingFromPm2 = docDrifts.filter(function(d) { return d.type === 'doc_process_missing_from_pm2'; });
        const missingMembers = docDrifts.filter(function(d) { return d.type === 'doc_dept_no_member'; });
        const stoppedCrons = docDrifts.filter(function(d) { return d.type === 'doc_cron_stopped'; });
        if (stale.length > 0) docDriftWarnings.push('Stale docs: ' + stale.map(function(d) { return d.source + ' (' + d.found + ')'; }).join(', '));
        if (undocumented.length > 0) docDriftWarnings.push('Undocumented processes: ' + undocumented.map(function(d) { return d.field; }).join(', '));
        if (missingFromPm2.length > 0) docDriftWarnings.push('Docs reference missing processes: ' + missingFromPm2.map(function(d) { return d.field; }).join(', '));
        if (missingMembers.length > 0) docDriftWarnings.push('Dept folders without family-roles.json entry: ' + missingMembers.map(function(d) { return d.field; }).join(', '));
        if (stoppedCrons.length > 0) docDriftWarnings.push('Docs describe active crons that are STOPPED: ' + stoppedCrons.map(function(d) { return d.field; }).join(', '));
      }

      const result = {
        timestamp: new Date().toISOString(),
        drift_audit: driftResult,
        propagation: propagateResult,
        member_propagation: memberPropResult,
        summary: driftResult.drift_count === 0 ? 'Session clean - no drifts, propagators run' : `${driftResult.drift_count} drifts found - review before closing`
      };

      // Member propagation blocker
      if (memberPropResult.manual_flags && memberPropResult.manual_flags.length > 0) {
        result.member_propagation_blocker = 'MEMBER DRIFT - ' + memberPropResult.manual_flags.length + ' files need manual member updates';
      }

      if (docDriftWarnings.length > 0) {
        result.doc_drift_warnings = docDriftWarnings;
        result.doc_drift_blocker = 'DOCS STALE - update before closing session';
      }

      if (platformWarnings.length > 0) {
        result.platform_warnings = platformWarnings;
      }
      if (platformDrifts.length > 0) {
        result.platform_drift_count = platformDrifts.length;
      }

      // Session facts cross-reference blocker
      if (sessionFactsResult.drifts.length > 0) {
        result.session_facts_blocker = 'SESSION FACTS NOT REFLECTED - ' + sessionFactsResult.drifts.length + ' gap(s) found';
        result.session_facts_gaps = sessionFactsResult.drifts.map(function(d) { return d.found; });
      } else {
        result.session_facts_status = 'All session facts reflected in handoff/worklog';
      }

      return result;
    }

    case 'page_health': {
      return runPageHealth(args.page || 'all');
    }

    case 'pre_publish_audit': {
      return runPrePublishAudit(args.source_file);
    }


    case 'self_check': {
      return runSelfCheck();
    }
    case 'mcp_analyzer': {
      return runMCPAnalyzer(args.mode, args.output_path);
    }

    case 'bot_compliance_check': {
      return runBotComplianceCheck(args.bot);
    }

    case 'usage_report': {
      return runUsageReport(args.days);
    }

    // v1.10.0 Infrastructure Tools
    case 'check_dependencies': {
      return runInfraScript('/root/family-workers/dependency-mapper.js', []);
    }

    case 'create_snapshot': {
      return runInfraScript('/root/family-workers/snapshot-manager.js', []);
    }

    case 'check_session_diff': {
      return runInfraScript('/root/family-workers/session-diff.js', []);
    }

    case 'fix_doc_drift': {
      var dryRunFlag = (args.dry_run !== false) ? '--dry-run' : '';
      return runInfraScript('/root/family-workers/doc-drift-fixer.js', dryRunFlag ? [dryRunFlag] : []);
    }

    case 'get_health_status': {
      return runInfraScript('/root/family-workers/health-dashboard.js', []);
    }

    case 'test_deployment': {
      return runInfraScript('/root/family-workers/staging-deploy.js', [args.filepath]);
    }

    case 'check_page_changes': {
      var pageArgs = [];
      if (args.page) pageArgs.push('--page', args.page);
      if (args.since) pageArgs.push('--since', args.since);
      return runInfraScript('/root/family-workers/page-changelog.js', pageArgs);
    }

    case 'check_archive_safety': {
      return runInfraShell('/root/preflight-archive.sh', [args.filepath]);
    }

    case 'accountability_check': {
      return runAccountabilityCheck(args.scope, args.path);
    }

    case 'session_persist': {
      return handleSessionPersist(args);
    }

    case 'discovery_briefing': {
      return runDiscoveryBriefingTool(args.scope, args.context);
    }

    default:
      return { error: 'Unknown tool' };
  }
}

// ============================================================
// ACCOUNTABILITY CHECK - Detect LLM fabrication patterns
// ============================================================

function runAccountabilityCheck(scope, projectRoot) {
  scope = scope || 'full';
  projectRoot = projectRoot || '/root';

  var findings = [];
  var fabrications = 0;

  // CHECK 1: Placeholder credentials next to real ones in backups
  if (scope === 'full' || scope === 'credentials') {
    var placeholderPatterns = [
      'YOUR_', 'CHANGEME', 'TODO:', 'REPLACE_', 'xxx', 'placeholder',
      'YOUR_WIX_SITE_ID', 'YOUR_WIX_ACCOUNT_ID', 'YOUR_WIX_API_KEY',
      'YOUR_API_KEY', 'sk-xxx', 'token_here'
    ];

    try {
      var configs = execSync(
        'find ' + projectRoot + ' -maxdepth 4 -name "*.json" -o -name "*.env" -o -name "*.config.js" 2>/dev/null | grep -v node_modules | grep -v .pm2',
        { encoding: 'utf8', timeout: 10000 }
      ).trim().split('\n').filter(Boolean);

      configs.forEach(function(configFile) {
        try {
          var content = fs.readFileSync(configFile, 'utf8');
          placeholderPatterns.forEach(function(pattern) {
            if (content.indexOf(pattern) > -1) {
              var basename = path.basename(configFile);
              try {
                var backups = execSync(
                  'find ' + projectRoot + '/911restore ' + projectRoot + '/archive -name "' + basename + '" 2>/dev/null',
                  { encoding: 'utf8', timeout: 5000 }
                ).trim().split('\n').filter(Boolean);

                backups.forEach(function(backup) {
                  var backupContent = fs.readFileSync(backup, 'utf8');
                  if (backupContent.indexOf(pattern) === -1) {
                    fabrications++;
                    findings.push({
                      type: 'PLACEHOLDER_WITH_REAL_BACKUP',
                      severity: 'HIGH',
                      file: configFile,
                      pattern: pattern,
                      backup: backup,
                      message: 'File has placeholder "' + pattern + '" but backup at ' + backup + ' has real values. Agent likely lost/overwrote credentials instead of restoring them.'
                    });
                  }
                });
              } catch(e) {}
            }
          });
        } catch(e) {}
      });
    } catch(e) {}
  }

  // CHECK 2: Recently created files that duplicate existing ones
  if (scope === 'full' || scope === 'duplicates') {
    try {
      var recent = execSync(
        'find ' + projectRoot + ' -maxdepth 3 -mmin -1440 -type f -name "*.html" -o -name "*.md" -o -name "*.js" 2>/dev/null | grep -v node_modules | grep -v .pm2 | grep -v 911restore',
        { encoding: 'utf8', timeout: 10000 }
      ).trim().split('\n').filter(Boolean);

      recent.forEach(function(newFile) {
        var basename = path.basename(newFile);
        try {
          var similar = execSync(
            'find ' + projectRoot + ' -name "' + basename + '" -not -path "' + newFile + '" -not -path "*/node_modules/*" -not -path "*/911restore/*" 2>/dev/null',
            { encoding: 'utf8', timeout: 5000 }
          ).trim().split('\n').filter(Boolean);

          if (similar.length > 0) {
            findings.push({
              type: 'POTENTIAL_DUPLICATE',
              severity: 'MEDIUM',
              file: newFile,
              duplicates: similar,
              message: 'Recently created file has same name as existing: ' + similar.join(', ') + '. Verify this is intentional and not an agent creating a workaround.'
            });
          }
        } catch(e) {}
      });
    } catch(e) {}
  }

  // CHECK 3: Workaround detection
  if (scope === 'full' || scope === 'workarounds') {
    var vpsBlog = projectRoot + '/family-home/blog/';
    if (fs.existsSync(vpsBlog)) {
      var blogFiles = fs.readdirSync(vpsBlog).filter(function(f) { return f.endsWith('.html') && f !== 'index.html'; });
      if (blogFiles.length > 0) {
        try {
          var publishedContent = JSON.parse(fs.readFileSync(projectRoot + '/family-data/published-content.json', 'utf8'));
          if (publishedContent.wix_blogs && publishedContent.wix_blogs.length > 0) {
            findings.push({
              type: 'DUPLICATE_PURPOSE',
              severity: 'LOW',
              file: vpsBlog,
              message: 'VPS blog has ' + blogFiles.length + ' articles but Wix blog at levelsofself.com already has ' + publishedContent.wix_blogs.length + ' posts. Verify VPS blog is intentional and not an agent-created workaround.'
            });
          }
        } catch(e) {}
      }
    }
  }

  return {
    status: fabrications > 0 ? 'FABRICATION_DETECTED' : 'clean',
    fabrications: fabrications,
    total_findings: findings.length,
    findings: findings,
    recommendation: fabrications > 0
      ? 'Agent fabricated ' + fabrications + ' replacement(s) instead of finding existing resources. Restore from backups and add the missing paths to the session handoff so future sessions know where things are.'
      : 'No fabrication patterns detected.'
  };
}

// ============================================================
// USAGE REPORT - Token usage per bot per day
// ============================================================

function runUsageReport(days) {
  try {
    var usage = JSON.parse(fs.readFileSync('/root/family-data/api-usage.json', 'utf8'));
    days = days || 3;
    var dates = Object.keys(usage.daily || {}).sort().slice(-days);
    var report = 'TOKEN USAGE REPORT\n==================\n\n';

    dates.forEach(function(date) {
      var day = usage.daily[date];
      var bots = day.byBot || {};
      var totalCalls = day.totalCalls || 0;
      var totalPrompt = 0;

      report += date + ' - ' + totalCalls + ' total calls\n';

      var botList = Object.keys(bots).map(function(name) {
        var b = bots[name];
        var prompt = b.promptTokensEst || 0;
        totalPrompt += prompt;
        var calls = b.calls || 0;
        var avg = calls > 0 ? Math.round(prompt / calls) : 0;
        var claude = (b.providers || {}).claude || (b.providers || {}).cli || 0;
        return { name: name, prompt: prompt, calls: calls, avg: avg, claude: claude };
      }).sort(function(a, b) { return b.prompt - a.prompt; });

      botList.forEach(function(b) {
        var flag = b.prompt > 1000000 ? ' *** HIGH ***' : (b.avg > 50000 ? ' * WARN *' : '');
        report += '  ' + b.name + ': ' + b.calls + ' calls, ' + Math.round(b.prompt/1000) + 'K prompt tokens, avg ' + Math.round(b.avg/1000) + 'K/call, Claude: ' + b.claude + flag + '\n';
      });

      report += '  TOTAL: ' + Math.round(totalPrompt/1000) + 'K prompt tokens\n\n';
    });

    // Alerts
    var today = new Date().toISOString().split('T')[0];
    var todayData = (usage.daily || {})[today] || {};
    var todayBots = todayData.byBot || {};
    var alerts = [];
    Object.keys(todayBots).forEach(function(name) {
      var b = todayBots[name];
      var prompt = b.promptTokensEst || 0;
      var calls = b.calls || 0;
      var avg = calls > 0 ? Math.round(prompt / calls) : 0;
      if (prompt > 5000000) alerts.push('CRITICAL: ' + name + ' at ' + Math.round(prompt/1000000) + 'M tokens today');
      else if (prompt > 1000000) alerts.push('WARNING: ' + name + ' at ' + Math.round(prompt/1000) + 'K tokens today');
      if (avg > 50000 && calls > 3) alerts.push('BLOAT: ' + name + ' averaging ' + Math.round(avg/1000) + 'K tokens/call - check knowledge file');
    });

    if (alerts.length > 0) {
      report += 'ALERTS:\n';
      alerts.forEach(function(a) { report += '  ' + a + '\n'; });
    } else {
      report += 'No alerts. All bots within normal range.\n';
    }

    return report;
  } catch(e) {
    return 'Error reading usage: ' + e.message;
  }
}

// ============================================================
// ============================================================
// SELF-CHECK - Catches issues before Arthur has to
// Added because Arthur manually caught: password leaks, rate limiter
// blocking own operations, info leakage in analyzer output,
// false positives in audits, and untested code shipping to npm.
// This function runs as part of security_audit and pre_publish_audit.
// ============================================================

function runSelfCheck() {
  const findings = [];

  // 1. CHECK: Are we rate-limiting ourselves?
  // The MCP middleware should bypass rate limits for localhost
  try {
    const middleware = fs.readFileSync(projectPath('project_root') ? path.join(projectPath('project_root'), 'mcp-api-middleware.js') : '/root/mcp-api-middleware.js', 'utf8');
    if (!middleware.includes('isLocal') && !middleware.includes('127.0.0.1')) {
      findings.push({
        type: 'self_rate_limiting',
        severity: 'high',
        message: 'MCP middleware has no localhost bypass. Internal operations (Tamara, smoke tests, bridge) will count against free tier quota.',
        fix: 'Add localhost detection at start of validateRequest: if IP is 127.0.0.1 or ::1, return { allowed: true, tier: "internal" }'
      });
    }
  } catch (e) {}

  // 2. CHECK: Does our source code contain secrets?
  try {
    const sourceFile = __filename;
    const source = fs.readFileSync(sourceFile, 'utf8');
    const lines = source.split('\n');
    
    // Known password patterns (not regex definitions, actual values)
    const dangerPatterns = [
      // Password detection uses generic patterns only - no actual passwords in source
      { name: 'stripe_live_key', pat: /sk_live_[a-zA-Z0-9]{20,}/ },
      { name: 'npm_token', pat: /npm_[A-Za-z0-9]{20,}/ },
      { name: 'bot_token_value', pat: /\d{10}:AA[A-Za-z0-9_-]{30,}/ },
    ];

    lines.forEach(function(line, idx) {
      if (line.trim().startsWith('//')) return;
      // Skip regex pattern definitions (lines that define detection patterns)
      if (line.includes('pat:') || line.includes('pattern') || line.includes('Patterns')) return;
      for (var dp of dangerPatterns) {
        if (dp.pat.test(line)) {
          findings.push({
            type: 'secret_in_source',
            severity: 'critical',
            message: dp.name + ' found in own source code at line ' + (idx + 1),
            fix: 'Remove the secret immediately and publish a new version'
          });
        }
      }
    });
  } catch (e) {}


  // 4. CHECK: Are there hardcoded /root/ paths in code that ships to clients?
  try {
    var source = fs.readFileSync(__filename, 'utf8');
    var lines = source.split('\n');
    var hardcodedCount = 0;
    lines.forEach(function(line, idx) {
      if (line.trim().startsWith('//')) return;
      if (line.includes('description:') || line.includes('tagline:') || line.includes('context:')) return;
      if ((line.includes("'/root/") || line.includes('"/root/')) && !line.includes('projectPath') && !line.includes('PROJECT')) {
        hardcodedCount++;
      }
    });
    if (hardcodedCount > 5) {
      findings.push({
        type: 'non_portable_paths',
        severity: 'high',
        message: hardcodedCount + ' hardcoded /root/ paths found. These break on client machines.',
        fix: 'Replace with projectPath() lookups from nervous-system.config.json'
      });
    }
  } catch (e) {}

  // 5. CHECK: Does the smoke test exist and is it up to date?
  try {
    var smokeTestPath = path.join(path.dirname(__filename), 'smoke-test.js');
    if (!fs.existsSync(smokeTestPath)) {
      // Try alternate locations
      smokeTestPath = projectPath('project_root') ? path.join(projectPath('project_root'), 'ns-smoke-test.js') : null;
    }
    if (!smokeTestPath || !fs.existsSync(smokeTestPath)) {
      findings.push({
        type: 'missing_regression_test',
        severity: 'medium',
        message: 'No smoke test found. Tool regressions will not be caught before they reach users.',
        fix: 'Create ns-smoke-test.js that calls every tool and verifies responses'
      });
    }
  } catch (e) {}

  // 6. CHECK: Is the version in source synced with package.json?
  try {
    var pkgPath = projectPath('package_json') || path.join(path.dirname(__filename), 'package.json');
    if (fs.existsSync(pkgPath)) {
      var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      var source = fs.readFileSync(__filename, 'utf8');
      var siMatch = source.match(/SERVER_INFO\s*=\s*\{[^}]*version:\s*'([^']+)'/);
      if (siMatch && siMatch[1] !== pkg.version) {
        findings.push({
          type: 'version_desync',
          severity: 'medium',
          message: 'Source says v' + siMatch[1] + ' but package.json says v' + pkg.version,
          fix: 'Sync version constants before publishing'
        });
      }
    }
  } catch (e) {}

  return {
    status: findings.length === 0 ? 'clean' : findings.some(function(f) { return f.severity === 'critical'; }) ? 'CRITICAL' : 'issues_found',
    finding_count: findings.length,
    critical: findings.filter(function(f) { return f.severity === 'critical'; }).length,
    findings: findings
  };
}

// BOT COMPLIANCE CHECK - Verifies 6 mandatory universal standards
// ============================================================

function runBotComplianceCheck(botPath) {
  const BOT_FILES = [
    '/root/family-workers/lily-telegram-enhanced.js',
    '/root/dept-aram/aram-telegram.js',
    '/root/dept-harout/harout-telegram.js',
    '/root/dept-corona/corona-telegram.js',
    '/root/dept-soriano/soriano-telegram.js',
    '/root/family-workers/lily-instagram.js',
    '/root/family-workers/aram-instagram.js',
    '/root/family-workers/harout-instagram.js',
    '/root/family-workers/lily-facebook.js'
  ];

  const filesToCheck = botPath ? [botPath] : BOT_FILES;
  const results = [];
  let totalPass = 0;
  let totalFail = 0;

  for (const filepath of filesToCheck) {
    let code = '';
    try {
      code = fs.readFileSync(filepath, 'utf8');
    } catch (e) {
      results.push({ file: filepath, error: 'File not found: ' + e.message, standards: {} });
      continue;
    }

    const isInstagram = filepath.includes('instagram');
    const isFacebook = filepath.includes('facebook');
    const isTelegram = !isInstagram && !isFacebook;
    const checks = {};

    // Standard 1: Thinking message with 3-sec delay (setTimeout 3000)
    const hasThinkingDelay = code.includes('setTimeout') && (code.includes('3000') || code.includes('_thinkTimer') || code.includes('_thinkPhrases'));
    checks['1_thinking_message'] = { pass: hasThinkingDelay, detail: hasThinkingDelay ? 'Found setTimeout with thinking phrases' : 'Missing 3-second thinking delay pattern' };

    // Standard 2: Persistent typing indicator (setInterval 4000)
    if (isTelegram || isFacebook) {
      const hasTypingInterval = code.includes('setInterval') && (code.includes('4000') || code.includes('_typingInterval') || code.includes('typing'));
      checks['2_typing_indicator'] = { pass: hasTypingInterval, detail: hasTypingInterval ? 'Found typing interval' : 'Missing persistent typing indicator (setInterval 4000)' };
    } else {
      checks['2_typing_indicator'] = { pass: true, detail: 'N/A for Instagram (no typing indicator API)' };
    }

    // Standard 3: Owner self-identification
    const hasVerifiedOwners = code.includes('_verifiedOwners');
    checks['3_owner_verification'] = { pass: hasVerifiedOwners, detail: hasVerifiedOwners ? 'Found _verifiedOwners object' : 'Missing _verifiedOwners self-identification' };

    // Standard 4: Acceptance philosophy in prompt
    const hasAcceptance = code.includes('ACCEPTANCE PHILOSOPHY') || code.includes('Accept EVERYONE');
    checks['4_acceptance_philosophy'] = { pass: hasAcceptance, detail: hasAcceptance ? 'Found acceptance philosophy in prompt' : 'Missing acceptance philosophy in system prompt' };

    // Standard 5: Read receipts
    let hasReadReceipt = false;
    if (isTelegram) {
      hasReadReceipt = code.includes('sendChatAction') && code.includes('typing');
    } else if (isFacebook) {
      hasReadReceipt = code.includes('mark_seen') || code.includes('sendMarkSeen');
    } else {
      // Instagram - responding promptly is the read receipt
      hasReadReceipt = true;
    }
    checks['5_read_receipt'] = { pass: hasReadReceipt, detail: hasReadReceipt ? 'Read receipt implemented' : 'Missing read receipt on message receive' };

    // Standard 6: Session summary extraction
    const hasSummary = code.includes('extractUserSummary') || code.includes('_userSummaries');
    checks['6_session_summary'] = { pass: hasSummary, detail: hasSummary ? 'Found session summary extraction' : 'Missing session summary (extractUserSummary)' };

    let passes = 0;
    let fails = 0;
    for (const key of Object.keys(checks)) {
      if (checks[key].pass) passes++;
      else fails++;
    }
    totalPass += passes;
    totalFail += fails;

    const name = path.basename(filepath);
    results.push({
      file: name,
      path: filepath,
      score: passes + '/' + (passes + fails),
      compliant: fails === 0,
      standards: checks
    });
  }

  return {
    timestamp: new Date().toISOString(),
    total_bots: filesToCheck.length,
    fully_compliant: results.filter(r => r.compliant).length,
    total_checks: totalPass + totalFail,
    total_pass: totalPass,
    total_fail: totalFail,
    results: results,
    summary: totalFail === 0 ? 'All bots fully compliant with 6 universal standards' : totalFail + ' standard violations found across ' + results.filter(r => !r.compliant).length + ' bots'
  };
}

// MCP ANALYZER - Analyzes project and generates tailored config
// ============================================================

function runMCPAnalyzer(mode, outputPath) {
  const result = {
    timestamp: new Date().toISOString(),
    mode: mode || 'analyze',
    recommended_tools: [],
    claude_md: null,
    config_suggestions: null
  };

  // Step 1: Detect project characteristics
  const projectRoot = PROJECT.project_root || process.cwd();
  const characteristics = {
    has_config: !!PROJECT._source && PROJECT._source !== 'defaults',
    has_protected_files: false,
    has_html_pages: false,
    has_pm2: PROJECT.pm2_managed || false,
    has_package_json: false,
    has_git: false,
    has_tests: false,
    has_docs: false,
    has_data_dir: !!PROJECT.data_dir,
    has_logs_dir: !!PROJECT.logs_dir,
    file_count: 0,
    js_files: 0,
    py_files: 0,
    html_files: 0,
    json_files: 0,
    md_files: 0,
    project_type: 'unknown',
    languages: [],
    frameworks: []
  };

  // Scan project root
  try {
    const scanDir = function(dir, depth) {
      if (depth > 3) return;
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (item.startsWith('.') || item === 'node_modules' || item === '__pycache__') continue;
          const fullPath = path.join(dir, item);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              if (item === 'test' || item === 'tests' || item === '__tests__') characteristics.has_tests = true;
              if (item === 'docs' || item === 'documentation') characteristics.has_docs = true;
              if (item === 'public' || item === 'static' || item === 'html') characteristics.has_html_pages = true;
              scanDir(fullPath, depth + 1);
            } else {
              characteristics.file_count++;
              if (item.endsWith('.js') || item.endsWith('.ts')) characteristics.js_files++;
              if (item.endsWith('.py')) characteristics.py_files++;
              if (item.endsWith('.html')) characteristics.html_files++;
              if (item.endsWith('.json')) characteristics.json_files++;
              if (item.endsWith('.md')) characteristics.md_files++;
              if (item === 'package.json') characteristics.has_package_json = true;
              if (item === '.gitignore' || item === '.git') characteristics.has_git = true;
              if (item === 'CLAUDE.md' || item === 'claude.md') characteristics.has_docs = true;
            }
          } catch (e) {}
        }
      } catch (e) {}
    };
    scanDir(projectRoot, 0);
  } catch (e) {}

  // Check for protected files list
  const protectedPath = projectPath('protected_files_list');
  if (protectedPath) {
    try {
      const content = fs.readFileSync(protectedPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      characteristics.has_protected_files = lines.length > 0;
      characteristics.protected_count = lines.length;
    } catch (e) {}
  }

  // Check for git
  try {
    if (fs.existsSync(path.join(projectRoot, '.git'))) characteristics.has_git = true;
  } catch (e) {}

  // Check for PM2
  if (!characteristics.has_pm2) {
    try {
      const { execSync } = require('child_process');
      execSync('pm2 jlist 2>/dev/null', { timeout: 5000 });
      characteristics.has_pm2 = true;
    } catch (e) {}
  }

  // Determine project type
  if (characteristics.js_files > 0) characteristics.languages.push('javascript');
  if (characteristics.py_files > 0) characteristics.languages.push('python');

  if (characteristics.has_pm2 && characteristics.js_files > 5) {
    characteristics.project_type = 'production_system';
  } else if (characteristics.has_html_pages && characteristics.js_files > 0) {
    characteristics.project_type = 'web_application';
  } else if (characteristics.has_package_json && characteristics.js_files > 0) {
    characteristics.project_type = 'node_project';
  } else if (characteristics.py_files > 0) {
    characteristics.project_type = 'python_project';
  } else if (characteristics.md_files > 2) {
    characteristics.project_type = 'documentation';
  } else {
    characteristics.project_type = 'general';
  }

  // Don't expose raw project internals - just use them for recommendations
  result.project_type = characteristics.project_type;
  result.has_config = characteristics.has_config;

  // Step 2: Recommend tools based on project type
  const recommendations = [];

  // Universal tools everyone needs
  recommendations.push({
    tool: 'get_framework',
    priority: 'essential',
    reason: 'Core behavioral rules. Read this first to understand how the NS works.'
  });
  recommendations.push({
    tool: 'preflight_check',
    priority: 'essential',
    reason: 'Protects critical files from accidental edits. Set up your protected files list.'
  });
  recommendations.push({
    tool: 'worklog',
    priority: 'essential',
    reason: 'Prevents silent failures. Write progress before every action.'
  });
  recommendations.push({
    tool: 'session_handoff',
    priority: 'essential',
    reason: 'Solves context loss between sessions. Update the handoff before ending work.'
  });

  // Conditional tools
  if (characteristics.has_protected_files || characteristics.file_count > 20) {
    recommendations.push({
      tool: 'guardrail_rules',
      priority: 'high',
      reason: 'Protected files detected. These rules enforce discipline around file edits.'
    });
  }

  if (characteristics.project_type === 'production_system') {
    recommendations.push({
      tool: 'drift_audit',
      priority: 'high',
      reason: 'Production system detected. Drift audit catches when configs, docs, and running processes go out of sync.'
    });
    recommendations.push({
      tool: 'security_audit',
      priority: 'high',
      reason: 'Production system detected. Security audit catches exposed secrets and misconfigurations.'
    });
    recommendations.push({
      tool: 'emergency_kill_switch',
      priority: 'medium',
      reason: 'Production system with PM2. Kill switch gives you emergency shutdown capability.'
    });
    recommendations.push({
      tool: 'dispatch_to_llm',
      priority: 'high',
      reason: 'Complex system. Dispatch heavy tasks to background agents instead of blocking your main session.'
    });
  }

  if (characteristics.has_pm2) {
    recommendations.push({
      tool: 'session_close',
      priority: 'high',
      reason: 'PM2 processes detected. Session close runs full audit + propagation before you end work.'
    });
  }

  if (characteristics.has_html_pages) {
    recommendations.push({
      tool: 'page_health',
      priority: 'medium',
      reason: 'HTML pages detected. Page health catches broken links, missing meta tags, and UX issues.'
    });
  }

  if (characteristics.has_package_json && characteristics.has_git) {
    recommendations.push({
      tool: 'pre_publish_audit',
      priority: 'high',
      reason: 'Publishable package detected. Pre-publish audit catches secrets and hardcoded paths before they ship.'
    });
  }

  recommendations.push({
    tool: 'step_back_check',
    priority: 'medium',
    reason: 'Forces reflection every few messages. Prevents tunnel vision on details.'
  });

  recommendations.push({
    tool: 'verify_audit_chain',
    priority: 'low',
    reason: 'Tamper-proof audit trail. Verifies no one has modified the activity log.'
  });

  // Context-aware: check for discovery config and recommend discovery_briefing
  var discoveryConfigPath = projectPath('data_dir')
    ? path.join(projectPath('data_dir'), 'discovery-config.json')
    : null;
  var hasDiscoveryConfig = false;
  try {
    if (discoveryConfigPath && fs.existsSync(discoveryConfigPath)) hasDiscoveryConfig = true;
  } catch (e) {}

  if (hasDiscoveryConfig) {
    recommendations.push({
      tool: 'discovery_briefing',
      priority: 'high',
      reason: 'Discovery config found. Get proactive intel on trends, competitors, and opportunities relevant to your project.'
    });
  } else if (characteristics.project_type === 'production_system') {
    recommendations.push({
      tool: 'discovery_briefing',
      priority: 'medium',
      reason: 'Production system detected. Set up discovery-config.json to get proactive intel on relevant trends and updates.'
    });
  }

  // Context-aware: read package.json for framework-specific MCP suggestions
  var packageJsonPath = PROJECT.package_json || (characteristics.has_package_json ? path.join(projectRoot, 'package.json') : null);
  if (packageJsonPath) {
    try {
      var pkgRaw = fs.readFileSync(packageJsonPath, 'utf8');
      var pkg = JSON.parse(pkgRaw);
      var allDeps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
      result.detected_dependencies = allDeps.length;

      // Suggest MCP servers based on detected stack
      var mcpSuggestions = [];
      if (allDeps.some(function(d) { return d.indexOf('stripe') !== -1; })) {
        mcpSuggestions.push({ server: 'mcp-stripe', reason: 'Stripe dependency detected - use MCP for payment workflow automation' });
      }
      if (allDeps.some(function(d) { return d.indexOf('postgres') !== -1 || d.indexOf('pg') === d; })) {
        mcpSuggestions.push({ server: 'mcp-postgres', reason: 'PostgreSQL detected - use MCP for schema-aware queries' });
      }
      if (allDeps.some(function(d) { return d.indexOf('express') !== -1 || d.indexOf('fastify') !== -1; })) {
        mcpSuggestions.push({ server: 'mcp-fetch', reason: 'HTTP framework detected - MCP fetch for API testing and monitoring' });
      }
      if (allDeps.some(function(d) { return d.indexOf('puppeteer') !== -1 || d.indexOf('playwright') !== -1; })) {
        mcpSuggestions.push({ server: 'mcp-puppeteer', reason: 'Browser automation detected - MCP for headless browser control' });
      }
      if (mcpSuggestions.length > 0) {
        result.mcp_server_suggestions = mcpSuggestions;
      }
    } catch (e) {}
  }

  // Context-aware: cross-reference with discovery briefing data if available
  var briefingDir = projectPath('data_dir')
    ? path.join(projectPath('data_dir'), 'discovery-briefings')
    : null;
  if (briefingDir) {
    try {
      var briefingFiles = fs.readdirSync(briefingDir).filter(function(f) { return f.endsWith('.md'); }).sort().reverse();
      if (briefingFiles.length > 0) {
        result.latest_briefing = briefingFiles[0].replace('.md', '');
        result.briefing_available = true;
      }
    } catch (e) {}
  }

  // Sort by priority
  const priorityOrder = { essential: 0, high: 1, medium: 2, low: 3 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  result.recommended_tools = recommendations;

  // Step 3: Generate CLAUDE.md
  const essentialTools = recommendations.filter(r => r.priority === 'essential').map(r => r.tool);
  const highTools = recommendations.filter(r => r.priority === 'high').map(r => r.tool);
  const mediumTools = recommendations.filter(r => r.priority === 'medium').map(r => r.tool);

  let claudeMd = '# CLAUDE.md - Generated by The Nervous System MCP Analyzer\n';
  claudeMd += '# Project type: ' + characteristics.project_type + '\n';
  claudeMd += '# Generated: ' + result.timestamp + '\n';
  claudeMd += '# Re-run: mcp_analyzer mode=reload to refresh\n\n';

  claudeMd += '## BEHAVIORAL RULES\n\n';
  claudeMd += 'This project uses The Nervous System for LLM behavioral enforcement.\n';
  claudeMd += 'Before doing anything, internalize these rules:\n\n';
  claudeMd += '1. DISPATCH DONT DO - If a task takes 2+ messages, write a task file and dispatch it.\n';
  claudeMd += '2. UNTOUCHABLE = UNTOUCHABLE - Run preflight before ANY file edit. If blocked, STOP.\n';
  claudeMd += '3. WRITE PROGRESS AS YOU GO - Note what you are about to do before each action.\n';
  claudeMd += '4. STEP BACK EVERY 4 MESSAGES - Are we solving the real problem?\n';
  claudeMd += '5. ASK BEFORE TOUCHING - Do not modify configs or processes without permission.\n';
  claudeMd += '6. HAND OFF EVERY FEW MESSAGES - Update the session handoff file.\n\n';

  if (characteristics.has_protected_files) {
    claudeMd += '## PROTECTED FILES\n\n';
    claudeMd += 'This project has a protected files list at: ' + (protectedPath || 'PROTECTED_FILES.txt') + '\n';
    claudeMd += 'Run preflight_check before editing ANY file. If it is protected, STOP and ask.\n\n';
  }

  claudeMd += '## YOUR TOOLS (in order of importance)\n\n';
  claudeMd += '### Always use these:\n';
  for (const t of essentialTools) {
    const rec = recommendations.find(r => r.tool === t);
    claudeMd += '- **' + t + '** - ' + rec.reason + '\n';
  }

  if (highTools.length > 0) {
    claudeMd += '\n### Use regularly:\n';
    for (const t of highTools) {
      const rec = recommendations.find(r => r.tool === t);
      claudeMd += '- **' + t + '** - ' + rec.reason + '\n';
    }
  }

  if (mediumTools.length > 0) {
    claudeMd += '\n### Use when relevant:\n';
    for (const t of mediumTools) {
      const rec = recommendations.find(r => r.tool === t);
      claudeMd += '- **' + t + '** - ' + rec.reason + '\n';
    }
  }

  claudeMd += '\n## SESSION WORKFLOW\n\n';
  claudeMd += '1. Start: Read session handoff file to see where the last session left off\n';
  claudeMd += '2. Work: Write progress before each action. Run preflight before file edits.\n';
  if (characteristics.has_pm2) {
    claudeMd += '3. End: Call session_close (runs drift audit + propagators automatically)\n';
  } else {
    claudeMd += '3. End: Update the session handoff file with what was done and what is next\n';
  }
  claudeMd += '4. Every 4 messages: Call step_back_check to verify direction\n\n';

  if (characteristics.project_type === 'production_system') {
    claudeMd += '## PRODUCTION RULES\n\n';
    claudeMd += 'This is a production system. Extra care required:\n';
    claudeMd += '- Run security_audit after any auth or config changes\n';
    claudeMd += '- Run drift_audit after any file changes\n';
    claudeMd += '- Run pre_publish_audit before publishing any packages\n';
    claudeMd += '- Use dispatch_to_llm for tasks that take 2+ messages\n';
    claudeMd += '- Kill switch is available for emergencies\n\n';
  }

  // Only include CLAUDE.md content in write/reload mode, not analyze
  if (mode === 'write' || mode === 'reload') {
    result.claude_md_generated = true;
  }

  // Step 4: Config suggestions (if no config exists)
  if (!characteristics.has_config) {
    result.setup_needed = true;
    result.setup_message = 'No nervous-system.config.json found. Run with mode=write to create one and generate a tailored CLAUDE.md for your project.';
  } else {
    result.setup_needed = false;
  }

  // Step 5: If mode is 'reload' or 'write', write the CLAUDE.md
  if ((mode === 'reload' || mode === 'write') && outputPath) {
    try {
      fs.writeFileSync(outputPath, claudeMd);
      result.written_to = outputPath;
    } catch (e) {
      result.write_error = e.message;
    }
  } else if (mode === 'reload' || mode === 'write') {
    // Default output path
    const defaultPath = path.join(projectRoot, 'CLAUDE.md');
    try {
      fs.writeFileSync(defaultPath, claudeMd);
      result.written_to = defaultPath;
    } catch (e) {
      result.write_error = e.message;
    }
  }

  return result;
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

    case 'nervous-system://tamara-reference':
      return `Tamara - Autonomous AI Operations Manager
Reference Implementation for the Nervous System Framework

WHAT TAMARA IS
Tamara is an autonomous operations manager for AI agent fleets. She is not a chatbot or an assistant. She is a production system that monitors, dispatches, fixes, and reports on AI agent infrastructure without human intervention.

Built on Node.js, managed by PM2, reporting via Telegram, running 60-minute autonomous check cycles. Tamara demonstrates what becomes possible when the Nervous System framework governs an entire AI operation.

ARCHITECTURE
- Runtime: Node.js on PM2 process management
- Communication: Telegram bot API for operator alerts
- Cycle: 60-minute autonomous health checks
- Dispatch: Claude Code agents for complex remediation
- Enforcement: Nervous System MCP for behavioral guardrails
- Memory: File-based session handoffs and worklogs
- Security: Preflight checks, audit trails, drift detection

CAPABILITIES
1. Health Monitoring - Process status, memory usage, crash detection, restart tracking
2. Drift Detection - 7-scope configuration drift audit (roles, versions, files, processes, website, platform parity, documentation)
3. Agent Dispatch - Writes task files, launches background LLM agents, monitors completion, collects results
4. Security Audit - Credential exposure scanning, unauthorized file modification detection, process integrity checks
5. Intelligent Routing - Classifies alerts by severity, delivers actionable items to operator, keeps routine data in logs
6. Graceful Shutdown Management - Standardized shutdown handlers, session persistence, crash recovery across all managed agents

INTEGRATION WITH THE NERVOUS SYSTEM
Tamara uses the Nervous System as her governance layer:
- drift_audit tool for configuration consistency checks
- Session handoff templates for context preservation
- Preflight enforcement for file protection
- Worklog patterns for progress documentation
- Violation logging for accountability

PRODUCTION RESULTS
- 13 AI agents managed autonomously
- 5 platforms (Telegram, Instagram, Facebook, Web, Bot Builder)
- 175 countries served
- Under $500/month total infrastructure cost (about $375 actual)
- Zero dedicated DevOps staff
- 99+ protected files with automated enforcement
- Autonomous operation for weeks without human intervention

HOW TO BUILD YOUR OWN TAMARA
1. Install the Nervous System: npm install mcp-nervous-system
2. Create a nervous-system.config.json mapping your project structure
3. Define your agent roster and their expected states
4. Build a health check loop that queries PM2 (or your process manager)
5. Add drift_audit calls to catch configuration inconsistencies
6. Connect a notification channel (Telegram, Slack, email) for operator alerts
7. Implement dispatch_to_llm for automated remediation of common failures
8. Run preflight checks before any automated file modifications

The Nervous System provides the framework. You provide the domain logic. The result is an autonomous operations layer that scales with your agent fleet.

For enterprise implementation support: wa.me/18184399770
Open source: npmjs.com/package/mcp-nervous-system`;

    case 'nervous-system://case-study':
      return `Palyan Family AI System - Production Case Study
Autonomous AI Operations at Scale

OVERVIEW
The Palyan Family AI System is a production deployment of 13 specialized AI agents serving users across 175 countries through 5 platforms. The entire operation runs on a single 4GB VPS for about $48/month, managed autonomously by Tamara - an AI operations manager built on the Nervous System framework.

This is not a demo. This is a live system that has been running continuously since February 2026, processing real user interactions, managing real infrastructure, and operating without dedicated DevOps staff.

THE AGENTS (13 total)
- Lily: Life coach serving players across Telegram, Instagram, Facebook, and web
- Aram: Legal counsel specializing in IP, contracts, and compliance
- Harout: Real estate agent handling Instagram DMs and Telegram inquiries
- Corona: Creative real estate specialist (bilingual EN/ES)
- Soriano: Youth empowerment and training sales
- Spartak: Translation services
- Nick: Advanced personal development trainer
- Harry: Financial tracking and bookkeeping
- Kris: Business credit operations and opportunity scanning
- Roman: Developer education and content
- Uncle Lou: Grant research and LOI drafting
- Lady: Multi-channel execution (email, webforms, portals, job applications)
- Tamara: Operations manager overseeing all of the above

INFRASTRUCTURE
- Server: 4GB VPS (Ubuntu)
- Process Manager: PM2 (29 registered processes, 19+ online)
- LLM Access: Anthropic Max subscription
- Total Monthly Cost: ~$375 (VPS ~$48 + LLM ~$200 + Vercel/insurance/tools)
- Platforms: Telegram, Instagram, Facebook Messenger, Web, Bot Builder SaaS

GOVERNANCE LAYER
The Nervous System MCP provides mechanical enforcement:
- 99+ files protected by preflight checks
- 7 enforced behavioral rules
- SHA-256 hash-chained audit trail
- Configuration drift detection across 7 scopes
- Automated security auditing
- Session handoff continuity

RESULTS
- Zero rules bypassed in production
- 58+ violations caught and logged
- 29 unauthorized edits blocked by preflight
- Continuous autonomous operation
- No dedicated operations staff required

WHAT THIS PROVES
1. AI agent fleets can be managed autonomously with the right governance layer
2. The cost barrier to multi-agent deployment is infrastructure, not complexity
3. Behavioral enforcement must be mechanical, not prompt-based
4. A single operator can manage 13+ agents across 5 platforms with proper tooling

ENTERPRISE IMPLICATIONS
Organizations deploying AI agents at scale face the same challenges this system solves:
- Agent health monitoring and crash recovery
- Configuration consistency across agent fleets
- Behavioral drift detection and correction
- Security and compliance auditing
- Operational continuity without 24/7 staffing

The Nervous System framework is open source. The operational patterns are documented. Enterprise implementation support is available through consulting engagements.

Contact: wa.me/18184399770
Framework: npmjs.com/package/mcp-nervous-system
GitHub: github.com/levelsofself/mcp-nervous-system`;

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

// ============================================================
// DISCOVERY BRIEFING - Proactive intel tool
// ============================================================

function runDiscoveryBriefingTool(scope, context) {
  try {
    const skill = require('./github-repos/mcp-nervous-system/skills/discovery-briefing');
    return skill.runDiscoveryBriefing(scope, context, PROJECT);
  } catch (e) {
    // Fallback: inline implementation if skill file not found
    return runDiscoveryBriefingInline(scope, context);
  }
}

function runDiscoveryBriefingInline(scope, context) {
  var configPaths = [
    PROJECT.data_dir ? path.join(PROJECT.data_dir, 'discovery-config.json') : null,
    '/root/family-data/discovery-config.json'
  ].filter(Boolean);

  var config = null;
  for (var i = 0; i < configPaths.length; i++) {
    try {
      config = JSON.parse(fs.readFileSync(configPaths[i], 'utf8'));
      if (config.discovery) config = config.discovery;
      break;
    } catch (e) { continue; }
  }

  if (!config) {
    config = { categories: ['anthropic_updates', 'ai_ecosystem', 'trending_content', 'tech_stack'] };
  }

  var briefingDir = PROJECT.data_dir
    ? path.join(PROJECT.data_dir, 'discovery-briefings')
    : '/root/family-data/discovery-briefings';

  var result = {
    timestamp: new Date().toISOString(),
    config_loaded: true,
    categories: config.categories || [],
    industries: config.industries || [],
    competitors: config.competitors || [],
    schedule: config.schedule || 'manual',
    delivery: config.delivery || 'file'
  };

  try {
    var files = fs.readdirSync(briefingDir).filter(function(f) { return f.endsWith('.md'); }).sort().reverse();
    if (files.length === 0) {
      result.briefing = null;
      result.message = 'No briefing data available yet. Run discovery-scanner.js to generate the first briefing.';
      result.hint = 'node /root/family-workers/discovery-scanner.js';
      return result;
    }

    var latestFile = path.join(briefingDir, files[0]);
    var content = fs.readFileSync(latestFile, 'utf8');
    result.briefing_file = files[0];
    result.briefing_date = files[0].replace('.md', '');

    // Filter by scope
    if (scope && scope !== 'all') {
      var scopeMap = {
        anthropic: 'Anthropic', ecosystem: 'AI Ecosystem', trending: 'Trending',
        government: 'Government', competitors: 'Competitors', techstack: 'Tech Stack', grants: 'Grants'
      };
      var header = scopeMap[scope];
      if (header) {
        var lines = content.split('\n');
        var filtered = [];
        var inSection = false;
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].startsWith('## ') && lines[j].indexOf(header) !== -1) {
            inSection = true; filtered.push(lines[j]);
          } else if (lines[j].startsWith('## ') && inSection) {
            break;
          } else if (inSection) {
            filtered.push(lines[j]);
          }
        }
        content = filtered.length > 0 ? filtered.join('\n') : 'No items for scope: ' + scope;
      }
    }

    result.briefing = content;

    // Count tags
    var tagCounts = { use_now: 0, watch: 0, opportunity: 0, threat: 0 };
    var tagLabels = { use_now: 'USE NOW', watch: 'WATCH', opportunity: 'OPPORTUNITY', threat: 'THREAT' };
    for (var key in tagLabels) {
      var regex = new RegExp('\\[' + tagLabels[key] + '\\]', 'g');
      var matches = content.match(regex);
      tagCounts[key] = matches ? matches.length : 0;
    }
    result.item_counts = tagCounts;
    result.total_items = tagCounts.use_now + tagCounts.watch + tagCounts.opportunity + tagCounts.threat;

    // Staleness check
    var dateStr = files[0].replace('.md', '');
    var briefingDate = new Date(dateStr + 'T12:00:00Z');
    var hoursOld = (new Date() - briefingDate) / (1000 * 60 * 60);
    if (hoursOld > 48) {
      result.stale = true;
      result.stale_warning = 'Briefing is ' + Math.floor(hoursOld / 24) + ' days old. Scanner may not be running.';
    }

    return result;
  } catch (e) {
    result.briefing = null;
    result.error = e.message;
    return result;
  }
}

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
    res.end(JSON.stringify({ status: 'ok', service: 'nervous-system-mcp', version: '1.11.0', protocol: MCP_VERSION }));
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
      version: '1.11.0',
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[MCP Server] Port ${PORT} in use - retrying in 3s...`);
    setTimeout(() => server.listen(PORT, '127.0.0.1'), 3000);
  } else {
    console.error(`[MCP Server] Server error: ${err.message}`);
  }
});

process.on('uncaughtException', (err) => {
  console.error(`[MCP Server] Uncaught exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[MCP Server] Unhandled rejection: ${reason}`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[MCP Server] Nervous System v1.10.0 running on port ${PORT}`);
  console.error(`[MCP Server] SSE: /sse | HTTP: /mcp | Health: /health | Kill: POST /kill | Audit: GET /audit/verify | Dispatches: GET /dispatches`);
  console.error(`[MCP Server] Protocol: ${MCP_VERSION}`);
  console.error(`[MCP Server] Tools: ${TOOLS.length} (including kill switch, audit chain, dispatch, drift audit, page health, pre-publish audit)`);
});
