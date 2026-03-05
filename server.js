const http = require('http');
const { validateRequest, mcpErrorResponse } = require('./mcp-api-middleware');
const SERVER_NAME_ID = 'nervous-system';
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = 3475;

const KILL_SECRET = process.env.KILL_SECRET || 'ns-kill-2026';
const AUDIT_CHAIN_FILE = '/root/family-data/audit-chain.json';
const VIOLATIONS_LOG = '/root/family-logs/guardrail-violations.log';
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
  const logFile = `/root/family-logs/dispatch-${ts}.log`;
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



// ============================================================
// INTENT PARSER - Decompose what the person actually wants
// ============================================================

function parseUserIntent(rawInput, conversationContext) {
  var input = rawInput || '';
  var ctx = conversationContext || '';
  
  // Step 1: Extract action verbs and objects
  var actionPatterns = [
    { pattern: /(?:build|create|make|write|generate|develop)\s+(.+?)(?:\.|,|$)/gi, type: 'create' },
    { pattern: /(?:fix|repair|update|change|modify|edit|patch)\s+(.+?)(?:\.|,|$)/gi, type: 'modify' },
    { pattern: /(?:check|verify|test|audit|review|validate|inspect)\s+(.+?)(?:\.|,|$)/gi, type: 'verify' },
    { pattern: /(?:delete|remove|clean|clear|drop)\s+(.+?)(?:\.|,|$)/gi, type: 'delete' },
    { pattern: /(?:deploy|launch|ship|release|publish|push)\s+(.+?)(?:\.|,|$)/gi, type: 'deploy' },
    { pattern: /(?:find|search|look|research|discover|explore)\s+(.+?)(?:\.|,|$)/gi, type: 'research' },
    { pattern: /(?:explain|describe|tell|show|list|summarize)\s+(.+?)(?:\.|,|$)/gi, type: 'inform' },
    { pattern: /(?:apply|implement|integrate|add|install|connect)\s+(.+?)(?:\.|,|$)/gi, type: 'implement' }
  ];
  
  var deliverables = [];
  var actionTypes = [];
  var lower = input.toLowerCase();
  
  // Extract explicit deliverables from conjunctions
  var conjunctionSplit = input.split(/\b(?:then|and then|also|plus|and also|after that)\b|,\s*(?=(?:verify|test|audit|check|build|create|fix|update|apply|deploy|delete|find|review|make|write|read))/i);
  
  // Also split on "and" when followed by a verb
  var segments = [];
  for (var s = 0; s < conjunctionSplit.length; s++) {
    var part = conjunctionSplit[s].trim();
    // Split on "and [verb]" pattern
    var andSplit = part.split(/\band\s+(?=(?:build|create|fix|check|verify|test|audit|update|apply|deploy|delete|remove|find|explain))/i);
    for (var a = 0; a < andSplit.length; a++) {
      if (andSplit[a].trim()) segments.push(andSplit[a].trim());
    }
  }
  
  if (segments.length <= 1) segments = [input];
  
  for (var seg = 0; seg < segments.length; seg++) {
    var segment = segments[seg];
    var found = false;
    for (var p = 0; p < actionPatterns.length; p++) {
      var pat = actionPatterns[p];
      pat.pattern.lastIndex = 0;
      var match = pat.pattern.exec(segment);
      if (match) {
        deliverables.push({
          id: deliverables.length + 1,
          action: pat.type,
          target: match[1].trim().substring(0, 100),
          raw_segment: segment.substring(0, 150),
          status: 'pending'
        });
        if (actionTypes.indexOf(pat.type) === -1) actionTypes.push(pat.type);
        found = true;
        break;
      }
    }
    if (!found && segment.length > 10) {
      deliverables.push({
        id: deliverables.length + 1,
        action: 'unclear',
        target: segment.substring(0, 100),
        raw_segment: segment.substring(0, 150),
        status: 'needs_clarification'
      });
    }
  }
  
  // Step 2: Detect scope references
  var scopeTargets = [];
  var filePatterns = /(?:[\w-]+\.(?:js|json|md|py|html|css|txt|sh))/gi;
  var fileMatch;
  while ((fileMatch = filePatterns.exec(input)) !== null) {
    scopeTargets.push(fileMatch[0]);
  }
  var systemPatterns = /(?:arthur\.html|chatbox|VPS|family|MCP|nervous system|bridge|tamara|proxy|here|this system)/gi;
  var sysMatch;
  while ((sysMatch = systemPatterns.exec(input)) !== null) {
    if (scopeTargets.indexOf(sysMatch[0]) === -1) scopeTargets.push(sysMatch[0]);
  }
  
  // Step 3: Detect ambiguity signals
  var ambiguityFlags = [];
  if (/\b(?:that thing|the thing|it|this|those)\b/i.test(input) && !ctx) {
    ambiguityFlags.push('Pronoun without context - "' + input.match(/\b(?:that thing|the thing|it|this|those)\b/i)[0] + '" needs clarification');
  }
  if (/\b(?:maybe|perhaps|might|could|sort of|kind of|something like)\b/i.test(input)) {
    ambiguityFlags.push('Hedging language detected - person may be uncertain about what they want');
  }
  if (/\b(?:etc|and stuff|and things|whatever|you know)\b/i.test(input)) {
    ambiguityFlags.push('Trailing vagueness - request may have unstated components');
  }
  if (deliverables.length === 0) {
    ambiguityFlags.push('No clear action verbs detected - ask what the person wants done');
  }
  
  // Step 4: Detect implicit expectations not stated
  var implicitExpectations = [];
  if (actionTypes.indexOf('create') > -1 || actionTypes.indexOf('modify') > -1) {
    implicitExpectations.push('Person likely expects the output to be tested/verified before delivery');
  }
  if (actionTypes.indexOf('deploy') > -1) {
    implicitExpectations.push('Person likely expects confirmation that deployment is live and working');
  }
  if (actionTypes.indexOf('verify') > -1 && actionTypes.indexOf('modify') > -1) {
    implicitExpectations.push('Person expects both the check AND the fix - not just a report');
  }
  if (scopeTargets.length > 2) {
    implicitExpectations.push('Multiple targets mentioned - person expects ALL of them addressed, not just the first');
  }
  
  // Step 5: Generate confirmation prompt
  var needsClarification = ambiguityFlags.length > 0 || deliverables.some(function(d) { return d.status === 'needs_clarification'; });
  
  var confirmationPrompt = '';
  if (deliverables.length > 0) {
    confirmationPrompt = 'I understand you want me to:\n';
    for (var d = 0; d < deliverables.length; d++) {
      var del = deliverables[d];
      confirmationPrompt += (d + 1) + '. ' + del.action.toUpperCase() + ': ' + del.target + '\n';
    }
    if (needsClarification) {
      confirmationPrompt += '\nBut I need clarification on:\n';
      for (var f = 0; f < ambiguityFlags.length; f++) {
        confirmationPrompt += '- ' + ambiguityFlags[f] + '\n';
      }
    }
  }
  
  // Step 6: Calculate understanding confidence
  var confidence = 100;
  // Deductions
  if (ambiguityFlags.length > 0) confidence -= (ambiguityFlags.length * 15);
  if (deliverables.some(function(d) { return d.status === 'needs_clarification'; })) confidence -= 20;
  if (deliverables.some(function(d) { return d.target === 'it' || d.target === 'this' || d.target === 'that'; })) confidence -= 10;
  if (deliverables.length === 0) confidence -= 40;
  if (deliverables.length === 1 && input.length > 100) confidence -= 15; // long input parsed as single deliverable = probably missed something
  if (implicitExpectations.length > 1) confidence -= 5;
  if (confidence < 0) confidence = 0;
  if (confidence > 100) confidence = 100;
  
  var readyToExecute = confidence >= 80;
  var action = readyToExecute ? 'EXECUTE' : 'CLARIFY_FIRST';
  
  if (!readyToExecute && confirmationPrompt) {
    confirmationPrompt += '\nCONFIDENCE: ' + confidence + '% (below 80% threshold)\n';
    confirmationPrompt += 'I should confirm my understanding before executing.\n';
    if (ambiguityFlags.length > 0) {
      confirmationPrompt += 'Unclear areas:\n';
      for (var af = 0; af < ambiguityFlags.length; af++) {
        confirmationPrompt += '- ' + ambiguityFlags[af] + '\n';
      }
    }
  }

  return {
    raw_input: input.substring(0, 300),
    confidence: confidence,
    ready_to_execute: readyToExecute,
    recommended_action: action,
    deliverables: deliverables,
    deliverable_count: deliverables.length,
    action_types: actionTypes,
    scope_targets: scopeTargets,
    ambiguity_flags: ambiguityFlags,
    implicit_expectations: implicitExpectations,
    needs_clarification: needsClarification,
    confirmation_prompt: confirmationPrompt,
    meta: {
      parser_version: '1.0.0',
      note: 'Use this BEFORE executing. Confirm deliverables with the person. Track each to completion.'
    }
  };
}

