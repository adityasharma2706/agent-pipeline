# Shared header table for docs/*.md, sourced by setup.sh and reset.sh.
#
# One source of truth on purpose: setup.sh creates these files and reset.sh
# blanks them back to exactly this state, so a drifting copy in either script
# would leave a reset project subtly different from a fresh one.
#
# "<filename>|<header>" pairs rather than an associative array: macOS ships
# bash 3.2, where `declare -A` is a syntax error and every placeholder would
# silently never be created.
# docs/idea.md is deliberately absent from this table. setup.sh must not create
# a header-only idea file: it would read to a human as "an idea is set" when
# resolveIdea() correctly treats it as absent. reset.sh deletes it instead.
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
  "critic_log.md|<!-- Written by: the orchestrator, recording on-demand critic sessions (npm run orchestrator -- --critic \"<target>\"). Read by: humans. Never written on a schedule. -->"
)
