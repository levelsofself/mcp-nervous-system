/**
 * Nervous System Plugin for Ruflo (claude-flow)
 *
 * Hooks NS governance into Ruflo's Queen-Worker hive mind.
 * Every worker file edit goes through preflight_check.
 * Queen triggers drift_audit on health check cycles.
 * Violations log to both NS audit chain and Ruflo swarm_state.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class NervousSystemPlugin {
  constructor(config = {}) {
    this.configPath = config.config_path || './nervous-system.config.json';
    this.nsConfig = this._loadConfig();
    this.untouchableFiles = this._loadUntouchableList();
    this.workerTurnCount = new Map(); // track turns per worker for step_back
    this.violations = [];
  }

  // -- Ruflo plugin lifecycle hooks --

  /**
   * Called by Ruflo when the plugin is loaded.
   * Registers hooks into the Queen and Worker pipelines.
   */
  onLoad(ruflo) {
    this.ruflo = ruflo;

    // Hook into worker file operations
    ruflo.on('worker:before_file_edit', (event) => this.preflightCheck(event));
    ruflo.on('worker:before_file_create', (event) => this.preflightCheck(event));
    ruflo.on('worker:before_file_delete', (event) => this.preflightCheck(event));

    // Hook into worker turn cycle for step_back
    ruflo.on('worker:turn_complete', (event) => this.stepBackCheck(event));

    // Hook into Queen health check for drift audit
    ruflo.on('queen:health_check', () => this.driftAudit());

    // Hook into session end for handoff
    ruflo.on('queen:session_end', (event) => this.sessionHandoff(event));

    console.log('[NS] Nervous System governance active. ' +
      this.untouchableFiles.length + ' files protected.');
  }

  /**
   * Preflight check - runs before any worker edits a file.
   * Returns BLOCKED, PROTECTED, or OK.
   */
  preflightCheck(event) {
    const filePath = path.resolve(event.file);

    // Check against untouchable list
    for (const pattern of this.untouchableFiles) {
      if (filePath === path.resolve(pattern) || filePath.endsWith(pattern)) {
        const violation = {
          timestamp: new Date().toISOString(),
          type: 'BLOCKED',
          worker: event.worker_id || 'unknown',
          file: filePath,
          action: event.action || 'edit'
        };

        this.violations.push(violation);
        this._logViolation(violation);
        this._writeToSwarmState(violation);

        // Block the edit
        event.cancel('BLOCKED by Nervous System: ' + filePath + ' is UNTOUCHABLE');
        return 'BLOCKED';
      }
    }

    // Check protected files (need human approval)
    if (this.nsConfig.protected_files && this.nsConfig.protected_files.includes(filePath)) {
      event.cancel('PROTECTED by Nervous System: ' + filePath + ' needs human approval');
      return 'PROTECTED';
    }

    return 'OK';
  }

  /**
   * Step back check - every 4 worker turns, force reflection.
   */
  stepBackCheck(event) {
    const workerId = event.worker_id;
    const count = (this.workerTurnCount.get(workerId) || 0) + 1;
    this.workerTurnCount.set(workerId, count);

    if (count % 4 === 0) {
      // Send reflection prompt to worker via Ruflo's message system
      this.ruflo.sendToWorker(workerId, {
        type: 'ns_reflection',
        message: 'STEP BACK CHECK (turn ' + count + '): ' +
          'Are you solving the real problem? ' +
          'Are you still aligned with the original objective? ' +
          'Should this be escalated to the Queen?'
      });
    }
  }

  /**
   * Drift audit - Queen triggers this on health check cycle.
   * Calls NS drift_audit and returns results to Queen.
   */
  driftAudit() {
    try {
      const result = execSync(
        'curl -s http://localhost:3475/mcp -X POST -H "Content-Type: application/json" ' +
        '-d \'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"drift_audit","arguments":{"scope":"full"}}}\'',
        { timeout: 30000, encoding: 'utf8' }
      );

      const parsed = JSON.parse(result);
      const driftResults = parsed.result || parsed;

      // Report to Queen
      this.ruflo.reportToQueen({
        type: 'ns_drift_audit',
        results: driftResults,
        timestamp: new Date().toISOString()
      });

      return driftResults;
    } catch (err) {
      console.error('[NS] Drift audit failed:', err.message);
      return { error: err.message };
    }
  }

  /**
   * Session handoff - writes context preservation document
   * when Queen session ends.
   */
  sessionHandoff(event) {
    const handoff = {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      workers_used: event.workers || [],
      tasks_completed: event.tasks_completed || [],
      tasks_pending: event.tasks_pending || [],
      violations_this_session: this.violations.length,
      swarm_state_snapshot: event.swarm_state || {},
      next_steps: event.next_steps || 'Review pending tasks'
    };

    const handoffPath = path.join(
      this.nsConfig.data_dir || '.',
      'SESSION_HANDOFF.md'
    );

    const md = '# Session Handoff - ' + handoff.timestamp + '\n\n' +
      '## Session: ' + handoff.session_id + '\n\n' +
      '## Workers Used\n' + handoff.workers_used.map(w => '- ' + w).join('\n') + '\n\n' +
      '## Tasks Completed\n' + handoff.tasks_completed.map(t => '- ' + t).join('\n') + '\n\n' +
      '## Tasks Pending\n' + handoff.tasks_pending.map(t => '- ' + t).join('\n') + '\n\n' +
      '## Violations: ' + handoff.violations_this_session + '\n\n' +
      '## Next Steps\n' + handoff.next_steps + '\n';

    fs.writeFileSync(handoffPath, md);
    console.log('[NS] Session handoff written to ' + handoffPath);
  }

  /**
   * Kill switch - accessible from Queen agent.
   * Stops all PM2 processes and logs to audit chain.
   */
  killSwitch(secret) {
    try {
      const result = execSync(
        'curl -s http://localhost:3475/kill -X POST -H "Content-Type: application/json" ' +
        '-d \'{"secret":"' + secret + '"}\'',
        { timeout: 10000, encoding: 'utf8' }
      );
      return JSON.parse(result);
    } catch (err) {
      return { error: err.message };
    }
  }

  // -- Internal helpers --

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

    const line = violation.timestamp + ' ' + violation.type + ': ' +
      'worker=' + violation.worker + ' file=' + violation.file +
      ' action=' + violation.action + '\n';

    try { fs.appendFileSync(logPath, line); } catch (e) {}
  }

  _writeToSwarmState(violation) {
    // Write to Ruflo's swarm_state table
    if (this.ruflo && this.ruflo.swarmState) {
      this.ruflo.swarmState.insert('ns_violations', violation);
    }
  }
}

module.exports = NervousSystemPlugin;
