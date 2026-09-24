# agent-pipeline

A multi-agent product-development pipeline built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). It takes a raw product idea through
research, classification, design, architecture, implementation, and review,
with a feedback-router able to send work back to any earlier stage.

**Phase 2 (current state):** the first six stages are wired to run for real
against the Claude Agent SDK — `product-understanding -> product-alignment ->
deep-discovery -> design-planning -> architecture-planning ->
implementation-planning`, ending with a written `docs/implementer.md`. The
orchestrator's control loop calls `runStage()` per stage, verifies the stage's
output doc was actually written, and persists state between stages. The
remaining five stages, plus `invokeFeedbackRouter()` and `invokeCritic()`, are
still stubs and throw if reached.

The three planning stages carry requirement IDs end to end: `design-planning`
assigns every functional requirement a stable `REQ-NNN` ID in `docs/design.md`,
`architecture-planning` cites those IDs per component and decision, and
`implementation-planning` maps each module to the IDs it satisfies and must
list anything uncovered under a **Requirements not yet covered** heading. That
last list exists because requirement omission is the biggest measured weakness
of agentic build pipelines (`docs/okf.md` §0.5, §6) — traceability is what
makes an omission visible instead of silent.

> **Phase 1 verified live; Phase 2 not yet.** Phase 1's three stages have run
> against the live API end to end (~$1.85, real artifacts on disk). The three
> Phase 2 stages have *not* been run live yet. What *has* been verified without
> spending money: `tsc --noEmit`, the no-idea usage path, resuming mid-pipeline,
> the already-complete path, rejection of a malformed `state/run.json`, and the
> config-fault halt (missing `agents/<stage>.md`).

## Setup

```
./setup.sh
```

Idempotent: creates `docs/*.md` placeholders and `state/run.json` if
missing (never overwrites existing content), and runs `npm install` if
`node_modules` is absent. Then:

```
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm run typecheck      # tsc --noEmit
```

The orchestrator reads `.env` itself (a minimal `KEY=VALUE` parser in
`orchestrator/run.ts` — an already-exported `ANTHROPIC_API_KEY` wins over the
file). On startup it prints which credential is in play: if no key is found,
the SDK falls back to whatever Claude CLI login exists on the machine and
bills *that* account, so read that line before a long run.

## Running it

Supply the product idea as a CLI argument:

```
npm run orchestrator -- "an app that helps freelancers chase unpaid invoices"
```

The idea is written to `docs/idea.md`, so subsequent runs can omit the
argument and the orchestrator will pick it up from there. With neither an
argument nor a non-empty `docs/idea.md`, it prints usage and exits 1 without
making any API calls.

Phase 2 runs `product-understanding -> product-alignment -> deep-discovery ->
design-planning -> architecture-planning -> implementation-planning` and then
stops at the `LAST_IMPLEMENTED_STAGE` constant in `orchestrator/run.ts`. Per-stage and cumulative USD cost are logged.

Around each stage the loop calls `beginStage` + `saveState` *before* invoking
the agent, then `finishStage(stage, "success" | "failure")` + `saveState`
after. So `state/run.json` history reflects what actually happened: successes
carry `outcome: "success"` and a real `finishedAt`, failed attempts are kept
as `outcome: "failure"` rather than disappearing, and an attempt whose process
was killed mid-stage stays `"in-progress"` — which is the truth about it.
`state.stage` means *the last stage that completed successfully*, and only a
successful `finishStage` moves it; that is what a re-run resumes from.

**Re-running:**

- *Mid-pipeline* (e.g. `state.stage` is `product-understanding`): the run
  resumes at the next stage and says so. Passing a *different* idea on the
  command line at that point prints a warning — the completed stages ran
  against the old one.
- *After the last implemented stage completed*: the orchestrator reports that it is already
  complete, lists the artifacts, and tells you to `rm state/run.json &&
  ./setup.sh` to start fresh (note `setup.sh` does not clear `docs/`). It does
  not overwrite `docs/idea.md` in this case, and makes no API calls.

