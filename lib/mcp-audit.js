'use strict';
// mcp-audit.js - deterministic governance lint for MCP server configurations.
// Zero deps, pure Node. Powers the paid POST /audit-mcp SKU in x402-app.js.
//
//   auditMcpConfig(input) -> { score:0-100, findings:[...], summary:{...} }   (never throws)
//   Malformed input                       -> { error, hint }  (no throw)
//
// Input is PARSED JSON, either:
//   Claude-Desktop shape  { "mcpServers": { "<name>": {command,args,env,...} } }
//   or a single server    { command, args, env, ... }
//
// Each finding: { severity:'error'|'warn'|'info', code, server, message, hint }
// Score: start 100; -25 per error, -10 per warn, -2 per info; floor 0.

// Recognized keys (typo detection). Anything else -> UNKNOWN_TOP_FIELDS (info).
const KNOWN_TOP_KEYS = new Set(['mcpServers']);
const KNOWN_SERVER_KEYS = new Set([
  'command', 'args', 'env', 'url', 'transport', 'type', 'cwd', 'name',
  'disabled', 'enabled', 'autoApprove', 'alwaysAllow', 'timeout', 'headers', 'description'
]);
// Flags that consume the following token as their value (so it is NOT the docker image / package).
const VALUE_FLAGS = new Set([
  '-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '-w', '--workdir',
  '--network', '-u', '--user', '--mount', '--label', '-l', '--entrypoint'
]);

function baseName(cmd) {
  if (typeof cmd !== 'string') return '';
  const parts = cmd.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1].toLowerCase();
}

function isEnvRef(v) {
  // ${VAR} / $VAR / plain reference -> not an inline secret.
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(String(v).trim());
}

function looksHighEntropy(v) {
  // 20+ chars, token-like charset, mixes letters AND digits -> probably a real credential.
  return v.length >= 20 && /^[A-Za-z0-9+/=_.\-]{20,}$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

function firstNonFlagArg(args) {
  for (const a of args) { if (typeof a === 'string' && !a.startsWith('-')) return a; }
  return null;
}

// Best-effort docker image extraction: first bare token after `run`, skipping flags + their values.
function dockerImage(args) {
  const i = args.indexOf('run');
  if (i < 0) return null;
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) j++; continue; } // skip flag (and its value)
    return a; // first bare token = the image reference
  }
  return null;
}

