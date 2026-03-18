// discovery-briefing.js - NS MCP tool handler for discovery_briefing
// Reads user config, loads latest briefing data, returns structured intel

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  categories: ['anthropic_updates', 'ai_ecosystem', 'trending_content', 'tech_stack'],
  industries: [],
  competitors: [],
  scan_sources: ['anthropic_blog', 'github_releases', 'hackernews'],
  delivery: 'file',
  schedule: 'manual'
};

const TAG_MAP = {
  use_now: '[USE NOW]',
  watch: '[WATCH]',
  opportunity: '[OPPORTUNITY]',
  threat: '[THREAT]'
};

function loadDiscoveryConfig(projectConfig) {
  // Try multiple config locations
  const configPaths = [
    projectConfig && projectConfig.data_dir ? path.join(projectConfig.data_dir, 'discovery-config.json') : null,
    path.join(process.cwd(), 'discovery-config.json'),
    '/root/family-data/discovery-config.json'
  ].filter(Boolean);

  for (const cp of configPaths) {
    try {
      const raw = fs.readFileSync(cp, 'utf8');
      const cfg = JSON.parse(raw);
      return cfg.discovery || cfg;
    } catch (e) { continue; }
  }
  return DEFAULT_CONFIG;
}

function loadLatestBriefing(projectConfig) {
  const briefingDir = projectConfig && projectConfig.data_dir
    ? path.join(projectConfig.data_dir, 'discovery-briefings')
    : '/root/family-data/discovery-briefings';

  try {
    const files = fs.readdirSync(briefingDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const latestFile = path.join(briefingDir, files[0]);
    const content = fs.readFileSync(latestFile, 'utf8');
    return { file: files[0], content: content };
  } catch (e) {
    return null;
  }
}

function filterByScope(content, scope) {
  if (!content || scope === 'all') return content;

  // Map scope to section headers in the briefing markdown
  const scopeMap = {
    anthropic: 'Anthropic',
    ecosystem: 'AI Ecosystem',
    trending: 'Trending',
    government: 'Government',
    competitors: 'Competitors',
    techstack: 'Tech Stack',
    grants: 'Grants'
  };

  const header = scopeMap[scope];
  if (!header) return content;

  // Extract just the matching section
  const lines = content.split('\n');
  const filtered = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## ') && line.includes(header)) {
      inSection = true;
      filtered.push(line);
    } else if (line.startsWith('## ') && inSection) {
      break;
    } else if (inSection) {
      filtered.push(line);
    }
  }

  return filtered.length > 0 ? filtered.join('\n') : 'No items found for scope: ' + scope;
}

function runDiscoveryBriefing(scope, context, projectConfig) {
  const config = loadDiscoveryConfig(projectConfig);
  const latest = loadLatestBriefing(projectConfig);

  const result = {
    timestamp: new Date().toISOString(),
    config_loaded: true,
    categories: config.categories || DEFAULT_CONFIG.categories,
    industries: config.industries || [],
    competitors: config.competitors || [],
    schedule: config.schedule || 'manual',
    delivery: config.delivery || 'file'
  };

  if (!latest) {
    result.briefing = null;
    result.message = 'No briefing data available yet. Run discovery-scanner.js to generate the first briefing.';
    result.hint = 'node /root/family-workers/discovery-scanner.js';
    return result;
  }

  result.briefing_file = latest.file;
  result.briefing_date = latest.file.replace('.md', '');

  // Check staleness
  const dateStr = latest.file.replace('.md', '');
  const briefingDate = new Date(dateStr + 'T12:00:00Z');
  const now = new Date();
  const hoursOld = (now - briefingDate) / (1000 * 60 * 60);

  if (hoursOld > 48) {
    result.stale = true;
    result.stale_warning = 'Briefing is ' + Math.floor(hoursOld / 24) + ' days old. Scanner may not be running.';
  }

  // Filter by scope if requested
  const scopeFilter = scope || 'all';
  result.briefing = filterByScope(latest.content, scopeFilter);

  // Count items by tag
  const tagCounts = {};
  for (const [key, tag] of Object.entries(TAG_MAP)) {
    const regex = new RegExp('\\[' + tag.replace(/[[\]]/g, '') + '\\]', 'g');
    const matches = latest.content.match(regex);
    tagCounts[key] = matches ? matches.length : 0;
  }
  result.item_counts = tagCounts;
  result.total_items = Object.values(tagCounts).reduce((a, b) => a + b, 0);

  return result;
}

module.exports = { runDiscoveryBriefing, loadDiscoveryConfig, TAG_MAP };