**Failure handling:** a failed attempt calls `recordRetry` + `saveState` and
retries the same stage; `recordRetry` throws past `MAX_RETRIES_PER_STAGE` (3)
to halt the run. What counts as a retryable failure is a deliberate split:

- *Retryable* (returned as `ok: false`): an unsuccessful SDK result, an error
  thrown by the SDK while streaming (network/transport/auth), a stream that
  ends with no result message, and a stage that claims success without
  writing its output doc.
- *Not retryable* (thrown, halts immediately): a missing `STAGE_IO` entry or a
  missing/malformed `agents/<stage>.md`. Retrying a configuration fault just
  prints the same error three times.

Halts print `Run halted: <message>` rather than a stack dump; set
`PIPELINE_DEBUG=1` for the stack.

### Safety rails

- **Per-stage budget cap** (`MAX_BUDGET_USD_PER_STAGE`, default $2.00): passed
  as the SDK's `maxBudgetUsd`. An `error_max_budget_usd` result is treated as
  an ordinary stage failure, not a crash.
- **`permissionMode: 'bypassPermissions'`**: the pipeline is non-interactive,
  so a prompting mode would hang forever with nobody to answer it. The actual
  blast-radius control is each agent's `tools` allowlist from its frontmatter
  (passed through as `allowedTools`) plus `cwd` scoping to the project root.
- **Output verification**: a stage is only considered successful if its
  designated `docs/*.md` file exists and has real content beyond the HTML
  comment header. A stage that "succeeds" without its artifact would silently
  poison every downstream stage.

### Isolation and prompt caching

`settingSources: []` is passed on every `query()` call — SDK isolation mode.
Without it, the machine's `~/.claude/CLAUDE.md` and project/local settings
would be inherited by every pipeline agent and derail it with unrelated
global instructions. Do not remove it.

Because `agents/*.md` lives outside `.claude/agents/` (and isolation mode
would ignore it there anyway), `orchestrator/agent-loader.ts` parses those
files itself: `js-yaml` for the frontmatter, the markdown body as the agent's
system prompt.

Each stage is one `query()` call that runs the main thread *as* that agent
(`options.agent` + `options.agents`), rather than spawning subagents via the
Task tool — that keeps every state transition inside our control loop. The
stable system prompt comes from `agents/<stage>.md` and the volatile,
run-specific instruction goes in the `prompt` argument; that ordering is what
keeps the cached prompt prefix stable across stages and re-runs.

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

- **Phase 0 (done):** scaffold — directory layout, agent definitions,
  doc placeholders, orchestrator state wiring. No SDK calls.
- **Phase 1 (done, verified live):** vertical slice — real SDK invocation for
  `product-understanding -> product-alignment -> deep-discovery`, with the
  orchestrator's control loop actually calling `runStage` and persisting state
  between them.
- **Phase 2 (built, not yet run live):** the three planning stages —
  `design-planning -> architecture-planning -> implementation-planning` — plus
  `docs/design.md` as design-planning's own artifact and `REQ-` ID
  traceability across all three.
- **Phase 3+:** extend real invocation to the remaining stages (`system-design`
  through `testing-agent`), implement `feedback-router`'s SDK call and output
  parsing against the `FeedbackRouterDecision` type, wire `critic` for
  on-demand use, and add the Playwright MCP tools referenced as a placeholder
  in `agents/testing-agent.md`.

## Layout

```
agent-pipeline/
  agents/          subagent definitions (markdown + YAML frontmatter)
  docs/            pipeline doc artifacts, written/read stage to stage
                   (docs/idea.md is the human-supplied input)
  state/run.json   persisted orchestrator state
  orchestrator/    run.ts (control loop + runStage), agent-loader.ts,
                   types.ts, state.ts
  setup.sh         idempotent bootstrap
```
