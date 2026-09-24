# agent-pipeline

A multi-agent product-development pipeline built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). It takes a raw product idea through
research, classification, design, architecture, implementation, and review,
with a feedback-router able to send work back to any earlier stage.

**Phase 0 (current state):** scaffold only. Directory layout, subagent
definitions (`agents/*.md`), doc placeholders (`docs/*.md`), and the
orchestrator's state-management wiring (`orchestrator/state.ts`,
`orchestrator/types.ts`) all exist, but `orchestrator/run.ts` does not yet
call the SDK — `runStage`, `invokeFeedbackRouter`, and `invokeCritic` are
stubs. Running the orchestrator right now just loads and prints
`state/run.json`.

## Setup

```
./setup.sh
```

Idempotent: creates `docs/*.md` placeholders and `state/run.json` if
missing (never overwrites existing content), and runs `npm install` if
`node_modules` is absent. Then:

```
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm run orchestrator   # runs the Phase 0 scaffold (logs state, no SDK calls yet)
npm run typecheck      # tsc --noEmit
```

## Pipeline stages

Linear order (feedback-router can redirect back to any earlier one):

```
product-understanding -> product-alignment -> deep-discovery ->
design-planning -> architecture-planning -> implementation-planning ->
system-design -> low-level-design -> spec-implementer -> reviewer ->
testing-agent
```

`feedback-router` and `critic` are not linear stages: feedback-router reads
`docs/feedback_log.md` and emits routing decisions consumed by
`orchestrator/run.ts`; critic is invoked on demand by the orchestrator or by
any other agent, on no fixed schedule.

`reviewer` is a human checkpoint in v1 — the orchestrator is expected to
pause there for human approval before feedback-router acts.

Each stage's subagent definition lives in `agents/<stage-name>.md` (YAML
frontmatter + system prompt, same shape as `.claude/agents/*.md`). Each
stage's doc I/O lives in `docs/*.md`, with a one-line header in each file
noting who writes it and who reads it next.

## Phased build order

- **Phase 0 (this phase):** scaffold — directory layout, agent definitions,
  doc placeholders, orchestrator state wiring. No SDK calls.
- **Phase 1:** vertical slice — wire real SDK invocation for
  `product-understanding -> product-alignment -> deep-discovery` only, with
  the orchestrator's control loop actually calling `runStage` and persisting
  state between them.
- **Phase 2+:** extend real invocation to the remaining stages
  (`design-planning` through `testing-agent`), implement `feedback-router`'s
  SDK call and output parsing against the `FeedbackRouterDecision` type, wire
  `critic` for on-demand use, and add the Playwright MCP tools referenced as
  a placeholder in `agents/testing-agent.md`.

## Layout

```
agent-pipeline/
  agents/          subagent definitions (markdown + YAML frontmatter)
  docs/            pipeline doc artifacts, written/read stage to stage
  state/run.json   persisted orchestrator state
  orchestrator/    run.ts (control loop skeleton), types.ts, state.ts
  setup.sh         idempotent bootstrap
```