// ============================================================
// TASK COMPLEXITY CLASSIFIER + MODEL ROUTER
// ============================================================

const COMPLEXITY_DIMENSIONS = {
  scope: {
    name: 'Scope',
    description: 'How many files, systems, or components does this task touch?',
    scoring: {
      0: 'Single value or status check',
      1: 'Single file edit or read',
      2: 'Multiple files in same system',
      3: 'Multiple systems that must stay consistent'
    }
  },
  judgment: {
    name: 'Judgment',
    description: 'Does this require reasoning or just execution?',
    scoring: {
      0: 'Mechanical - copy, move, restart, format',
      1: 'Template-based - follow a known pattern',
      2: 'Analytical - compare, evaluate, choose between options',
      3: 'Strategic - design, architect, make tradeoffs with incomplete info'
    }
  },
  risk: {
    name: 'Risk',
    description: 'What breaks if this goes wrong?',
    scoring: {
      0: 'Nothing - read-only or disposable output',
      1: 'Recoverable - can be reverted easily',
      2: 'Production impact - affects live systems or users',
      3: 'Critical - touches auth, money, protected files, or irreversible actions'
    }
  },
  context: {
    name: 'Context Depth',
    description: 'How much background knowledge is needed?',
    scoring: {
      0: 'Self-contained - everything needed is in the prompt',
      1: 'Single reference - needs one file or doc for context',
      2: 'Multi-reference - needs to cross-check multiple sources',
      3: 'Institutional - needs deep knowledge of system history, conventions, relationships'
    }
  },
  ambiguity: {
    name: 'Ambiguity',
    description: 'How well-defined is the task?',
    scoring: {
      0: 'Exact - specific input, specific output, no interpretation needed',
      1: 'Clear - goal is obvious, minor decisions in implementation',
      2: 'Open - multiple valid approaches, needs judgment on which',
      3: 'Vague - requires clarification, scoping, or reframing before execution'
    }
  },
  verification: {
    name: 'Verification',
    description: 'How hard is it to check if the output is correct?',
    scoring: {
      0: 'Binary - works or does not (syntax check, process restart)',
      1: 'Checkable - output can be compared against a known good state',
      2: 'Reviewable - needs human or senior model to assess quality',
      3: 'Uncertain - correctness depends on downstream effects not immediately visible'
    }
  }
};

