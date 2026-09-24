#!/usr/bin/env bash
# Clears a finished run so a NEW product idea can be started cleanly.
#
# Three things have to go together, which is why this exists as one command:
# stale docs/ would be read by the new run's stages as though they described
# the new idea; a stale state/run.json would resume mid-pipeline; and a stale
# workspace ledger would mark the new plan's M01..Mn "already complete" using
# the previous product's code.
#
# It never touches the code workspace — that is someone's build output living
# outside this repo, and deleting it is their call, not this script's.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/doc-headers.sh"

ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

WORKSPACE="${PIPELINE_WORKSPACE:-$HOME/agent-pipeline-workspace}"

echo "== agent-pipeline reset =="
echo ""
echo "This will blank the generated documents and clear the run state:"
for entry in "${DOC_HEADERS[@]}"; do
  filename="${entry%%|*}"
  filepath="$SCRIPT_DIR/docs/$filename"
  # awk, not `grep -c`: grep exits 1 on zero matches, so under `set -e` a
  # header-only file either aborts the script or needs an `|| echo 0` that
  # prints a second count next to grep's own. awk always exits 0.
  content_lines=$(awk '!/^<!--/ && NF' "$filepath" 2>/dev/null | wc -l | tr -d ' ')
  if [ -s "$filepath" ] && [ "$content_lines" -gt 0 ]; then
    size=$(wc -c < "$filepath" | tr -d ' ')
    echo "    docs/$filename  (${size} bytes -> header only)"
  fi
done
[ -s "$SCRIPT_DIR/docs/idea.md" ] && echo "    docs/idea.md  (deleted)"
[ -s "$SCRIPT_DIR/state/run.json" ] && echo "    state/run.json  (reset to a fresh run)"
[ -s "$SCRIPT_DIR/state/routing.jsonl" ] && echo "    state/routing.jsonl  (deleted)"
echo ""

# Generated docs are normally committed, so git is the real undo. Say so only
# when it is actually true for these files.
if git -C "$SCRIPT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain -- docs state 2>/dev/null)" ]; then
    echo "  WARNING: docs/ or state/ has uncommitted changes. They are NOT recoverable"
    echo "           from git after this. Commit first if you want to keep them."
  else
    echo "  docs/ and state/ are committed, so 'git checkout -- docs state' undoes this."
  fi
  echo ""
fi

echo "  NOT touched: $WORKSPACE"
echo "  The code workspace is left alone. Point the next run at a fresh one:"
echo "      PIPELINE_WORKSPACE=~/agent-pipeline-workspace-2 npm run orchestrator -- \"<new idea>\""
echo "  (The ledger there records which plan it was built from and will refuse"
echo "   to be reused for a different product, so a stale one fails loudly.)"
echo ""

if [ "$ASSUME_YES" -eq 0 ]; then
  printf "Proceed? [y/N] "
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted. Nothing was changed."; exit 1 ;;
  esac
  echo ""
fi

for entry in "${DOC_HEADERS[@]}"; do
  filename="${entry%%|*}"
  header="${entry#*|}"
  echo "$header" > "$SCRIPT_DIR/docs/$filename"
done
echo "  docs/ blanked to header comments"

rm -f "$SCRIPT_DIR/docs/idea.md"
echo "  docs/idea.md removed"

mkdir -p "$SCRIPT_DIR/state"
cat > "$SCRIPT_DIR/state/run.json" <<'EOF'
{
  "stage": null,
  "history": [],
  "retries": {}
}
EOF
rm -f "$SCRIPT_DIR/state/routing.jsonl"
echo "  run state cleared"

echo ""
echo "== Ready for a new idea =="
echo "  PIPELINE_WORKSPACE=~/agent-pipeline-workspace-2 npm run orchestrator -- \"<your idea>\""
echo "  ...or start it from the UI: npm start"
