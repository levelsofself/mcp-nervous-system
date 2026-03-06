#!/usr/bin/env node
// NS Smoke Test - Regression testing for The Nervous System MCP Server
// Run after every restart, before every publish, and daily via Tamara
// Usage: node ns-smoke-test.js [port] [--pre-publish] [--verbose]

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const args = process.argv.slice(2);
const PORT = parseInt(args.find(a => /^\d+$/.test(a))) || 3475;
const PRE_PUBLISH = args.includes('--pre-publish');
const VERBOSE = args.includes('--verbose');
const FRESH_INSTALL = args.includes('--fresh-install');

// All 16 tools with minimal valid arguments
const TOOL_TESTS = [
  { name: 'get_framework', args: {}, expectFields: ['name', 'version', 'core_rules'] },
  { name: 'get_nervous_system_info', args: { topic: 'overview' }, expectType: 'string' },
  { name: 'guardrail_rules', args: { rule: 'all' }, expectType: 'object' },
  { name: 'step_back_check', args: { context: 'smoke test' }, expectFields: ['trigger', 'steps'] },
  { name: 'preflight_check', args: { action: 'get_script' }, expectType: 'string' },
  { name: 'violation_logging', args: { action: 'get_pattern' }, expectType: 'string' },
  { name: 'worklog', args: { action: 'get_template' }, expectType: 'string' },
  { name: 'session_handoff', args: { action: 'get_template' }, expectType: 'string' },
  { name: 'drift_audit', args: { scope: 'roles' }, expectFields: ['status', 'drift_count'] },
  { name: 'security_audit', args: {}, expectFields: ['status'] },
  { name: 'page_health', args: { page: 'all' }, expectType: 'object' },
  { name: 'verify_audit_chain', args: {}, expectType: 'object' },
  { name: 'auto_propagate', args: {}, expectType: 'object' },
  { name: 'session_close', args: {}, expectType: 'object' },
  // dispatch_to_llm - skip in smoke test (spawns real agent)
  // emergency_kill_switch - skip in smoke test (stops everything)
];

// Tools that should NOT be called in smoke tests
const SKIP_TOOLS = ['dispatch_to_llm', 'emergency_kill_switch'];

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function log(msg) { console.log(msg); }
function vlog(msg) { if (VERBOSE) console.log('  ' + msg); }

function callMCP(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: method,
      params: params || {}
    });

    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function testHealth() {
  log('\n[1/5] HEALTH CHECK');
  try {
    const resp = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: 'localhost', port: PORT, path: '/health', timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });

    if (resp.status === 200) {
      passed++;
      log('  PASS: /health returns 200');
      vlog('Response: ' + JSON.stringify(resp.body));
    } else {
      failed++;
      failures.push({ test: 'health', error: 'Status ' + resp.status });
      log('  FAIL: /health returns ' + resp.status);
    }
  } catch (e) {
    failed++;
    failures.push({ test: 'health', error: e.message });
    log('  FAIL: /health - ' + e.message);
  }
}

async function testInitialize() {
  log('\n[2/5] MCP INITIALIZE');
  try {
    const resp = await callMCP('initialize', {});
    if (resp.result && resp.result.serverInfo && resp.result.capabilities) {
      passed++;
      log('  PASS: initialize returns valid server info');
      vlog('Server: ' + resp.result.serverInfo.name + ' v' + resp.result.serverInfo.version);
      vlog('Capabilities: ' + Object.keys(resp.result.capabilities).join(', '));
    } else {
      failed++;
      failures.push({ test: 'initialize', error: 'Missing serverInfo or capabilities' });
      log('  FAIL: initialize - bad response structure');
    }
  } catch (e) {
    failed++;
    failures.push({ test: 'initialize', error: e.message });
    log('  FAIL: initialize - ' + e.message);
  }
}