const MODEL_TIERS = {
  tier1: {
    name: 'Tier 1 - Fast Execution',
    score_range: [0, 6],
    recommended_models: ['haiku', 'small free models', 'groq-llama-70b'],
    use_cases: 'Status checks, simple reads, formatting, single-value lookups, process restarts',
    cost_profile: 'Lowest cost, fastest response, highest throughput'
  },
  tier2: {
    name: 'Tier 2 - Capable Worker',
    score_range: [7, 12],
    recommended_models: ['sonnet', 'deepseek', 'nemotron-253b'],
    use_cases: 'Single-file edits, scoped bug fixes, template-based generation, standard dispatches',
    cost_profile: 'Balanced cost and quality, good for 80% of tasks'
  },
  tier3: {
    name: 'Tier 3 - Deep Reasoning',
    score_range: [13, 18],
    recommended_models: ['opus', 'o1-equivalent'],
    use_cases: 'Multi-system audits, architecture decisions, cross-file consistency, strategic planning, code review',
    cost_profile: 'Highest cost, use only when judgment across systems is required'
  }
};

function classifyTaskComplexity(taskDescription, hints) {
  var scores = {};
  var reasoning = {};
  var h = hints || {};
  
  // --- SCOPE ---
  var scopeScore = 0;
  var scopeReason = '';
  if (h.files_involved) {
    var fc = parseInt(h.files_involved) || 0;
    if (fc <= 0) { scopeScore = 0; scopeReason = 'Read-only or no files'; }
    else if (fc === 1) { scopeScore = 1; scopeReason = fc + ' file involved'; }
    else if (fc <= 3) { scopeScore = 2; scopeReason = fc + ' files in scope'; }
    else { scopeScore = 3; scopeReason = fc + ' files across systems'; }
  } else {
    // Keyword heuristics
    var multiSignals = ['audit', 'all files', 'every', 'cross-reference', 'consistent', 'sync', 'rebuild', 'migration'];
    var singleSignals = ['restart', 'check', 'read', 'status', 'tail', 'grep', 'cat'];
    var desc = taskDescription.toLowerCase();
    var multiHits = multiSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
    var singleHits = singleSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
    if (multiHits >= 2) { scopeScore = 3; scopeReason = 'Multiple cross-system signals detected'; }
    else if (multiHits === 1) { scopeScore = 2; scopeReason = 'Multi-file operation indicated'; }
    else if (singleHits > 0) { scopeScore = 0; scopeReason = 'Single-target operation'; }
    else { scopeScore = 1; scopeReason = 'Default: moderate scope assumed'; }
  }
  scores.scope = scopeScore;
  reasoning.scope = scopeReason;

  // --- JUDGMENT ---
  var judgmentScore = 0;
  var judgmentReason = '';
  var strategicSignals = ['design', 'architect', 'strategy', 'decide', 'evaluate', 'compare', 'which approach', 'tradeoff', 'should we', 'what if', 'rate', 'review', 'audit', 'consistent', 'cross-reference', 'rebuild'];
  var mechanicalSignals = ['restart', 'copy', 'move', 'delete', 'install', 'format', 'rename', 'list'];
  var desc = taskDescription.toLowerCase();
  var stratHits = strategicSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
  var mechHits = mechanicalSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
  if (stratHits >= 2) { judgmentScore = 3; judgmentReason = 'Strategic reasoning required'; }
  else if (stratHits === 1) { judgmentScore = 2; judgmentReason = 'Analytical judgment needed'; }
  else if (mechHits > 0) { judgmentScore = 0; judgmentReason = 'Mechanical execution'; }
  else { judgmentScore = 1; judgmentReason = 'Standard task with minor decisions'; }
  scores.judgment = judgmentScore;
  reasoning.judgment = judgmentReason;

  // --- RISK ---
  var riskScore = 0;
  var riskReason = '';
  if (h.touches_protected === true || h.touches_protected === 'true') { riskScore = 3; riskReason = 'Touches protected/UNTOUCHABLE files'; }
  else if (h.touches_production === true || h.touches_production === 'true') { riskScore = 2; riskReason = 'Affects production/live systems'; }
  else {
    var criticalSignals = ['untouchable', 'protected', 'password', 'secret', 'auth', 'payment', 'stripe', 'delete all', 'drop', 'kill'];
    var prodSignals = ['deploy', 'production', 'live', 'caddy', 'pm2 restart', 'users'];
    var desc = taskDescription.toLowerCase();
    var critHits = criticalSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
    var prodHits = prodSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
    if (critHits > 0) { riskScore = 3; riskReason = 'Critical system signals detected'; }
    else if (prodHits > 0) { riskScore = 2; riskReason = 'Production system involved'; }
    else { riskScore = 0; riskReason = 'Low risk - no critical signals'; }
  }
  scores.risk = riskScore;
  reasoning.risk = riskReason;

  // --- CONTEXT DEPTH ---
  var contextScore = 0;
  var contextReason = '';
  if (h.context_files) {
    var cf = parseInt(h.context_files) || 0;
    if (cf === 0) { contextScore = 0; contextReason = 'Self-contained'; }
    else if (cf === 1) { contextScore = 1; contextReason = 'Single reference needed'; }
    else if (cf <= 2) { contextScore = 2; contextReason = cf + ' references to cross-check'; }
    else { contextScore = 3; contextReason = cf + ' sources - deep institutional knowledge'; }
  } else {
    var deepSignals = ['history', 'convention', 'pattern', 'how we', 'our approach', 'consistent with', 'previous session'];
    var desc = taskDescription.toLowerCase();
    var deepHits = deepSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
    if (deepHits >= 2) { contextScore = 3; contextReason = 'Requires institutional knowledge'; }
    else if (deepHits === 1) { contextScore = 2; contextReason = 'Needs system context'; }
    else { contextScore = 1; contextReason = 'Minimal context assumed'; }
  }
  scores.context = contextScore;
  reasoning.context = contextReason;

  // --- AMBIGUITY ---
  var ambiguityScore = 0;
  var ambiguityReason = '';
  var vagueSignals = ['figure out', 'something like', 'maybe', 'not sure', 'explore', 'look into', 'what do you think'];
  var exactSignals = ['change X to Y', 'set', 'add line', 'remove', 'replace', 'update to'];
  var desc = taskDescription.toLowerCase();
  var vagueHits = vagueSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
  var exactHits = exactSignals.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
  if (vagueHits >= 2) { ambiguityScore = 3; ambiguityReason = 'Task needs scoping before execution'; }
  else if (vagueHits === 1) { ambiguityScore = 2; ambiguityReason = 'Some interpretation required'; }
  else if (exactHits > 0) { ambiguityScore = 0; ambiguityReason = 'Precisely defined task'; }
  else { ambiguityScore = 1; ambiguityReason = 'Reasonably clear'; }
  scores.ambiguity = ambiguityScore;
  reasoning.ambiguity = ambiguityReason;

  // --- VERIFICATION ---
  var verifyScore = 0;
  var verifyReason = '';
  var hardVerify = ['quality', 'tone', 'appropriate', 'best', 'optimal', 'creative', 'strategic', 'audit', 'review', 'consistent'];
  var easyVerify = ['works', 'runs', 'compiles', 'responds', 'returns', 'matches', 'equals'];
  var desc = taskDescription.toLowerCase();
  var hardHits = hardVerify.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
  var easyHits = easyVerify.filter(function(s) { return desc.indexOf(s) !== -1; }).length;
  if (hardHits >= 2) { verifyScore = 3; verifyReason = 'Output quality requires expert review'; }
  else if (hardHits === 1) { verifyScore = 2; verifyReason = 'Needs review to assess correctness'; }
  else if (easyHits > 0) { verifyScore = 0; verifyReason = 'Binary pass/fail verification'; }
  else { verifyScore = 1; verifyReason = 'Standard verification'; }
  scores.verification = verifyScore;
  reasoning.verification = verifyReason;

  // --- TOTAL + TIER ---
  var total = 0;
  var keys = Object.keys(scores);
  for (var i = 0; i < keys.length; i++) { total += scores[keys[i]]; }

  var tier = 'tier2';
  if (total <= 6) tier = 'tier1';
  else if (total >= 13) tier = 'tier3';

  var tierInfo = MODEL_TIERS[tier];

  return {
    task: taskDescription.substring(0, 200),
    total_score: total,
    max_possible: 18,
    tier: tier,
    tier_name: tierInfo.name,
    recommended_models: tierInfo.recommended_models,
    use_case_match: tierInfo.use_cases,
    cost_profile: tierInfo.cost_profile,
    dimensions: scores,
    reasoning: reasoning,
    cost_savings_estimate: tier === 'tier1' ? '~90% vs always-Opus' : tier === 'tier2' ? '~60% vs always-Opus' : 'Full Opus cost justified',
    meta: {
      classifier_version: '1.0.0',
      note: 'Scores are heuristic. Pass structured hints (files_involved, touches_protected, context_files, touches_production) for higher accuracy.'
    }
  };
}


