const http = require('http');
const crypto = require('crypto');

const PORT = 3475;

// MCP Protocol version
const MCP_VERSION = '2024-11-05';

// Server info
const SERVER_INFO = {
  name: 'nervous-system',
  version: '1.0.0'
};

// ============================================================
// THE NERVOUS SYSTEM - Content
// Patterns and frameworks only. No secrets, keys, or internal data.
// ============================================================

const FRAMEWORK = {
  name: 'The Nervous System',
  version: '1.0.0',
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
# Two modes:
#   preflight.sh /path/to/file    - check before editing
#   preflight.sh --check-handoff  - verify handoff freshness

LOGFILE="/path/to/guardrail-violations.log"
mkdir -p "$(dirname "$LOGFILE")"

# Handoff staleness check
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

# File edit check
FILE="$1"
if [ -z "$FILE" ]; then
  echo "Usage: preflight.sh /path/to/file"
  exit 1
fi

# Resolve to absolute path
if command -v realpath >/dev/null 2>&1 && [ -e "$FILE" ]; then
  FILE=$(realpath "$FILE")
fi

# Check UNTOUCHABLE list
if grep -qF "$FILE" /path/to/UNTOUCHABLE_FILES.txt 2>/dev/null; then
  echo "BLOCKED: $FILE is UNTOUCHABLE."
  echo "$(date -Iseconds) BLOCKED_UNTOUCHABLE: $FILE" >> "$LOGFILE"
  exit 1
fi

# Check PROTECTED files
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

# Data Files (CRITICAL - PROTECT)
/path/to/data1.json
/path/to/data2.json

# Credentials (PROTECT)
/path/to/credentials.json

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
    'Read the worklog FIRST at the start of every session - the answer to most problems is in the last entry'
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
      'Permission Protocol - DATA vs LOGIC change classification'
    ]
  },
  origin_story: {
    context: 'Arthur Palyan runs a startup with 12 AI family members, each with distinct roles. The entire operation runs on a $12/month VPS with a $300/month LLM subscription.',
    problem_discovered: 'After months of building, patterns emerged: LLMs would break working systems while trying to improve them. They would loop on debugging instead of dispatching. They would silently fail when sessions timed out. They would lose all context between sessions.',
    solution_built: 'Arthur built the nervous system - not by changing the LLM model, but by wrapping it in behavioral rules enforced through scripts, file checks, and prompt engineering. The LLM itself became the enforcement mechanism, trained to check before acting.',
    philosophy: 'The brain (LLM) is powerful but needs a nervous system to keep it from hurting itself. Just like a human nervous system sends pain signals before you touch a hot stove, this system sends BLOCKED/PROTECTED signals before the LLM edits a critical file.',
    result: '22+ autonomous processes running 24/7 with minimal human oversight. The system catches its own mistakes before they become problems.'
  },
  implementation_guide: {
    step_1: {
      name: 'Create your untouchable files list',
      description: 'List every file that WORKS and should not be edited. Be aggressive - protect what works, free what you are building.'
    },
    step_2: {
      name: 'Write the preflight script',
      description: 'A simple bash script that checks any file path against the untouchable list before editing. Returns BLOCKED, PROTECTED, or OK.'
    },
    step_3: {
      name: 'Set up session handoff',
      description: 'Create a SESSION_HANDOFF.md file. Update it every 3-4 exchanges. Write what happened, system state, what is next.'
    },
    step_4: {
      name: 'Set up the worklog',
      description: 'Create a WORKLOG.md. Append to it at the end of every session. Date, time, what changed, file list, status.'
    },
    step_5: {
      name: 'Add behavioral rules to your system prompt',
      description: 'The 7 core rules go into your LLM system prompt: DISPATCH DONT DO, UNTOUCHABLE, WRITE PROGRESS, STEP BACK, DELEGATE AND RETURN, ASK BEFORE TOUCHING, HAND OFF.'
    },
    step_6: {
      name: 'Enable violation logging',
      description: 'The preflight script logs every BLOCKED/PROTECTED attempt. Review periodically to see which rules the LLM struggles with.'
    },
    step_7: {
      name: 'Add the reflection cycle',
      description: 'Every N messages, the LLM must stop, zoom out, and report to the human whether the current direction serves the bigger mission.'
    }
  },
  problem_it_solves: {
    problems: [
      {
        name: 'Context Loss',
        description: 'LLM sessions are ephemeral. When a session ends, everything learned is gone.',
        solution: 'Session handoff file updated every 3-4 exchanges. The next session reads it first.'
      },
      {
        name: 'Infinite Loops',
        description: 'LLMs will debug the same error for 10+ messages, burning context and time.',
        solution: 'DISPATCH DONT DO rule. If it takes more than 2 messages, write a task file and dispatch a background agent.'
      },
      {
        name: 'Silent Failures',
        description: 'Sessions time out mid-task. Nobody knows what happened or where it stopped.',
        solution: 'WRITE PROGRESS AS YOU GO. Before each action, note what you are about to do. If timeout hits, progress is visible.'
      },
      {
        name: 'Editing Protected Files',
        description: 'LLMs break working systems by making "improvements" to files that should not be touched.',
        solution: 'Preflight check system with UNTOUCHABLE file list. Script returns BLOCKED before any edit can happen.'
      },
      {
        name: 'Mission Drift',
        description: 'LLMs zoom into details and lose sight of the bigger picture. Hours spent on the wrong problem.',
        solution: 'STEP BACK EVERY 4 MESSAGES. Forced reflection cycle: are we solving the real problem?'
      },
      {
        name: 'Solving Instead of Asking',
        description: 'LLMs patch, fix, and modify without checking with the human first.',
        solution: 'ASK BEFORE TOUCHING rule and permission protocol (DATA vs LOGIC classification).'
      },
      {
        name: 'Lost Progress on Timeout',
        description: 'Multi-step tasks lose all progress when a session times out.',
        solution: 'Continuous worklog entries + session handoff + task files. Every step is written down.'
      }
    ]
  },
  stats: {
    protected_files: '89+ untouchable files',
    core_rules: 7,
    reflection_trigger: 'Every 4 messages',
    processes_managed: '22+ autonomous PM2 processes',
    family_members: 12,
    monthly_cost: '$352/month total infrastructure',
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
    annotations: {
      title: 'Get Nervous System Framework',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Returns the complete nervous system framework - all behavioral rules, guardrails, and enforcement patterns that keep LLMs from hurting themselves. Use this to understand the full system.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'session_handoff',
    annotations: {
      title: 'Session Handoff System',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Get the session handoff system that solves context loss between LLM sessions. Includes templates, examples, and best practices for writing handoffs that preserve continuity.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to retrieve about session handoffs.',
          enum: ['read_example', 'get_template', 'get_best_practices']
        }
      },
      required: ['action']
    }
  },
  {
    name: 'preflight_check',
    annotations: {
      title: 'Preflight Check System',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Get the preflight check system that protects files from accidental LLM edits. Includes the script pattern, enforcement flow, and untouchable file list template.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to retrieve about the preflight system.',
          enum: ['get_script', 'get_pattern', 'get_untouchable_template']
        }
      },
      required: ['action']
    }
  },
  {
    name: 'worklog',
    annotations: {
      title: 'Worklog Pattern',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Get the worklog pattern - continuous progress writing that prevents silent failures. LLM writes what it did, files changed, and system state after every session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to retrieve about the worklog system.',
          enum: ['get_template', 'get_format', 'get_best_practices']
        }
      },
      required: ['action']
    }
  },
  {
    name: 'guardrail_rules',
    annotations: {
      title: 'Guardrail Rules',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Returns behavioral rules for LLM management: DISPATCH DONT DO, ASK BEFORE TOUCHING, STEP BACK, WRITE PROGRESS, HAND OFF, PERMISSION PROTOCOL. The core enforcement layer.',
    inputSchema: {
      type: 'object',
      properties: {
        rule: {
          type: 'string',
          description: 'Which rule to retrieve. Use "all" for the complete set.',
          enum: ['dispatch_dont_do', 'ask_before_touching', 'step_back', 'write_progress', 'hand_off', 'permission_protocol', 'all']
        }
      }
    }
  },
  {
    name: 'violation_logging',
    annotations: {
      title: 'Violation Logging Pattern',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Get the violation logging pattern - how to track, log, and enforce guardrail breaches. Every attempted edit of a protected file is logged with timestamp and details.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to retrieve about violation logging.',
          enum: ['get_pattern', 'get_template', 'get_enforcement']
        }
      },
      required: ['action']
    }
  },
  {
    name: 'step_back_check',
    annotations: {
      title: 'Seven Level Reflection',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'The 7-level reflection system. Forces the LLM to zoom out, see the big picture, and ask whether current work serves the real mission. Use this every N messages to prevent drift.',
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'string',
          description: 'Optional: describe your current context/task for a tailored reflection prompt.'
        }
      }
    }
  },
  {
    name: 'get_nervous_system_info',
    annotations: {
      title: 'Nervous System Info',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description: 'Overview of the entire nervous system - what it is, where it came from, how to implement it, what problems it solves, and operational stats.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'What to learn about the nervous system.',
          enum: ['overview', 'origin_story', 'implementation_guide', 'problem_it_solves', 'stats']
        }
      },
      required: ['topic']
    }
  }
];

