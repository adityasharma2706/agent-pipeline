# agent-pipeline

A multi-agent product-development pipeline built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). It takes a raw product idea through
research, classification, design, architecture, implementation, and review,
with a feedback-router able to send work back to any earlier stage.

**Phase 5 (current state): the pipeline stops being a line and becomes a
loop.** Ten stages run for real against the Claude Agent SDK —
`product-understanding -> product-alignment -> deep-discovery ->
design-planning -> architecture-planning -> implementation-planning ->
system-design -> low-level-design -> spec-implementer -> reviewer`. Eight write
one design document each; `spec-implementer` writes real code, one module at a
time, into a workspace outside this repository; `reviewer` reads that code
alongside the design docs and writes evidence-bearing findings.

Reaching `reviewer` is no longer the end of a run. `feedback-router` then reads
those findings and returns routing decisions as SDK **structured output**, and
a high-confidence decision sends execution **back** to an earlier stage, which
then re-runs forward from there. `critic` is implemented but **on demand only**
(`--critic <target>`) — it is never scheduled and never wired into the loop.
`testing-agent` is the one stage still unimplemented, and it is blocked on a
dependency rather than merely unscheduled (see below).

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

> **Phases 1-3 verified live; Phases 4 and 5 not yet.** Phase 1's three stages
> have run against the live API end to end (~$1.85), Phase 2's three planning
> stages have too (~$2.28, 17 turns, resumed from Phase 1's state), and Phase
> 3's two design stages produced the `docs/hld.md` and `docs/lld.md` on disk.
> Phase 4's `spec-implementer` has *not* been run live — no module has been
> built by the real API. Phase 5's `reviewer`, `feedback-router` and `critic`
> have *not* been run live either: no real routing decision exists, and there
> is no cost figure for a go-back.
>
> What *has* been verified without spending money: `tsc --noEmit`, the no-idea
> usage path, resuming mid-pipeline, the already-complete path, rejection of a
> malformed `state/run.json`, the config-fault halt (missing
> `agents/<stage>.md`); for Phase 4, module parsing against the real
> `docs/implementer.md` (36 modules, none hardcoded), idempotent workspace
> bootstrap, the TS2307-vs-error classifier, the typecheck verifier against
> hand-written good and broken files, every stub-detector rule, the REQ-subset
> check, progress-log round-tripping and resume, and the cumulative budget
> halting before it starts a call it cannot pay for; and for Phase 5, 78
> assertions over the router and the go-back machinery — sixteen malformed
> `structured_output` shapes each rejected as a clean error, every one of the
> five escalation reasons, the gate's ordering, `planDrain`'s earliest-target
> ordering and one-per-drain rule, a simulated run in which exactly three
> go-backs are enacted and the fourth is refused with `cap-reached`, routing-log
> round-tripping with `RD-n` allocation and corrupt-line tolerance, and
> `goBacksUsed` validation including backwards compatibility with state files
> written before Phase 5.
>
> Those checks run from a scratchpad copy of the project against
> `orchestrator/router.ts`, `routing.ts` and `state.ts` only — none of which has
> an import path to `query()`, so the verification cannot make a billable call
> even by mistake. That is deliberate: `docs/idea.md` is populated and
> `state/run.json` is mid-pipeline, so a bare `npm run orchestrator` in this
> repo spends money immediately.

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

Phase 5 runs `product-understanding -> ... -> spec-implementer -> reviewer`,
then drains the `feedback-router`, then either goes back to an earlier stage and
re-runs forward from there, or stops. Per-stage and cumulative USD cost are
logged.

**`--max-modules N`** (default **2**) caps how many modules `spec-implementer`
builds in one invocation:

```
npm run orchestrator -- --max-modules 5
```

The default is deliberately tiny — the first live run of a loop that writes real
code should be cheap enough to throw away, and raising it is a decision you make
on purpose. It is a cap, not a truncation: modules recorded as complete in the
workspace progress log are skipped, so re-running continues where the last run
stopped rather than rebuilding.

**`--max-go-backs N`** (default **3**) caps how many times one run may send
execution back to an earlier stage. **`--critic <target>`** runs a single
on-demand critic session and nothing else.

**`--force-idea`** (a switch, off by default) permits replacing `docs/idea.md`
with a *different* idea while earlier stages have already run against the old
one. Without it that situation is **refused** — see *Re-running* below. Use it
only when you actually mean "carry on against documents that describe the other
idea".

Those four are the only flags; anything else starting with `--` is rejected
rather than silently written into `docs/idea.md`.

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
  resumes at the next stage and says so.
- *Mid-pipeline with a different idea*: **refused, exit 1, nothing spent.** The
  completed stages, every document in `docs/`, and the code already in the
  workspace all describe the old idea; continuing builds the new idea's name
  onto the old idea's design. This used to be a warning the run then ignored,
  which cost one real run $1.99 building the *previous* product's modules. The
  refusal prints both ideas and the exact commands to start cleanly (`rm
  state/run.json`, `./setup.sh`, blank `docs/`, a fresh `PIPELINE_WORKSPACE`).
  Pass `--force-idea` to override deliberately; the override is never applied
  silently. Ideas are compared with whitespace and line wrapping normalised, so
  re-wrapping the same text is not a "different idea".
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
  shell. It stays unimplemented — see *Why `testing-agent` is still
  unimplemented* below. (`reviewer` ships in Phase 5: it only needs to *read*
  the code, not run it.)

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

**Workspace identity: a ledger belongs to one plan.** Module ids are
*positional* — every product's `docs/implementer.md` starts at `M01` — so an
entry keyed only by `"M01"` says nothing about which product it came from.
Pointing a new idea at an old workspace would therefore read `M01`-`M04` as
"already complete" and skip them, silently shipping one product's code as
another's first four modules. So the ledger records a **`planHash`** (a hash of
`docs/implementer.md`, the document the modules are literally derived from) and
an advisory `ideaHash`, and on load a mismatch is a **hard halt before anything
is spent**. A ledger with *no* hash — one written before this existed — counts
as unknown provenance and is refused too, not assumed to match; assuming is the
failure being prevented. An empty ledger is adopted and stamped, so a fresh
workspace just works.