// ============================================================
// INTENT PARSER + RESPONSE CALIBRATOR
// ============================================================

const INTENT_TYPES = {
  do_it: {
    name: 'Execute',
    signals: ['do', 'fix', 'build', 'create', 'make', 'deploy', 'restart', 'update', 'change', 'add', 'remove', 'set', 'install', 'run', 'send', 'write'],
    response_rule: 'Do the thing. Confirm when done. No explaining unless it failed.'
  },
  answer_me: {
    name: 'Quick Answer',
    signals: ['is', 'are', 'does', 'did', 'was', 'will', 'can', 'how many', 'what is', 'who is', 'when', 'where', 'which', 'status', 'check'],
    response_rule: 'Answer first. One sentence. Then offer detail only if needed.'
  },
  explain: {
    name: 'Explain',
    signals: ['why', 'how does', 'explain', 'what happens', 'tell me about', 'help me understand', 'walk me through', 'describe'],
    response_rule: 'Teach. Use the level they are at. Stop when the concept lands.'
  },
  decide: {
    name: 'Help Decide',
    signals: ['should', 'which', 'better', 'compare', 'versus', 'vs', 'recommend', 'suggest', 'opinion', 'what do you think', 'tradeoff'],
    response_rule: 'Give your recommendation with reasoning. Do not list 5 options and say it depends.'
  },
  validate: {
    name: 'Validate',
    signals: ['right', 'correct', 'does this look', 'am i', 'is this', 'make sense', 'sound good', 'on track', 'rate', 'review'],
    response_rule: 'Say yes or no first. Then explain what is wrong or right. Be direct.'
  },
  brainstorm: {
    name: 'Brainstorm',
    signals: ['ideas', 'what if', 'could we', 'imagine', 'explore', 'possibilities', 'creative', 'brainstorm', 'think about'],
    response_rule: 'Generate freely but stay grounded. Prioritize the top 2-3 ideas, not a long list.'
  },
  vent: {
    name: 'Vent/Process',
    signals: ['frustrated', 'annoyed', 'tired', 'sick of', 'cant believe', 'hate', 'waste', 'broken again', 'nothing works'],
    response_rule: 'Acknowledge briefly. Do not over-empathize. Then pivot to what you can actually do about it.'
  }
};

