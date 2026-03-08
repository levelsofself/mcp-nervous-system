#!/bin/bash
# Nervous System Quick Start
# Run this in your project root to set up governance in under 5 minutes.

set -e

echo "=== Nervous System Quick Start ==="
echo ""

# Create data directories
mkdir -p .ns-data/logs
echo "[OK] Created .ns-data/ and .ns-data/logs/"

# Create config file
if [ ! -f nervous-system.config.json ]; then
  cat > nervous-system.config.json << 'NSEOF'
{
  "project_root": ".",
  "data_dir": "./.ns-data",
  "logs_dir": "./.ns-data/logs",
  "protected_files_list": "./untouchable-files.txt",
  "pm2_managed": false,
  "html_pages": [],
  "docs_to_audit": []
}
NSEOF
  echo "[OK] Created nervous-system.config.json"
else
  echo "[SKIP] nervous-system.config.json already exists"
fi

# Create untouchable files list
if [ ! -f untouchable-files.txt ]; then
  cat > untouchable-files.txt << 'NSEOF'
# Untouchable Files - one path per line
# These files are BLOCKED from editing by any governed LLM.
# Add your critical files below:

# Example:
# .env
# .env.production
# package-lock.json
# database/migrations/
NSEOF
  echo "[OK] Created untouchable-files.txt (edit this to add your protected files)"
else
  echo "[SKIP] untouchable-files.txt already exists"
fi

# Add .ns-data to .gitignore if not already there
if [ -f .gitignore ]; then
  if ! grep -q ".ns-data" .gitignore 2>/dev/null; then
    echo ".ns-data/" >> .gitignore
    echo "[OK] Added .ns-data/ to .gitignore"
  fi
else
  echo ".ns-data/" > .gitignore
  echo "[OK] Created .gitignore with .ns-data/"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit untouchable-files.txt to add your protected files"
echo "  2. Add the MCP server to your client:"
echo ""
echo "     Claude Desktop: Add to claude_desktop_config.json:"
echo '     { "mcpServers": { "nervous-system": { "command": "npx", "args": ["-y", "mcp-nervous-system"] } } }'
echo ""
echo "     Claude Code:"
echo "     claude mcp add nervous-system npx mcp-nervous-system"
echo ""
echo "  3. Test it: Ask your LLM to edit a file in your untouchable list"
echo ""
echo "Docs: https://github.com/levelsofself/mcp-nervous-system"