Resolving a mismatch is *your* decision, never the orchestrator's: point
`PIPELINE_WORKSPACE` at a new directory, or move/remove the old workspace
yourself. **The orchestrator never deletes a workspace.**

### The feedback loop (reviewer -> feedback-router -> go-back)

This is the part that makes the pipeline a loop rather than a line, and it is
the product's actual differentiator.

**`reviewer`** is a document stage with an unusual shape: `cwd` is the project
(so it writes `docs/feedback_log.md` in place) but the generated code lives in a
workspace outside this repo, granted read-only through the SDK's
`additionalDirectories`. Its tools are `Read, Write, Grep, Glob` — no `Bash`, so
it reads the code it is reviewing and cannot run it. It reviews two things:
whether the implementation matches *intent* (`REQ-NNN` coverage) and whether the
code quality is sound.

Every finding it writes must carry a stable id (`F-1`, `F-2`, ...), a severity,
and **the evidence it rests on** — a `file:line`, a `REQ-NNN`, or an `Mnn`.
That last requirement is not stylistic. The router's accuracy is bounded by the
quality of the evidence it is handed, and a routing decision is an instruction
to spend money re-running stages.

**`feedback-router`** reads `docs/feedback_log.md` and returns its decisions as
SDK **structured output** (`options.outputFormat` with a `json_schema`; the
result arrives on `SDKResultSuccess.structured_output`). Nothing is scraped out
of prose and there is no regex fallback — a fallback would mean the malformed
case silently produces *something*. `structured_output` is typed `unknown` by
the SDK, so it is validated field by field at runtime anyway
(`parseRouterDecisions`); a malformed decision set is a clean, named failure
that halts the loop, never a crash and never a half-trusted object. `RD-n` ids
are allocated by the orchestrator from the routing log, not by the agent.

#### Confidence gating, and why it is not optional