const URGENCY_SIGNALS = {
  high: {
    signals: ['now', 'asap', 'urgent', 'immediately', 'quick', 'fast', 'hurry', 'deadline', 'today', 'before', 'right now', 'emergency'],
    style: 'Shortest possible answer. No preamble. Action first.'
  },
  normal: {
    signals: [],
    style: 'Standard response. Clear and direct.'
  },
  exploratory: {
    signals: ['wondering', 'curious', 'sometime', 'eventually', 'thinking about', 'no rush', 'when you get a chance', 'long term'],
    style: 'Can be more detailed. Offer context and alternatives.'
  }
};

const EXPERTISE_SIGNALS = {
  expert: {
    signals: ['the', 'our', 'we', 'pipeline', 'endpoint', 'deploy', 'config', 'refactor', 'api', 'cron', 'pm2', 'proxy', 'prod'],
    style: 'Skip basics. Use technical terms. No hand-holding.'
  },
  intermediate: {
    signals: [],
    style: 'Explain non-obvious terms. Give context when introducing new concepts.'
  },
  beginner: {
    signals: ['what is', 'how do i', 'never used', 'new to', 'dont understand', 'confused', 'help me', 'first time', 'basics'],
    style: 'Define terms. Use analogies. Go step by step. Check understanding.'
  }
};