// Resource definitions
const RESOURCES = [
  {
    uri: 'nervous-system://framework',
    name: 'The Nervous System Framework',
    description: 'Complete behavioral enforcement framework for LLM management',
    mimeType: 'text/plain'
  },
  {
    uri: 'nervous-system://quick-start',
    name: 'Quick Start Guide',
    description: 'How to implement the nervous system in your own LLM deployment',
    mimeType: 'text/plain'
  },
  {
    uri: 'nervous-system://rules',
    name: 'The 7 Core Rules',
    description: 'All 7 behavioral rules with explanations and enforcement',
    mimeType: 'text/plain'
  },
  {
    uri: 'nervous-system://templates',
    name: 'Templates',
    description: 'Ready-to-use templates for handoffs, worklogs, preflight, and untouchable lists',
    mimeType: 'text/plain'
  }
];

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
          return {
            example: {
              header: '# SESSION HANDOFF\nUpdated: 2026-03-01 18:30 UTC',
              sections: [
                'WHAT JUST HAPPENED - Deployed v6 chatbox with static greeting and context-on-demand loading. Security hardening completed across all ports.',
                'SYSTEM STATE - 22 PM2 processes online. All ports bound to localhost behind reverse proxy.',
                'WHAT NEEDS TO HAPPEN NEXT - MCP submission, dashboard update, mobile responsive CSS.',
                'FILES CHANGED - Listed with one-line descriptions of each change.',
                'HUMAN ACTIONS NEEDED - Credential rotation, form submissions, file approvals.'
              ],
              key_qualities: [
                'Specific enough that the next session needs zero additional context',
                'Lists exact files changed',
                'Separates system state from action items',
                'Flags human-required actions separately'
              ]
            }
          };
        case 'get_template':
          return SESSION_HANDOFF_TEMPLATE;
        case 'get_best_practices':
          return { best_practices: SESSION_HANDOFF_TEMPLATE.best_practices, example_sections: SESSION_HANDOFF_TEMPLATE.example_sections };
        default:
          return { error: 'Unknown action', available: ['read_example', 'get_template', 'get_best_practices'] };
      }
    }

    case 'preflight_check': {
      switch (args.action) {
        case 'get_script':
          return { script: PREFLIGHT_PATTERN.script_template, concept: PREFLIGHT_PATTERN.concept };
        case 'get_pattern':
          return { concept: PREFLIGHT_PATTERN.concept, flow: PREFLIGHT_PATTERN.flow };
        case 'get_untouchable_template':
          return { template: PREFLIGHT_PATTERN.untouchable_template };
        default:
          return { error: 'Unknown action', available: ['get_script', 'get_pattern', 'get_untouchable_template'] };
      }
    }

    case 'worklog': {
      switch (args.action) {
        case 'get_template':
          return { format: WORKLOG_TEMPLATE.format, example: WORKLOG_TEMPLATE.example };
        case 'get_format':
          return { format: WORKLOG_TEMPLATE.format };
        case 'get_best_practices':
          return { best_practices: WORKLOG_TEMPLATE.best_practices };
        default:
          return { error: 'Unknown action', available: ['get_template', 'get_format', 'get_best_practices'] };
      }
    }

    case 'guardrail_rules': {
      const rule = args.rule || 'all';
      if (rule === 'all') {
        return GUARDRAIL_RULES;
      }
      if (GUARDRAIL_RULES[rule]) {
        return GUARDRAIL_RULES[rule];
      }
      return { error: 'Unknown rule', available: Object.keys(GUARDRAIL_RULES) };
    }

    case 'violation_logging': {
      switch (args.action) {
        case 'get_pattern':
          return VIOLATION_LOGGING.pattern;
        case 'get_template':
          return { template: VIOLATION_LOGGING.template };
        case 'get_enforcement':
          return VIOLATION_LOGGING.enforcement;
        default:
          return { error: 'Unknown action', available: ['get_pattern', 'get_template', 'get_enforcement'] };
      }
    }

    case 'step_back_check': {
      const reflection = {
        trigger: SEVEN_LEVELS.trigger,
        steps: SEVEN_LEVELS.steps,
        instruction: SEVEN_LEVELS.instruction,
        purpose: SEVEN_LEVELS.purpose
      };
      if (args.context) {
        reflection.tailored_prompt = `STEP BACK NOW.\n\nYou are currently working on: ${args.context}\n\nBefore your next action, answer these questions OUT LOUD to the human:\n1. What are we actually building? Is "${args.context}" the right thing to work on right now?\n2. Are we solving the real problem or just the surface symptom?\n3. Is this moving toward revenue or just toward "busy"?\n4. What would a partner say about this direction?\n5. Is the operations layer involved, or are we bypassing it?\n\nSay your answers. Then continue.`;
      }
      return reflection;
    }

    case 'get_nervous_system_info': {
      switch (args.topic) {
        case 'overview':
          return NERVOUS_SYSTEM_INFO.overview;
        case 'origin_story':
          return NERVOUS_SYSTEM_INFO.origin_story;
        case 'implementation_guide':
          return NERVOUS_SYSTEM_INFO.implementation_guide;
        case 'problem_it_solves':
          return NERVOUS_SYSTEM_INFO.problem_it_solves;
        case 'stats':
          return NERVOUS_SYSTEM_INFO.stats;
        default:
          return { error: 'Unknown topic', available: ['overview', 'origin_story', 'implementation_guide', 'problem_it_solves', 'stats'] };
      }
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
      return Object.values(NERVOUS_SYSTEM_INFO.implementation_guide)
        .map(step => `${step.name}\n${step.description}`)
        .join('\n\n');

    case 'nervous-system://rules':
      return Object.values(GUARDRAIL_RULES)
        .map(r => `## ${r.name}\n${r.rule}${r.implementation ? '\n\nImplementation:\n' + r.implementation.map(s => `- ${s}`).join('\n') : ''}`)
        .join('\n\n---\n\n');

    case 'nervous-system://templates':
      return `## SESSION HANDOFF TEMPLATE\n${SESSION_HANDOFF_TEMPLATE.template}\n\n---\n\n## WORKLOG FORMAT\n${WORKLOG_TEMPLATE.format}\n\n---\n\n## PREFLIGHT SCRIPT\n${PREFLIGHT_PATTERN.script_template}\n\n---\n\n## UNTOUCHABLE FILES TEMPLATE\n${PREFLIGHT_PATTERN.untouchable_template}`;

    default:
      return null;
  }
}