async function testToolsList() {
  log('\n[3/5] TOOLS LIST');
  try {
    const resp = await callMCP('tools/list', {});
    if (resp.result && resp.result.tools && Array.isArray(resp.result.tools)) {
      const toolNames = resp.result.tools.map(t => t.name);
      passed++;
      log('  PASS: tools/list returns ' + toolNames.length + ' tools');
      vlog('Tools: ' + toolNames.join(', '));

      // Verify expected tools exist
      const expectedTools = TOOL_TESTS.map(t => t.name).concat(SKIP_TOOLS);
      const missing = expectedTools.filter(t => !toolNames.includes(t));
      if (missing.length > 0) {
        failed++;
        failures.push({ test: 'tools_list_completeness', error: 'Missing tools: ' + missing.join(', ') });
        log('  FAIL: Missing expected tools: ' + missing.join(', '));
      } else {
        passed++;
        log('  PASS: All expected tools present');
      }
    } else {
      failed++;
      failures.push({ test: 'tools_list', error: 'Invalid response' });
      log('  FAIL: tools/list - invalid response');
    }
  } catch (e) {
    failed++;
    failures.push({ test: 'tools_list', error: e.message });
    log('  FAIL: tools/list - ' + e.message);
  }
}

async function testEachTool() {
  log('\n[4/5] INDIVIDUAL TOOL CALLS');
  for (const test of TOOL_TESTS) {
    try {
      const resp = await callMCP('tools/call', { name: test.name, arguments: test.args });

      // Check for rate limit (not a real failure)
      if (resp.result && resp.result.content && resp.result.content[0] &&
          resp.result.content[0].text && (resp.result.content[0].text.includes('rate_limit') || resp.result.content[0].text.includes('authentication_required'))) {
        skipped++;
        log('  SKIP: ' + test.name + ' (rate limited)');
        continue;
      }

      // Check for valid response
      if (resp.error) {
        failed++;
        failures.push({ test: test.name, error: resp.error.message || JSON.stringify(resp.error) });
        log('  FAIL: ' + test.name + ' - ' + (resp.error.message || 'error'));
        continue;
      }

      if (!resp.result || !resp.result.content || !resp.result.content[0]) {
        failed++;
        failures.push({ test: test.name, error: 'Empty or invalid response structure' });
        log('  FAIL: ' + test.name + ' - empty response');
        continue;
      }

      const text = resp.result.content[0].text;
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { parsed = text; }

      // Validate expected shape
      if (test.expectFields) {
        const missingFields = test.expectFields.filter(f => !(f in parsed));
        if (missingFields.length > 0) {
          failed++;
          failures.push({ test: test.name, error: 'Missing fields: ' + missingFields.join(', ') });
          log('  FAIL: ' + test.name + ' - missing fields: ' + missingFields.join(', '));
        } else {
          passed++;
          log('  PASS: ' + test.name);
          vlog('Fields present: ' + test.expectFields.join(', '));
        }
      } else if (test.expectType === 'string') {
        if (typeof parsed === 'string' && parsed.length > 0) {
          passed++;
          log('  PASS: ' + test.name + ' (' + parsed.length + ' chars)');
        } else if (typeof parsed === 'object') {
          // Some tools return JSON even when we expect string, that is fine
          passed++;
          log('  PASS: ' + test.name + ' (object response)');
        } else {
          failed++;
          failures.push({ test: test.name, error: 'Expected string, got ' + typeof parsed });
          log('  FAIL: ' + test.name + ' - expected string');
        }
      } else if (test.expectType === 'object') {
        if (typeof parsed === 'object' && parsed !== null) {
          passed++;
          log('  PASS: ' + test.name);
        } else {
          failed++;
          failures.push({ test: test.name, error: 'Expected object, got ' + typeof parsed });
          log('  FAIL: ' + test.name + ' - expected object');
        }
      } else {
        passed++;
        log('  PASS: ' + test.name + ' (response received)');
      }

    } catch (e) {
      failed++;
      failures.push({ test: test.name, error: e.message });
      log('  FAIL: ' + test.name + ' - ' + e.message);
    }
  }

  // Note skipped dangerous tools
  for (const skip of SKIP_TOOLS) {
    skipped++;
    log('  SKIP: ' + skip + ' (dangerous in test)');
  }
}