const RESPONSE_KILLERS = [
  { pattern: 'starting with certainly or of course or great question', fix: 'Just answer. No filler openers.' },
  { pattern: 'listing 5+ options without a recommendation', fix: 'Pick the best one. Say why. Mention alternatives briefly.' },
  { pattern: 'explaining what you are about to do before doing it', fix: 'Do it. Then say what you did.' },
  { pattern: 'repeating the question back', fix: 'They know what they asked. Answer it.' },
  { pattern: 'adding caveats and disclaimers unprompted', fix: 'If they did not ask about risks, do not lead with risks.' },
  { pattern: 'giving a history lesson before answering', fix: 'Answer first. Context second, only if relevant.' },
  { pattern: 'using bullet points for everything', fix: 'Use prose for simple answers. Bullets only when comparing multiple things.' },
  { pattern: 'asking do you want me to before doing something obvious', fix: 'If the intent is clear, just do it.' },
  { pattern: 'over-apologizing or excessive hedging', fix: 'Be direct. Say what you know and what you do not.' },
  { pattern: 'ending with let me know if you need anything else', fix: 'They will ask if they need more. Do not prompt them.' }
];

function parseIntent(userMessage, conversationContext) {
  var msg = userMessage.toLowerCase();
  var ctx = conversationContext || '';
  var result = {};

  // --- INTENT ---
  var intentScores = {};
  var types = Object.keys(INTENT_TYPES);
  for (var t = 0; t < types.length; t++) {
    var key = types[t];
    var signals = INTENT_TYPES[key].signals;
    var score = 0;
    for (var s = 0; s < signals.length; s++) {
      if (msg.indexOf(signals[s]) !== -1) score++;
    }
    if (score > 0) intentScores[key] = score;
  }
  var topIntent = 'answer_me';
  var topScore = 0;
  var intentKeys = Object.keys(intentScores);
  for (var i = 0; i < intentKeys.length; i++) {
    if (intentScores[intentKeys[i]] > topScore) {
      topScore = intentScores[intentKeys[i]];
      topIntent = intentKeys[i];
    }
  }
  result.intent = {
    type: topIntent,
    name: INTENT_TYPES[topIntent].name,
    confidence: topScore > 2 ? 'high' : topScore > 0 ? 'medium' : 'low',
    response_rule: INTENT_TYPES[topIntent].response_rule
  };

  // --- URGENCY ---
  var urgency = 'normal';
  var highSignals = URGENCY_SIGNALS.high.signals;
  var exploratorySignals = URGENCY_SIGNALS.exploratory.signals;
  for (var h = 0; h < highSignals.length; h++) {
    if (msg.indexOf(highSignals[h]) !== -1) { urgency = 'high'; break; }
  }
  if (urgency === 'normal') {
    for (var e = 0; e < exploratorySignals.length; e++) {
      if (msg.indexOf(exploratorySignals[e]) !== -1) { urgency = 'exploratory'; break; }
    }
  }
  // Short messages are usually urgent
  if (msg.split(' ').length <= 5 && urgency === 'normal') urgency = 'high';
  result.urgency = { level: urgency, style: URGENCY_SIGNALS[urgency].style };

  // --- EXPERTISE ---
  var expertise = 'intermediate';
  var expertHits = 0, beginnerHits = 0;
  for (var ex = 0; ex < EXPERTISE_SIGNALS.expert.signals.length; ex++) {
    if (msg.indexOf(EXPERTISE_SIGNALS.expert.signals[ex]) !== -1) expertHits++;
  }
  for (var bx = 0; bx < EXPERTISE_SIGNALS.beginner.signals.length; bx++) {
    if (msg.indexOf(EXPERTISE_SIGNALS.beginner.signals[bx]) !== -1) beginnerHits++;
  }
  if (beginnerHits > expertHits) expertise = 'beginner';
  else if (expertHits >= 2) expertise = 'expert';
  result.expertise = { level: expertise, style: EXPERTISE_SIGNALS[expertise].style };

  // --- RESPONSE FORMAT ---
  var format = 'standard';
  var wordCount = msg.split(' ').length;
  if (wordCount <= 3) format = 'one_line';
  else if (wordCount <= 8) format = 'short';
  else if (msg.indexOf('detail') !== -1 || msg.indexOf('comprehensive') !== -1 || msg.indexOf('thorough') !== -1 || msg.indexOf('everything') !== -1) format = 'detailed';
  else if (msg.indexOf('step') !== -1 || msg.indexOf('walkthrough') !== -1 || msg.indexOf('guide') !== -1) format = 'step_by_step';
  else if (msg.indexOf('code') !== -1 || msg.indexOf('script') !== -1 || msg.indexOf('command') !== -1) format = 'code_first';

  var formatGuide = {
    one_line: 'One sentence max. They asked a short question, give a short answer.',
    short: 'Two to three sentences. Get to the point.',
    standard: 'A few paragraphs if needed. Lead with the answer, then support.',
    detailed: 'Comprehensive response. Structure with sections if needed.',
    step_by_step: 'Numbered steps. Each step is one action.',
    code_first: 'Show the code or command first. Explain after only if asked.'
  };
  result.format = { type: format, guide: formatGuide[format] };

  // --- IMPLICIT ASK ---
  var implicit = null;
  if (msg.indexOf('what do you think') !== -1 || msg.indexOf('how do you feel') !== -1) {
    implicit = 'They want your actual opinion, not a balanced overview. Take a position.';
  } else if (msg.indexOf('does that make sense') !== -1 || msg.indexOf('right?') !== -1) {
    implicit = 'They want validation or correction. Be direct about which one.';
  } else if (msg.indexOf('i was thinking') !== -1 || msg.indexOf('my idea is') !== -1) {
    implicit = 'They want feedback on THEIR idea, not a new one. Evaluate what they proposed.';
  } else if (msg.indexOf('can you') !== -1 || msg.indexOf('could you') !== -1) {
    implicit = 'This is a request disguised as a question. Do it, do not ask if they want you to.';
  } else if (msg.indexOf('never mind') !== -1 || msg.indexOf('forget it') !== -1) {
    implicit = 'They are frustrated with the conversation. Acknowledge briefly, offer a fresh start.';
  }
  result.implicit_ask = implicit;

  // --- ANTI-PATTERNS TO AVOID ---
  var relevant_killers = [];
  if (result.urgency.level === 'high') {
    relevant_killers.push(RESPONSE_KILLERS[0]); // no filler openers
    relevant_killers.push(RESPONSE_KILLERS[2]); // no explaining before doing
    relevant_killers.push(RESPONSE_KILLERS[5]); // no history lessons
    relevant_killers.push(RESPONSE_KILLERS[7]); // no asking before doing
  }
  if (result.intent.type === 'do_it') {
    relevant_killers.push(RESPONSE_KILLERS[2]); // no explaining before doing
    relevant_killers.push(RESPONSE_KILLERS[7]); // no asking before doing
    relevant_killers.push(RESPONSE_KILLERS[9]); // no let me know
  }
  if (result.intent.type === 'answer_me') {
    relevant_killers.push(RESPONSE_KILLERS[3]); // no repeating question
    relevant_killers.push(RESPONSE_KILLERS[5]); // no history lesson
    relevant_killers.push(RESPONSE_KILLERS[0]); // no filler
  }
  if (result.intent.type === 'decide') {
    relevant_killers.push(RESPONSE_KILLERS[1]); // no listing without recommending
    relevant_killers.push(RESPONSE_KILLERS[4]); // no unprompted caveats
  }
  // Deduplicate
  var seen = {};
  var dedupedKillers = [];
  for (var k = 0; k < relevant_killers.length; k++) {
    var kp = relevant_killers[k].pattern;
    if (!seen[kp]) { seen[kp] = true; dedupedKillers.push(relevant_killers[k]); }
  }
  result.avoid = dedupedKillers;

  // --- RESPONSE DIRECTIVE (the single most important output) ---
  var directive = result.intent.response_rule;
  if (result.urgency.level === 'high') directive = 'URGENT: ' + directive;
  if (result.format.type === 'one_line') directive += ' Keep it to one line.';
  if (result.expertise.level === 'expert') directive += ' Skip basics.';
  if (result.expertise.level === 'beginner') directive += ' Define terms. Be patient.';
  if (result.implicit_ask) directive += ' NOTE: ' + result.implicit_ask;
  result.directive = directive;

  result.meta = {
    parser_version: '1.0.0',
    input_length: userMessage.length,
    input_words: wordCount,
    note: 'Use the directive field as a system prompt prefix for optimal response calibration.'
  };

  return result;
}