// ============================================================
// MCP Protocol Handling (copied from mcp-server.js)
// ============================================================

function jsonrpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const sseConnections = new Map();

function handleMCPRequest(body) {
  const { method, params, id } = body;

  switch (method) {
    case 'initialize':
      return jsonrpc(id, {
        protocolVersion: MCP_VERSION,
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: SERVER_INFO
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return jsonrpc(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      const result = handleToolCall(name, args || {});
      return jsonrpc(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      });
    }

    case 'resources/list':
      return jsonrpc(id, { resources: RESOURCES });

    case 'resources/read': {
      const content = handleResourceRead(params.uri);
      if (content) {
        return jsonrpc(id, {
          contents: [{ uri: params.uri, mimeType: 'text/plain', text: content }]
        });
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'nervous-system-mcp', version: '1.0.0', protocol: MCP_VERSION }));
    return;
  }

  // MCP SSE endpoint
  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

    sseConnections.set(sessionId, res);

    req.on('close', () => {
      sseConnections.delete(sessionId);
    });

    const keepAlive = setInterval(() => {
      if (!sseConnections.has(sessionId)) {
        clearInterval(keepAlive);
        return;
      }
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
        const response = handleMCPRequest(parsed);

        const sseRes = sseConnections.get(sessionId);
        if (sseRes && response) {
          sseRes.write(`event: message\ndata: ${response}\n\n`);
        }

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
        const response = handleMCPRequest(parsed);

        if (response) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(response);
        } else {
          res.writeHead(204);
          res.end();
        }
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
      version: '1.0.0',
      protocol: MCP_VERSION,
      description: 'LLM behavioral enforcement framework. 7 core rules, preflight checks, session handoffs, worklogs, violation logging, and forced reflection cycles. Built by Arthur Palyan.',
      endpoints: {
        sse: '/sse',
        message: '/message',
        http: '/mcp',
        health: '/health'
      },
      tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
      resources: RESOURCES.map(r => ({ uri: r.uri, name: r.name })),
      links: {
        game: 'https://100levelup.com',
        website: 'https://www.levelsofself.com'
      }
    }, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[MCP Server] Nervous System running on port ${PORT}`);
  console.log(`[MCP Server] SSE: /sse | HTTP: /mcp | Health: /health`);
  console.log(`[MCP Server] Protocol: ${MCP_VERSION}`);
});