function checkServer(name, srv, findings) {
  const push = (severity, code, message, hint) => findings.push({ severity, code, server: name, message, hint });
  if (!srv || typeof srv !== 'object' || Array.isArray(srv)) {
    push('info', 'UNKNOWN_TOP_FIELDS', 'server entry is not an object', 'Each server must map to an object with command/url + args/env.');
    return;
  }
  const args = Array.isArray(srv.args) ? srv.args : [];
  const cmd = baseName(srv.command);

  // Unknown server-level keys (typo detection).
  for (const k of Object.keys(srv)) {
    if (!KNOWN_SERVER_KEYS.has(k)) {
      push('info', 'UNKNOWN_TOP_FIELDS', 'unrecognized server field "' + k + '"', 'Check for a typo; expected command/args/env/url/type.');
    }
  }

  // SECRET_IN_ENV (error)
  if (srv.env && typeof srv.env === 'object' && !Array.isArray(srv.env)) {
    for (const [k, v] of Object.entries(srv.env)) {
      if (typeof v !== 'string' || v.length === 0 || isEnvRef(v)) continue;
      const keyMatch = /key|token|secret|password|passwd|pwd|credential|apikey|auth|access[_-]?id|private/i.test(k);
      if (keyMatch) {
        push('error', 'SECRET_IN_ENV', 'env "' + k + '" appears to hold an inline credential', 'Reference a secret via ${ENV_VAR} or a secret manager; never inline credentials.');
      } else if (looksHighEntropy(v)) {
        push('error', 'SECRET_IN_ENV', 'env "' + k + '" holds a high-entropy value that looks like a secret', 'Reference a secret via ${ENV_VAR} or a secret manager; never inline credentials.');
      }
    }
  }

  // SHELL_WRAPPER (warn) - sh/bash/zsh -c hides the real binary
  if ((cmd === 'sh' || cmd === 'bash' || cmd === 'zsh') && args.some((a) => a === '-c')) {
    push('warn', 'SHELL_WRAPPER', 'command wraps the real binary in ' + cmd + ' -c', 'Invoke the real binary directly instead of wrapping in a shell.');
  }

  // UNPINNED_PACKAGE (warn) + AUTO_INSTALL_FLAG (warn) for npx/uvx/bunx-style runners
  if (cmd === 'npx' || cmd === 'uvx' || cmd === 'bunx' || cmd === 'pnpm' || cmd === 'yarn') {
    const pkg = firstNonFlagArg(args);
    if (pkg) {
      const body = pkg.startsWith('@') ? pkg.slice(1) : pkg; // strip scope so @scope/x isn't read as a pin
      if (!body.includes('@')) {
        push('warn', 'UNPINNED_PACKAGE', 'package "' + pkg + '" is not version-pinned', 'Pin the version (name@1.2.3) to prevent supply-chain drift.');
      }
    }
    if (args.some((a) => a === '-y' || a === '--yes')) {
      push('warn', 'AUTO_INSTALL_FLAG', cmd + ' auto-installs unreviewed code (-y/--yes)', 'Remove -y/--yes; review packages before first execution.');
    }
  }

  // BROAD_FS_SCOPE (warn) - filesystem servers granted / or a home root
  const joined = (srv.command ? srv.command + ' ' : '') + args.join(' ');
  const isFs = /filesystem/i.test(joined) || srv.type === 'filesystem' || /(^|[^a-z])fs($|[^a-z])/i.test(String(srv.name || ''));
  if (isFs) {
    for (const a of args) {
      if (typeof a !== 'string') continue;
      if (/^(\/|~|\$HOME|\/root|\/home\/[^/]+|\/Users\/[^/]+)\/?$/.test(a.trim())) {
        push('warn', 'BROAD_FS_SCOPE', 'filesystem access granted to broad path "' + a + '"', 'Scope filesystem access to a specific project subdirectory, not / or $HOME.');
      }
    }
  }

  // REMOTE_URL_NO_TLS (error) - http:// to a non-localhost host
  const urlCandidates = [];
  if (typeof srv.url === 'string') urlCandidates.push(srv.url);
  if (srv.transport && typeof srv.transport === 'object' && typeof srv.transport.url === 'string') urlCandidates.push(srv.transport.url);
  for (const a of args) { if (typeof a === 'string' && /^https?:\/\//i.test(a)) urlCandidates.push(a); }
  for (const raw of urlCandidates) {
    let u; try { u = new URL(raw); } catch (e) { continue; }
    if (u.protocol !== 'http:') continue;
    const h = u.hostname.toLowerCase();
    const local = h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local');
    if (!local) {
      push('error', 'REMOTE_URL_NO_TLS', 'remote transport uses plaintext http:// (' + h + ')', 'Use https:// for remote transports.');
    }
  }

  // NO_VERSION_PIN_DOCKER (info) - image without a tag or :latest
  if (cmd === 'docker') {
    const img = dockerImage(args);
    if (img) {
      const tagless = !img.includes('@') && (!img.includes(':') || /:latest$/i.test(img));
      if (tagless) {
        push('info', 'NO_VERSION_PIN_DOCKER', 'docker image "' + img + '" has no immutable tag', 'Pin the image to a specific tag or digest, not :latest.');
      }
    }
  }
}

function auditMcpConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'input must be a JSON object', hint: 'Provide {"mcpServers":{...}} (Claude Desktop) or a single server object {"command":...}.' };
  }

  const findings = [];
  let servers;

  if (input.mcpServers && typeof input.mcpServers === 'object' && !Array.isArray(input.mcpServers)) {
    servers = input.mcpServers;
    for (const k of Object.keys(input)) {
      if (!KNOWN_TOP_KEYS.has(k)) {
        findings.push({ severity: 'info', code: 'UNKNOWN_TOP_FIELDS', server: '(top)', message: 'unrecognized top-level field "' + k + '"', hint: 'Check for a typo; the config root normally holds only "mcpServers".' });
      }
    }
  } else if ('command' in input || 'url' in input || 'args' in input || 'env' in input || 'transport' in input) {
    servers = { '(root)': input }; // single-server shape
  } else {
    return { error: 'no MCP servers found', hint: 'Expected {"mcpServers":{...}} or a server object with a "command" or "url" field.' };
  }

  const names = Object.keys(servers);
  for (const name of names) checkServer(name, servers[name], findings);

  let score = 100;
  let errors = 0, warns = 0, infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') { score -= 25; errors++; }
    else if (f.severity === 'warn') { score -= 10; warns++; }
    else { score -= 2; infos++; }
  }
  if (score < 0) score = 0;

  return { score, findings, summary: { servers: names.length, errors, warns, infos } };
}

module.exports = { auditMcpConfig };
