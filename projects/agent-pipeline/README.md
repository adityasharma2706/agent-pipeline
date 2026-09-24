# agent-pipeline

A multi-agent product-development pipeline built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). It takes a raw product idea through
research, classification, design, architecture, implementation, and review,
with a feedback-router able to send work back to any earlier stage.

**Phase 4 (current state):** the first nine stages are wired to run for real
against the Claude Agent SDK — `product-understanding -> product-alignment ->
deep-discovery -> design-planning -> architecture-planning ->
implementation-planning -> system-design -> low-level-design ->
spec-implementer`. The first eight write one design document each; the ninth
writes real code, one module at a time, into a workspace outside this
repository. The remaining two stages (`reviewer`, `testing-agent`), plus
`invokeFeedbackRouter()` and `invokeCritic()`, are still stubs and throw if
reached.

`spec-implementer` is the first stage that is not a document stage, and it
forced four generalisations in `orchestrator/run.ts`. Each is a widened type,
not a branch on the stage's name — the eight document stages take exactly the
same path they did in Phase 3:

| Was | Now |
|---|---|
| `StageIo.writes: string` | `StageOutput`, a union of `{kind:"document"}` and `{kind:"workspace-modules"}` |
| `hasRealContent()` was the only verifier | verification dispatches on output kind; workspace output is checked by an orchestrator-run typecheck |
| `cwd` was always `PROJECT_ROOT` | `StageIo.cwd` is `"project" \| "workspace"` |
| `maxBudgetUsd` was per-`query()` | a cumulative `RunBudget` caps the whole run on top of it |

Traceability runs end to end across those stages on two ID families.
`design-planning` assigns every functional requirement a stable `REQ-NNN` ID in
`docs/design.md`, `architecture-planning` cites those IDs per component and
decision, and `implementation-planning` maps each module to the IDs it
satisfies and must list anything uncovered under a **Requirements not yet
covered** heading. `implementation-planning` also introduces module IDs
(`M01`, `M02`, ...); `system-design` names the module IDs behind every
interface and interaction in `docs/hld.md`, and `low-level-design` organises
`docs/lld.md` by module ID and must close with a **Modules not yet specified**
heading — emitted even when nothing is missing, because a heading that appears
only on failure cannot be told apart from a skipped check. These lists exist
because requirement omission is the biggest measured weakness of agentic build
pipelines (`docs/okf.md` §0.5, §6) — traceability is what makes an omission
visible instead of silent.

