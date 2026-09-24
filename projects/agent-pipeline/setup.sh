#!/usr/bin/env bash
# Idempotent bootstrap for agent-pipeline. Safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "== agent-pipeline setup =="

# 1. Ensure docs/ placeholder files exist (never overwrite existing content).
DOCS_DIR="$SCRIPT_DIR/docs"
mkdir -p "$DOCS_DIR"

source "$SCRIPT_DIR/doc-headers.sh"

for entry in "${DOC_HEADERS[@]}"; do
  filename="${entry%%|*}"
  header="${entry#*|}"
  filepath="$DOCS_DIR/$filename"
  if [ ! -s "$filepath" ]; then
    echo "$header" > "$filepath"
    echo "  created docs/$filename"
  else
    echo "  docs/$filename already has content, leaving it alone"
  fi
done

# 2. Ensure state/run.json exists.
STATE_DIR="$SCRIPT_DIR/state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/run.json"
if [ ! -s "$STATE_FILE" ]; then
  cat > "$STATE_FILE" <<'EOF'
{
  "stage": null,
  "history": [],
  "retries": {}
}
EOF
  echo "  created state/run.json"
else
  echo "  state/run.json already exists, leaving it alone"
fi

# 3. npm install, only if node_modules is missing.
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "  node_modules missing, running npm install..."
  npm install
else
  echo "  node_modules already present, skipping npm install"
fi

echo ""
echo "== Next steps =="
echo "1. cp .env.example .env and fill in ANTHROPIC_API_KEY"
echo "2. npm run orchestrator -- \"your product idea here\""
echo "3. See README.md for the phased build order"
