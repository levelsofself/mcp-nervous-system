/**
 * Nervous System Connector for Hivemind
 *
 * Integrates NS governance into Hivemind's team chat agent system.
 * Intercepts tool calls for preflight checks, runs drift audits
 * on heartbeat, and writes session handoffs.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class NervousSystemConnector {
  constructor(config = {}) {
    this.nsUrl = config.url || 'http://localhost:3475';
    this.configPath = config.config_path || './nervous-system.config.json';
    this.nsConfig = this._loadConfig();
    this.untouchableFiles = this._loadUntouchableList();
    this.agentTurnCounts = new Map();
    this.sessionViolations = [];
  }

  /**
   * Called by Hivemind when the connector is initialized.
   */
  async initialize(hivemind) {
    this.hivemind = hivemind;

    // Register tool interceptors
    hivemind.interceptTool('shell', (args, agent) => this.interceptShell(args, agent));
    hivemind.interceptTool('file_edit', (args, agent) => this.interceptFileEdit(args, agent));
    hivemind.interceptTool('file_create', (args, agent) => this.interceptFileEdit(args, agent));

    // Register heartbeat handler
    hivemind.onHeartbeat(() => this.heartbeatCheck());

    // Register session hooks
    hivemind.onSessionEnd((session) => this.sessionHandoff(session));

    // Register agent turn tracking
    hivemind.onAgentTurn((agent) => this.trackTurn(agent));

    console.log('[NS] Nervous System governance active for Hivemind. ' +
      this.untouchableFiles.length + ' files protected.');

    return { status: 'ok', protected_files: this.untouchableFiles.length };
  }

  /**
   * Intercept shell commands - check for file modifications.
   */
  interceptShell(args, agent) {
    const cmd = args.command || '';

    // Extract file paths from common write commands
    const writePatterns = [
      />\s*(\S+)/,           // redirect: > file
      /tee\s+(\S+)/,         // tee file
      /cp\s+\S+\s+(\S+)/,   // cp src dest
      /mv\s+\S+\s+(\S+)/,   // mv src dest
      /rm\s+(-rf?\s+)?(\S+)/ // rm file
    ];

    for (const pattern of writePatterns) {
      const match = cmd.match(pattern);
      if (match) {
        const targetFile = match[match.length - 1];
        const result = this._checkFile(targetFile, agent);
        if (result !== 'OK') {
          return { blocked: true, reason: result + ': ' + targetFile };
        }
      }
    }

    return { blocked: false };
  }

  /**
   * Intercept file edit/create - preflight check.
   */
  interceptFileEdit(args, agent) {
    const filePath = args.file || args.path || args.file_path || '';
    const result = this._checkFile(filePath, agent);

    if (result !== 'OK') {
      return { blocked: true, reason: result + ': ' + filePath };
    }

    return { blocked: false };
  }

  /**
   * Heartbeat check - runs drift audit and page health.
   * Called by Hivemind's autonomous heartbeat cycle.
   */
  async heartbeatCheck() {
    const results = {};

    // Run drift audit
    try {
      results.drift = this._callNSTool('drift_audit', { scope: 'full' });
    } catch (err) {
      results.drift = { error: err.message };
    }

    // Run page health if configured
    if (this.nsConfig.html_pages && this.nsConfig.html_pages.length > 0) {
      try {
        results.health = this._callNSTool('page_health', {});
      } catch (err) {
        results.health = { error: err.message };
      }
    }

    // Post results to team chat
    if (this.hivemind) {
      this.hivemind.postToChat({
        from: 'nervous-system',
        type: 'heartbeat_report',
        results: results,
        violations_since_last: this.sessionViolations.length,
        timestamp: new Date().toISOString()
      });
    }

    return results;
  }

  /**
   * Track agent turns for step_back reflection.
   */
  trackTurn(agent) {
    const agentId = agent.id || agent.name;
    const count = (this.agentTurnCounts.get(agentId) || 0) + 1;
    this.agentTurnCounts.set(agentId, count);

    if (count % 4 === 0) {
      // Inject reflection into agent's context
      this.hivemind.injectMessage(agentId, {
        from: 'nervous-system',
        type: 'step_back',
        message: 'STEP BACK CHECK (turn ' + count + '): ' +
          'Are you solving the real problem? ' +
          'Are you still aligned with the original task? ' +
          'Report your assessment to the team.'
      });
    }
  }

  /**
   * Session handoff - writes context when session ends.
   */
  sessionHandoff(session) {
    const handoff = {
      timestamp: new Date().toISOString(),
      team: session.team || 'default',
      agents: session.agents || [],
      messages_exchanged: session.message_count || 0,
      tasks_completed: session.tasks_completed || [],
      tasks_pending: session.tasks_pending || [],
      violations: this.sessionViolations.length,
      violation_details: this.sessionViolations
    };

    const handoffPath = path.join(
      this.nsConfig.data_dir || '.',
      'SESSION_HANDOFF.md'
    );

    const md = '# Session Handoff - ' + handoff.timestamp + '\n\n' +
      '## Team: ' + handoff.team + '\n\n' +
      '## Agents\n' + handoff.agents.map(a => '- ' + a).join('\n') + '\n\n' +
      '## Messages: ' + handoff.messages_exchanged + '\n\n' +
      '## Completed\n' + handoff.tasks_completed.map(t => '- ' + t).join('\n') + '\n\n' +
      '## Pending\n' + handoff.tasks_pending.map(t => '- ' + t).join('\n') + '\n\n' +
      '## Violations: ' + handoff.violations + '\n';

    try {
      fs.writeFileSync(handoffPath, md);
      console.log('[NS] Session handoff written.');
    } catch (e) {
      console.error('[NS] Failed to write handoff:', e.message);
    }

    // Reset session state
    this.sessionViolations = [];
    this.agentTurnCounts.clear();
  }

  // -- Internal helpers --

  _checkFile(filePath, agent) {
    const resolved = path.resolve(filePath);

    for (const pattern of this.untouchableFiles) {
      if (resolved === path.resolve(pattern) || resolved.endsWith(pattern)) {
        const violation = {
          timestamp: new Date().toISOString(),
          type: 'BLOCKED',
          agent: agent.name || agent.id || 'unknown',
          file: resolved
        };
        this.sessionViolations.push(violation);
        this._logViolation(violation);
        return 'BLOCKED';
      }
    }

    return 'OK';
  }

  _callNSTool(toolName, args) {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });

    const result = execSync(
      'curl -s ' + this.nsUrl + '/mcp -X POST ' +
      '-H "Content-Type: application/json" ' +
      "-d '" + payload + "'",
      { timeout: 30000, encoding: 'utf8' }
    );

    return JSON.parse(result);
  }

  _loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  _loadUntouchableList() {
    const listPath = this.nsConfig.protected_files_list || 'untouchable-files.txt';
    try {
      return fs.readFileSync(listPath, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    } catch (e) {
      return [];
    }
  }

  _logViolation(violation) {
    const logPath = this.nsConfig.logs_dir
      ? path.join(this.nsConfig.logs_dir, 'guardrail-violations.log')
      : 'guardrail-violations.log';

    const line = violation.timestamp + ' ' + violation.type +
      ': agent=' + violation.agent + ' file=' + violation.file + '\n';

    try { fs.appendFileSync(logPath, line); } catch (e) {}
  }
}

module.exports = NervousSystemConnector;