// MCP Protocol version
const MCP_VERSION = '2024-11-05';

// Server info
const SERVER_INFO = {
  name: 'nervous-system',
  version: '1.3.0'
};

// ============================================================
// THE NERVOUS SYSTEM - Content
// ============================================================

const FRAMEWORK = {
  name: 'The Nervous System',
  version: '1.3.0',
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
    context: 'Arthur Palyan runs a startup with 12 AI family members, each with distinct roles. The entire operation runs on a $12/month VPS with a $300/month LLM subscription.',
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
  // NEW: Task Complexity Classifier + Model Router
  {
    name: 'classify_task_complexity',
    annotations: { title: 'Task Complexity Classifier', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Analyzes a task description and returns a complexity score across 6 dimensions (scope, judgment, risk, context depth, ambiguity, verification difficulty). Recommends optimal model tier (Tier 1 fast/cheap, Tier 2 capable worker, Tier 3 deep reasoning). Use this before dispatching any task to route it to the right model. Pass optional structured hints for higher accuracy.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the task to classify.' },
        files_involved: { type: 'number', description: 'Optional: how many files will this task touch?' },
        touches_protected: { type: 'boolean', description: 'Optional: does this touch UNTOUCHABLE or protected files?' },
        touches_production: { type: 'boolean', description: 'Optional: does this affect live/production systems?' },
        context_files: { type: 'number', description: 'Optional: how many reference files/docs are needed for context?' }
      },
      required: ['task']
    }
  },
  // NEW: Intent Parser + Response Calibrator
  {
    name: 'parse_user_intent',
    annotations: { title: 'Intent Parser + Response Calibrator', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Analyzes what a user actually wants and how the response should be shaped. Returns: intent type (execute/answer/explain/decide/validate/brainstorm/vent), urgency level, expertise level, preferred format, implicit asks, anti-patterns to avoid, and a single directive string to guide the response. Use this before generating any response to ensure you deliver what the person actually needs, not what you think they need. The directive field can be used as a system prompt prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The user message to analyze.' },
        conversation_context: { type: 'string', description: 'Optional: recent conversation history for better intent detection.' }
      },
      required: ['message']
    }
  }
];