**Only `high` confidence auto-routes.** `medium` and `low` both halt and report
for a human with escalation reason `low-confidence`.

This is evidence-based, not caution for its own sake, and the evidence is in
this pipeline's own research file. `docs/okf.md` §3.1 records that automated
failure attribution — "which stage is responsible for this failure?" — is an
open research problem: on the **Who&When** benchmark (ICML 2025 spotlight,
arXiv 2505.00212, failure logs from 127 multi-agent systems) the *best* method
identifies the responsible agent **53.5%** of the time, and some methods score
below random; **AgenTracer** (ICLR 2026, arXiv 2509.03312), a model purpose-
trained for attribution, reaches about **69%**. A router that trusts its own
attribution unconditionally is therefore wrong something like a third to a half
of the time, and *every wrong answer burns a full re-run of the target stage and
everything downstream of it*. That makes wrong attribution the most expensive
error available in this system.

The threshold is also the pipeline's own generated design:
`router.autoProceedMinConfidence: 'high'` in `docs/lld.md` §M01 defaults.
`docs/lld.md` §M27 gate step 6 permits `medium` to *ask the user* when a run is
attended; this orchestrator has no attended mode — there is nobody sitting at
the process to answer — and §M27 says plainly that "`ask-user` in unattended
mode always becomes escalate". So medium escalating is that rule applied, not a
departure from it.

#### What a go-back actually costs

Enacting a decision **re-runs the target stage and every stage downstream of it,
each at full price**. It is not a patch applied to one document. This is the
same tradeoff LangGraph's checkpoint time-travel makes — `docs/okf.md` §6.3:
"Everything after that point runs again, including model calls. Replay is a
re-run of the tail, not a recording of it." Selective invalidation (rebuild only
what is downstream of a changed input, Make/Bazel style) is the alternative that
section names, and it is **not implemented here**. That is a known, chosen
limitation rather than an oversight, and it is exactly why the gate is strict.

#### The guards, all of them real

| Guard | Escalation reason | Behaviour |
|---|---|---|
| Target has no implementation in this build | `guard-violation` | Refused. Enacting it would spend a go-back on a stage that cannot run. |
| Target is at or after the origin stage | `contract-violation` | Refused. A "go-back" that goes forward is a contradiction; the feedback was produced *by* the origin stage. |
| `goBacksUsed >= maxGoBacksPerRun` (default **3**) | `cap-reached` | Refused. The counter lives in `state/run.json` and survives restarts. |
| Forecast cost > remaining run budget | `budget-insufficient` | Refused *before starting*, so a go-back never begins and dies halfway with the money spent. |
| Confidence below `high` | `low-confidence` | Refused, reported for a human. |

The two structural checks are hoisted above the caps, which is a deliberate
departure from `docs/lld.md` §M27's ordering: reporting a malformed decision as
"out of budget" would send a human to look at the wrong thing.

When a decision *is* enacted, `state.stage` is rewound to just before the target
**before** the re-run starts (so a crash mid-go-back resumes at the target
rather than skipping it), and the retry counters for the target and everything
after it are cleared — a stage that failed twice earlier in the run should not
get one attempt at a fresh input. The loop guard for go-backs is
`maxGoBacksPerRun`, not a leftover retry count.

