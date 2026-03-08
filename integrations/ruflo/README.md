# Nervous System + Ruflo (claude-flow) Integration

Govern your Ruflo Queen-Worker hive mind with the Nervous System's 7 mechanically enforced rules. Every worker agent is protected from editing untouchable files, drifting from objectives, or losing context between sessions.

## What You Get

- **preflight_check** before any file edit by any worker agent
- **drift_audit** as a periodic health check the Queen triggers
- **session_handoff** between Queen sessions
- **violation_logging** piped to Ruflo's swarm_state table
- **kill_switch** accessible from Queen agent

## Setup (Under 10 Minutes)

### 1. Install

```bash
npm install mcp-nervous-system
```

### 2. Add the NS Plugin to Your Ruflo Config

Copy `example-config.yaml` to your Ruflo project root and adjust paths:

```yaml
plugins:
  - name: nervous-system
    module: ./ruflo-ns-plugin.js
    config:
      config_path: ./nervous-system.config.json
```

### 3. Copy the Plugin

```bash
cp ruflo-ns-plugin.js /path/to/your/ruflo-project/
cp ../generic-mcp/quick-start.sh /path/to/your/ruflo-project/
bash quick-start.sh  # generates nervous-system.config.json
```

### 4. Create Your Untouchable Files List

```bash
echo "/path/to/critical-file.js" >> untouchable-files.txt
echo "/path/to/production-config.json" >> untouchable-files.txt
```

### 5. Start Ruflo

```bash
claude-flow start --config ruflo-config.yaml
```

Every worker agent now runs under NS governance. The Queen triggers drift audits on her health check cycle.

## How It Works

```
Queen Agent
  |
  +-- ruflo-ns-plugin.js (intercepts all worker actions)
  |     |
  |     +-- preflight_check(file) --> BLOCKED / PROTECTED / OK
  |     +-- violation_logging --> swarm_state table
  |     +-- step_back_check every 4 worker turns
  |     |
  +-- Periodic health check
  |     +-- drift_audit(scope: "full") --> Queen reviews results
  |     |
  +-- Session end
        +-- session_handoff --> written to shared memory
```

## Files

| File | Purpose |
|------|---------|
| `ruflo-ns-plugin.js` | Integration layer - hooks NS into Ruflo's plugin system |
| `example-config.yaml` | Ruflo config with NS plugin enabled |
| `README.md` | This guide |