> **Phases 1-3 verified live; Phase 4 not yet.** Phase 1's three stages have
> run against the live API end to end (~$1.85), Phase 2's three planning stages
> have too (~$2.28, 17 turns, resumed from Phase 1's state), and Phase 3's two
> design stages produced the `docs/hld.md` and `docs/lld.md` on disk. Phase 4's
> `spec-implementer` has *not* been run live yet — no module has been built by
> the real API, and no cost figure for it exists.
>
> What *has* been verified without spending money: `tsc --noEmit`, the no-idea
> usage path, resuming mid-pipeline, the already-complete path, rejection of a
> malformed `state/run.json`, the config-fault halt (missing
> `agents/<stage>.md`), and — for Phase 4 specifically — module parsing against
> the real `docs/implementer.md` (36 modules, none hardcoded), idempotent
> workspace bootstrap, the TS2307-vs-error classifier, the typecheck verifier
> against hand-written good and broken files, every stub-detector rule, the
> REQ-subset check, progress-log round-tripping and resume, and the cumulative
> budget halting before it starts a call it cannot pay for.

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

Phase 4 runs `product-understanding -> product-alignment -> deep-discovery ->
design-planning -> architecture-planning -> implementation-planning ->
system-design -> low-level-design -> spec-implementer` and then stops at the
`LAST_IMPLEMENTED_STAGE` constant in `orchestrator/run.ts`. Per-stage and
cumulative USD cost are logged.

**`--max-modules N`** (default **2**) caps how many modules `spec-implementer`
builds in one invocation:

```
npm run orchestrator -- --max-modules 5
```

The default is deliberately tiny — the first live run of a loop that writes real
code should be cheap enough to throw away, and raising it is a decision you make
on purpose. It is a cap, not a truncation: modules recorded as complete in the
workspace progress log are skipped, so re-running continues where the last run
stopped rather than rebuilding. It is the only flag; anything else starting with
`--` is rejected rather than silently written into `docs/idea.md`.

Around each stage the loop calls `beginStage` + `saveState` *before* invoking
the agent, then `finishStage(stage, outcome)` + `saveState` after. So
`state/run.json` history reflects what actually happened: successes carry
`outcome: "success"` and a real `finishedAt`, failed attempts are kept as
`outcome: "failure"` rather than disappearing, and an attempt whose process was
killed mid-stage stays `"in-progress"` — which is the truth about it.
`state.stage` means *the last stage that completed successfully*, and only a
successful `finishStage` moves it; that is what a re-run resumes from.

Phase 4 adds a third terminal outcome, **`"partial"`**. `spec-implementer` can
end an invocation having built real, verified, recorded modules without the
stage being finished — because `--max-modules` capped it, or because the run
budget ran out. Calling that `"success"` would advance `state.stage` past a
stage with 34 modules left to build; calling it `"failure"` would spend a retry
on something that did not fail. A `"partial"` attempt stops the run, prints
what is left undone, and tells you to re-run.

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

- *Retryable* (returned as `ok: false`, `outcome: "failure"`): an unsuccessful
  SDK result, an error thrown by the SDK while streaming
  (network/transport/auth), a stream that ends with no result message, a stage
  that claims success without writing its output doc, and any module that fails
  one of `spec-implementer`'s four verification checks. A retry re-attempts only
  the failed module — completed ones are skipped.
- *Not a failure at all* (`outcome: "partial"`): the module cap or the run
  budget stopped the work. No retry is spent.
- *Not retryable* (thrown, halts immediately): a missing `STAGE_IO` entry or a
  missing/malformed `agents/<stage>.md`. Retrying a configuration fault just
  prints the same error three times.

Halts print `Run halted: <message>` rather than a stack dump; set
`PIPELINE_DEBUG=1` for the stack.

### Safety rails

- **Per-call budget cap** (`MAX_BUDGET_USD_PER_STAGE`, default $4.00): passed
  as the SDK's `maxBudgetUsd`. An `error_max_budget_usd` result is treated as
  an ordinary failure, not a crash. Raised from $2.00 in Phase 3: the live
  Phase 2 stages cost ~$0.76 each, and `low-level-design` has to spec every
  module in `docs/implementer.md`. In Phase 4 it doubles as the per-*module*
  cap — one module's code is the same order of output as one document.
- **Cumulative run budget** (`MAX_BUDGET_USD_PER_RUN`, default **$25.00**, in
  `orchestrator/budget.ts`): new in Phase 4. The per-call cap was sufficient
  while every stage was exactly one `query()`; `spec-implementer` is a loop of
  N calls, so the real ceiling was N × $4.00 and nothing bounded N × anything.
  `RunBudget` accumulates actual spend across every call in the run, clamps each
  call's `maxBudgetUsd` to what is left, and halts cleanly before starting a
  call it cannot pay for — reporting what was spent and which modules are still
  undone. The $25 default is not invented: it is `budget.defaultUsd: 25` from
  this project's own `docs/lld.md` §M01 defaults, adopted so the orchestrator
  and the design it is building agree on the number.
- **`permissionMode: 'bypassPermissions'`**: the pipeline is non-interactive,
  so a prompting mode would hang forever with nobody to answer it. The actual
  blast-radius control is each agent's `tools` allowlist from its frontmatter
  (passed through as `allowedTools`) plus `cwd` scoping — to the project root
  for document stages, and to a workspace *outside this repository* for the one
  stage that writes code.
- **Output verification**: a document stage is only considered successful if its
  designated `docs/*.md` file exists and has real content beyond the HTML
  comment header. A stage that "succeeds" without its artifact would silently
  poison every downstream stage. `spec-implementer` is verified far more
  strictly — see below.

### The spec-implementer stage (code generation)

**No shell, deliberately.** `agents/spec-implementer.md` lists
`Read, Write, Edit, Grep, Glob` — `Bash` was removed in Phase 4. This is not an
improvised precaution; it is the project's own generated design. `docs/lld.md`
line 396, **Decision LD-1**, says to route all command execution through a
custom `sandbox_exec` MCP tool (via `createSdkMcpServer`) and *never enable
native Bash*. That sandbox is module **M18**, which has not been built yet. So
"no shell at all" is the honest intermediate state: strictly weaker than the
design intends, never weaker than it permits. No MCP server is wired up and no
substitute for Bash is provided.

Three consequences, all handled on the orchestrator side rather than worked
around on the agent side:

- **Nothing is installed.** The agent cannot run `npm install`, so generated
  imports do not resolve. The typecheck verifier treats `TS2307: Cannot find
  module` as a logged warning rather than a failure.
- **The agent cannot verify its own work.** So the orchestrator runs the
  typecheck itself. Success is never the agent's self-report.
- **`testing-agent` cannot ship before M18.** It needs Playwright, i.e. a
  shell. It stays unimplemented, as does `reviewer`.

**Where the code goes.** Generated code is written *outside this git repo*, to
`~/agent-pipeline-workspace` by default, overridable with the
`PIPELINE_WORKSPACE` environment variable. The reason is specific: this repo's
parent directory holds untracked personal work, and untracked means
unrecoverable — a code-writing agent under `bypassPermissions` must not be
pointed anywhere near it. The workspace is bootstrapped by the *orchestrator*,
not the agent, on first use: it creates the directory, a `package.json`, a
`tsconfig.json` (`noEmit`, `skipLibCheck`), a `.gitignore`, and runs `git init`
so the product has its own history. It is idempotent — an existing workspace is
never clobbered, and `setup.sh` never touches it.

That workspace `tsconfig.json` points `typeRoots` at *this* repo's installed
`@types` and includes the `DOM` lib. Without it, every generated file touching
`process`/`console` would fail on `TS2304: cannot find name` — an artefact of
the empty `node_modules`, nothing to do with the module being judged.

**The module loop.** `docs/implementer.md` is parsed for its `### Mnn Title`
sections, with the `**Depends on:**` and `**REQs:**` lines beneath each. The
count is whatever is in the file (36 in the current artifact; nothing is
hardcoded), and they run in document order — implementation-planning already
writes them in dependency order. One `query()` call per module. The prompt does
*not* paste `docs/lld.md`: at 1,223 lines, re-sending it on every module call is
the most expensive mistake available here, so the agent is told to `Grep` for
its own module's section instead. `docs/` sits outside the workspace `cwd`, so
it is made readable through the SDK's `additionalDirectories` option, and the
agent is instructed to treat it as read-only.

**Per-module verification, all orchestrator-side**, applied in this order and
stopping at the first failure:

1. **Something was written.** The workspace is snapshotted before and after each
   call; at least one file must be created or modified. (Orchestrator
   bookkeeping files are excluded so they cannot be mistaken for output.)
2. **REQ claims are a subset.** The agent reports the `REQ-` IDs it satisfied;
   any ID `docs/implementer.md` does not assign to that module fails the stage.
   A module inventing requirement IDs is a red flag, not a rounding error.
3. **Not a stub** — see below.
4. **`tsc --noEmit` is clean.** The orchestrator runs TypeScript against the
   whole workspace and requires exit 0, with one exception: `TS2307` is logged
   as a warning, because it means "this dependency was never installed", which
   is guaranteed rather than informative. *Every other diagnostic code fails the
   module.* That split is the whole verifier: downgrade too much and it proves
   nothing, downgrade too little and every module fails on missing `node_modules`.

**What the stub detector actually catches.** "It wrote files" is trivially
satisfiable, and the cheapest way to satisfy it is a placeholder, so this check
exists to make that expensive. It is a deliberately simple text heuristic over
the files the module wrote — it does not understand the code, and is not meant
to; correctness is the typecheck's job and the reviewer's after it.

- **Hard markers — one hit anywhere fails the module.** The phrases
  `not implemented`, `not yet implemented`, `unimplemented`, `placeholder`, and
  `stub out`/`stubbed for now`/`stub implementation`. This catches
  `throw new Error("unimplemented")` and `// TODO: not implemented yet` alike.
  Hard markers are checked in *every* written file, including markdown.
- **Soft markers — judged by density.** `TODO`, `FIXME`, and empty `{}` function
  bodies. These are normal in small numbers, so the module fails only above one
  marker per 40 non-empty code lines. Soft markers count only inside code files
  (`.ts .tsx .js .jsx .mjs .cjs`) — a README saying "TODO: more docs" is not a
  stubbed implementation.
- **A volume floor.** If the module wrote any code file at all, fewer than 10
  non-empty code lines in total fails. A module that writes only config or
  markdown is exempt from this rule but still subject to the other two.

Known limits, stated plainly: the empty-body regex also matches empty
constructors and empty object literals, and the word "placeholder" in a
legitimate comment will fail a module. Both are false positives that cost one
retry and are recorded with their exact reason, which is the cheaper direction
to be wrong in.

**The progress log** lives in the workspace (`pipeline-progress.json` plus a
generated `PROGRESS.md`), *not* in `docs/`. `docs/` is pipeline-owned — every
file in it is a stage artifact with a declared writer and reader; the progress
log describes the generated product, travels with it, and belongs in its git
history. Each entry records the module ID, files written, REQ IDs claimed,
outcome, cost and turns, any deviation notes the agent reported, and — on
failure — exactly why the orchestrator rejected it. Failures are appended just
like successes: a module that failed honestly and said why is more useful than
one that quietly stubbed. It is also the resume ledger, which is what makes
`--max-modules` a resumable cap rather than a truncation.

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
- **Phase 2 (done, verified live):** the three planning stages —
  `design-planning -> architecture-planning -> implementation-planning` — plus
  `docs/design.md` as design-planning's own artifact and `REQ-` ID
  traceability across all three.
- **Phase 3 (done, verified live):** the two design stages —
  `system-design -> low-level-design`, producing `docs/hld.md` and
  `docs/lld.md` — extending the traceability chain onto the `M` module IDs from
  `docs/implementer.md`. Both are document stages, the same shape as Phase 2's.
- **Phase 4 (built, not yet run live):** `spec-implementer` — the first stage
  that writes code and the first that loops rather than producing one document.
  An orchestrator refactor more than a stage addition: `StageIo.writes` became a
  union, verification became per-output-kind, `cwd` became per-stage, and a
  cumulative `RunBudget` was added on top of the per-call cap. Plus the
  out-of-repo workspace, the `docs/implementer.md` module parser, the four-check
  per-module verifier, the workspace progress log, and `--max-modules`. See
  *The spec-implementer stage* above.
- **Phase 5+:** `reviewer`, then the sandbox executor (**M18**) and only then
  `testing-agent`, which needs Playwright and therefore a shell. After that,
  `feedback-router`'s SDK call and output parsing against the
  `FeedbackRouterDecision` type, and `critic` wired for on-demand use.

  The permission model is the known gap carried into Phase 5. Under
  `permissionMode: 'bypassPermissions'`, `cwd` is a working directory, not a
  boundary, and `additionalDirectories` grants `docs/` to `spec-implementer` by
  instruction rather than by enforcement. Removing `Bash` shrinks the blast
  radius a great deal and moving the workspace out of this repo shrinks it
  further, but neither is the `canUseTool` callback / PreToolUse deny-list that
  `docs/lld.md` specifies.

## Layout

```
agent-pipeline/
  agents/          subagent definitions (markdown + YAML frontmatter)
  docs/            pipeline doc artifacts, written/read stage to stage
                   (docs/idea.md is the human-supplied input)
  state/run.json   persisted orchestrator state
  orchestrator/    run.ts (control loop + runStage), agent-loader.ts,
                   types.ts, state.ts, and the Phase 4 additions:
                   budget.ts    cumulative run budget
                   modules.ts   docs/implementer.md module parser
                   workspace.ts workspace bootstrap, snapshots, typecheck
                   verify.ts    per-module verification + stub detection
                   progress.ts  the workspace progress log / resume ledger
  setup.sh         idempotent bootstrap
```

Generated code is **not** in this tree — it lives at `$PIPELINE_WORKSPACE`, or
`~/agent-pipeline-workspace` by default, with its own git history.