Exactly **one** decision is enacted per drain (`docs/lld.md` §M28: "one issue
enacted per drain"), the one with the earliest target, because going back
furthest subsumes every nearer target in the same pass. The rest are recorded as
`deferred`, not judged: the go-back ends by re-running the reviewer, which
re-derives the findings from what is then true.

#### The routing log

Every routing decision is appended to **`state/routing.jsonl`** — id, origin,
target, reason, priority, confidence and the router's stated reason for it, the
evidence, the finding ids, the gate rule that judged it, whether it was enacted,
the outcome, the cost estimate and the budget remaining at the time.

`docs/okf.md` §3.5 asks, as an open question, "Should routing decisions be
logged as data, so their accuracy can be measured over time?" This is the answer
being yes. **Rejected and deferred decisions are logged too**, which is the
whole point: measuring a ~53-69% accuracy rate needs the entire sample, not just
the decisions that already cleared the confidence filter. The file is JSONL and
append-only, and lives in `state/` rather than `docs/` because `docs/` is
stage-artifact territory while this is orchestrator bookkeeping about the run.
(`docs/lld.md` §M28 puts the equivalent at `.pipeline/routing.jsonl` — same
separation, different directory name.)

### The critic (on demand, never scheduled)

```
npm run orchestrator -- --critic docs/design.md
npm run orchestrator -- --critic "the onboarding flow in the generated app"
```

`--critic` is a complete alternative to running the pipeline: no stage runs, no
run state is touched, and `docs/idea.md` is not written. The critic applies a
human lens — user experience, output quality, whether the work matches what a
person actually *meant* rather than what the spec literally said. Conformance to
the spec is already the reviewer's job.

It is deliberately **not** auto-invoked and **not** wired into the loop above.
That is the original framing of the agent ("invoked independently whenever a
critical lens is needed") and it is also what the generated plan says:
auto-invoking the critic is **M33**, a "Could" item, i.e. explicitly a later
feature. An agent that runs on every pass costs money on every pass whether or
not anyone wanted its opinion.

The critic has `Read, Grep, Glob` and **no Write**: it reports in its final
message and the *orchestrator* records the session into `docs/critic_log.md`
under a monotonic `C-n` id. That is what keeps it invokable from any context
rather than tied to one fixed pipeline document.

### Why `testing-agent` is still unimplemented

It is blocked on a dependency, not merely unscheduled, and the error says so
rather than "not implemented". `testing-agent` runs end-to-end tests via
Playwright, which needs a shell. **Decision LD-1** in `docs/lld.md` (line ~396)
requires *all* command execution to go through a custom `sandbox_exec` MCP tool
built with `createSdkMcpServer`, and to **never enable native Bash**. That
sandbox is module **M18** and has not been built. Giving `testing-agent` Bash
instead would violate the pipeline's own generated design, so it stays
unimplemented until M18 ships.

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

`reviewer` is a human checkpoint in v1 — nothing it finds is auto-applied, and
only *high-confidence* routing decisions derived from it are acted on without a
human.

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
- **Phase 5 (built, not yet run live):** the feedback loop — `reviewer`,
  `feedback-router` with structured output and confidence gating, the go-back
  loop with real caps, the routing log, and `critic` on demand. See *The
  feedback loop* above.
- **Phase 6+:** the sandbox executor (**M18**), and only then `testing-agent`,
  which needs Playwright and therefore a shell. Selective invalidation, so a
  go-back rebuilds only what is actually downstream of the changed input rather
  than re-running the whole tail. Per-stage cost history in `state/run.json`, so
  the go-back estimate can use a real median instead of a flat $1.00 guess.
  Stale-marking of already-built modules when an upstream design doc changes
  (`docs/lld.md` §M28), without which `spec-implementer` skips its way through a
  go-back. Auto-invoked critic (**M33**, a "Could" item).

  The permission model is the known gap carried forward. Under
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
  state/routing.jsonl  every routing decision, enacted or not (Phase 5)
  orchestrator/    run.ts (control loop + runStage + the go-back loop),
                   agent-loader.ts, types.ts, state.ts, and:
                   budget.ts    cumulative run budget
                   modules.ts   docs/implementer.md module parser
                   workspace.ts workspace bootstrap, snapshots, typecheck
                   verify.ts    per-module verification + stub detection
                   progress.ts  the workspace progress log / resume ledger
                   router.ts    the router contract: output schema, runtime
                                validation, the confidence gate, planDrain.
                                PURE — no SDK import, so the gate can be
                                exercised without a billable call.
                   routing.ts   the append-only routing log + RD-n allocation
  setup.sh         idempotent bootstrap
```

Generated code is **not** in this tree — it lives at `$PIPELINE_WORKSPACE`, or
`~/agent-pipeline-workspace` by default, with its own git history.