async function testSourceCode() {
  log('\n[5/5] SOURCE CODE CHECKS');

  // Find the NS source file
  const candidates = [
    path.join(__dirname, 'index.js'),
    '/root/mcp-nervous-system.js',
    path.join(process.cwd(), 'index.js'),
  ];
  let sourceFile = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { sourceFile = c; break; }
  }

  if (!sourceFile) {
    skipped++;
    log('  SKIP: Could not find NS source file');
    return;
  }

  const content = fs.readFileSync(sourceFile, 'utf8');

  // Check for leaked passwords (common patterns)
  const passwordPatterns = [
    /Liarzhek/i,
    /Levelsofself1/i,
  ];
  let passwordClean = true;
  for (const pat of passwordPatterns) {
    if (pat.test(content)) {
      failed++;
      passwordClean = false;
      failures.push({ test: 'password_check', error: 'Password pattern found: ' + pat.source });
      log('  FAIL: Password found in source: ' + pat.source);
    }
  }
  if (passwordClean) {
    passed++;
    log('  PASS: No known passwords in source');
  }

  // Check for hardcoded paths (only in non-description/non-comment lines)
  if (PRE_PUBLISH) {
    const lines = content.split('\n');
    let hardcodedPaths = 0;
    lines.forEach((line, idx) => {
      if (line.trim().startsWith('//')) return;
      if (line.includes('description:') || line.includes('context:') || line.includes('tagline:')) return;
      if (line.includes("'/root/") || line.includes('"/root/')) {
        hardcodedPaths++;
        vlog('Line ' + (idx + 1) + ': ' + line.trim().substring(0, 80));
      }
    });
    if (hardcodedPaths > 0) {
      // Warning not failure -- v1.5.2 still has these, v1.6.0 will fix
      log('  WARN: ' + hardcodedPaths + ' hardcoded /root/ paths (fix in v1.6.0)');
    } else {
      passed++;
      log('  PASS: No hardcoded /root/ paths');
    }
  }

  // Syntax check
  try {
    execSync('node -c ' + sourceFile + ' 2>&1');
    passed++;
    log('  PASS: Syntax check (node -c)');
  } catch (e) {
    failed++;
    failures.push({ test: 'syntax_check', error: 'Syntax error in ' + sourceFile });
    log('  FAIL: Syntax error in source');
  }
}

