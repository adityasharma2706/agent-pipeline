#!/usr/bin/env bash
# Idempotent bootstrap for agent-pipeline. Safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "== agent-pipeline setup =="

# 1. Ensure docs/ placeholder files exist (never overwrite existing content).
DOCS_DIR="$SCRIPT_DIR/docs"
mkdir -p "$DOCS_DIR"

# "<filename>|<header>" pairs rather than an associative array: macOS ships
# bash 3.2, where `declare -A` is a syntax error and every placeholder would
# silently never be created.
DOC_HEADERS=(
  "product_understanding.md|<!-- Written by: product-understanding stage. Read by: product-alignment, deep-discovery, reviewer. -->"
  "classification.md|<!-- Written by: product-alignment stage. Read by: deep-discovery, architecture-planning. -->"
  "okf.md|<!-- Written by: deep-discovery stage (organized knowledge file). Read by: design-planning, architecture-planning. -->"
  "design.md|<!-- Written by: design-planning stage. Read by: architecture-planning, implementation-planning, system-design. -->"
  "architecture.md|<!-- Written by: architecture-planning stage. Read by: implementation-planning, system-design. -->"
  "hld.md|<!-- Written by: system-design stage (high-level design). Read by: low-level-design. -->"
  "lld.md|<!-- Written by: low-level-design stage. Read by: spec-implementer. -->"
  "implementer.md|<!-- Written by: implementation-planning stage (module list) and appended to by spec-implementer (progress log). Read by: system-design, low-level-design, spec-implementer. -->"
  "feedback_log.md|<!-- Written by: reviewer and testing-agent stages. Read by: feedback-router. -->"
)

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