// Resource definitions
const RESOURCES = [
  { uri: 'nervous-system://framework', name: 'The Nervous System Framework', description: 'Complete behavioral enforcement framework for LLM management', mimeType: 'text/plain' },
  { uri: 'nervous-system://quick-start', name: 'Quick Start Guide', description: 'How to implement the nervous system in your own LLM deployment', mimeType: 'text/plain' },
  { uri: 'nervous-system://rules', name: 'The 7 Core Rules', description: 'All 7 behavioral rules with explanations and enforcement', mimeType: 'text/plain' },
  { uri: 'nervous-system://templates', name: 'Templates', description: 'Ready-to-use templates for handoffs, worklogs, preflight, and untouchable lists', mimeType: 'text/plain' }
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



    case 'parse_user_intent': {
      var result = parseUserIntent(args.raw_input, args.conversation_context);
      addAuditEntry('PARSE_INTENT', 'Parsed: ' + result.deliverable_count + ' deliverables, ' + result.ambiguity_flags.length + ' flags');
      return result;
    }

    case 'classify_task_complexity': {
      var hints = {};
      if (args.files_involved !== undefined) hints.files_involved = args.files_involved;
      if (args.touches_protected !== undefined) hints.touches_protected = args.touches_protected;
      if (args.touches_production !== undefined) hints.touches_production = args.touches_production;
      if (args.context_files !== undefined) hints.context_files = args.context_files;
      var result = classifyTaskComplexity(args.task, hints);
      addAuditEntry('CLASSIFY', 'Task classified: score=' + result.total_score + ' tier=' + result.tier + ' task=' + args.task.substring(0, 80));
      return result;
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
    res.end(JSON.stringify({ status: 'ok', service: 'nervous-system-mcp', version: '1.3.0', protocol: MCP_VERSION }));
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
      version: '1.3.0',
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
  console.error(`[MCP Server] Nervous System v1.1.0 running on port ${PORT}`);
  console.error(`[MCP Server] SSE: /sse | HTTP: /mcp | Health: /health | Kill: POST /kill | Audit: GET /audit/verify | Dispatches: GET /dispatches`);
  console.error(`[MCP Server] Protocol: ${MCP_VERSION}`);
  console.error(`[MCP Server] Tools: ${TOOLS.length} (including kill switch, audit chain, dispatch)`);
});