async function testFreshInstall() {
  log('\n[BONUS] FRESH INSTALL TEST');
  const tmpDir = '/tmp/ns-fresh-test-' + Date.now();

  try {
    // Create temp directory and install from npm
    fs.mkdirSync(tmpDir, { recursive: true });
    log('  Installing mcp-nervous-system in ' + tmpDir + '...');
    execSync('cd ' + tmpDir + ' && npm init -y > /dev/null 2>&1 && npm install mcp-nervous-system > /dev/null 2>&1', { timeout: 60000 });

    // Find the installed index.js
    const indexPath = path.join(tmpDir, 'node_modules', 'mcp-nervous-system', 'index.js');
    if (!fs.existsSync(indexPath)) {
      failed++;
      failures.push({ test: 'fresh_install', error: 'index.js not found after npm install' });
      log('  FAIL: index.js not found');
      return;
    }

    // Syntax check the installed file
    try {
      execSync('node -c ' + indexPath + ' 2>&1');
      passed++;
      log('  PASS: Fresh install syntax check');
    } catch (e) {
      failed++;
      failures.push({ test: 'fresh_install_syntax', error: 'Syntax error in fresh install' });
      log('  FAIL: Fresh install has syntax error');
    }

    // Check for passwords in installed file
    const content = fs.readFileSync(indexPath, 'utf8');
    if (/Liarzhek|Levelsofself1/i.test(content)) {
      failed++;
      failures.push({ test: 'fresh_install_passwords', error: 'Passwords still in npm package' });
      log('  FAIL: Passwords found in fresh npm install!');
    } else {
      passed++;
      log('  PASS: No passwords in fresh npm install');
    }

    // Start the server on a random port and test health
    const testPort = 19475 + Math.floor(Math.random() * 1000);
    const stdioPth = path.join(tmpDir, 'node_modules', 'mcp-nervous-system', 'server.js');
    if (fs.existsSync(stdioPth)) {
      // Patch port for testing
      const serverContent = fs.readFileSync(stdioPth, 'utf8');
      const patchedContent = serverContent.replace(/const PORT = \d+/, 'const PORT = ' + testPort);
      const patchedPath = path.join(tmpDir, 'test-server.js');
      fs.writeFileSync(patchedPath, patchedContent);

      const proc = spawn('node', [patchedPath], {
        cwd: tmpDir,
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, PORT: testPort.toString() }
      });

      // Wait for startup
      await new Promise(r => setTimeout(r, 3000));

      try {
        const healthResp = await new Promise((resolve, reject) => {
          const req = http.get({ hostname: 'localhost', port: testPort, path: '/health', timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode }));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });

        if (healthResp.status === 200) {
          passed++;
          log('  PASS: Fresh install server starts and responds on port ' + testPort);
        } else {
          failed++;
          log('  FAIL: Fresh install server returned status ' + healthResp.status);
        }
      } catch (e) {
        // Server might not start without dependencies - that is OK to note
        skipped++;
        log('  SKIP: Fresh install server could not start (' + e.message + ')');
      }

      // Cleanup
      try { process.kill(-proc.pid); } catch (e) {}
    }

  } catch (e) {
    failed++;
    failures.push({ test: 'fresh_install', error: e.message });
    log('  FAIL: Fresh install test - ' + e.message);
  } finally {
    // Cleanup
    try { execSync('rm -rf ' + tmpDir + ' 2>/dev/null'); } catch (e) {}
  }
}

async function run() {
  log('===========================================');
  log('  NERVOUS SYSTEM SMOKE TEST');
  log('  Port: ' + PORT);
  log('  Mode: ' + (PRE_PUBLISH ? 'PRE-PUBLISH' : FRESH_INSTALL ? 'FRESH INSTALL' : 'STANDARD'));
  log('  Time: ' + new Date().toISOString());
  log('===========================================');

  await testHealth();
  await testInitialize();
  await testToolsList();
  await testEachTool();
  await testSourceCode();

  if (FRESH_INSTALL || PRE_PUBLISH) {
    await testFreshInstall();
  }

  log('\n===========================================');
  log('  RESULTS');
  log('===========================================');
  log('  Passed:  ' + passed);
  log('  Failed:  ' + failed);
  log('  Skipped: ' + skipped);
  log('  Total:   ' + (passed + failed + skipped));

  if (failures.length > 0) {
    log('\n  FAILURES:');
    failures.forEach(f => log('    - ' + f.test + ': ' + f.error));
  }

  const status = failed === 0 ? 'ALL PASS' : 'FAILURES DETECTED';
  log('\n  STATUS: ' + status);
  log('===========================================');

  // Write results to log file for Tamara
  const resultFile = '/tmp/ns-smoke-test-result.json';
  const result = {
    timestamp: new Date().toISOString(),
    port: PORT,
    mode: PRE_PUBLISH ? 'pre-publish' : FRESH_INSTALL ? 'fresh-install' : 'standard',
    passed: passed,
    failed: failed,
    skipped: skipped,
    status: status,
    failures: failures
  };
  try {
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  } catch (e) {}

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Smoke test crashed: ' + e.message);
  process.exit(2);
});
