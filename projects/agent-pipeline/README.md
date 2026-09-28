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
then re-runs forward from there. `critic` and `repairer` are implemented but **on demand only**
(`--critic <target>`, `--repair [MODULE_ID]`) — neither is scheduled and neither
is wired into the loop.
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
> bootstrap, the TS2307-vs-error classifier in both dependency states (warning
> while nothing is installed, module failure for an undeclared import once
> `npm install --ignore-scripts` has succeeded, proven against a real install in
> a throwaway workspace), the dependency-set hash skipping an unchanged
> reinstall, an install failure falling back cleanly, the typecheck verifier against
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

**`--max-modules N`** (default **54**) caps how many modules `spec-implementer`
builds in one invocation:

```
npm run orchestrator -- --max-modules 5
```

It is a cap, not a truncation: modules recorded as complete in the workspace
progress log are skipped, so re-running continues where the last run stopped
rather than rebuilding.

**`--no-install`** stops the orchestrator installing the workspace's declared
dependencies before each typecheck:

```
npm run orchestrator -- --no-install
```

Installs are **on** by default, run as `npm install --ignore-scripts` with the
workspace as `cwd`, and log every package name and version first. `--no-install`
exists because that package list is written by a model; declining it is safe and
costs only verification coverage — unresolved imports stay warnings, so the
typecheck cannot see inside any file that imports a third-party package. See
*Workspace dependencies* under the spec-implementer stage.

The default was **2** through Phase 4, when the first live runs of a loop that
writes real code had to be cheap enough to throw away. It has done that job.
A 53-module plan built two at a time is 27 invocations, at which point the cap
was no longer a safety rail — it was the thing between the pipeline and a
finished product. **54** is just past the current plan's 53, which hands the
governor of a normal run to `MAX_BUDGET_USD_PER_RUN` instead. That is the better
governor: it bounds money rather than a proxy for money, and it halts with
`partial` — work recorded, nothing lost, re-run to continue — rather than
truncating.

The run budget was deliberately **not** raised to match. How much to spend per
invocation is your decision, and a long run stopping every $25 with a clear
resume message is the intended behaviour. When it happens you get the spend, the
remaining modules, and the command to continue:

```
Halted on the cumulative run budget: spent $24.8113 of the $25.00 allowed per run.
Nothing was lost. Every module that completed is recorded in
/Users/you/agent-pipeline-workspace/PROGRESS.md and will be skipped, not rebuilt.

To continue where this stopped, run the same command again:

  npm run orchestrator
```

**`--max-go-backs N`** (default **3**) caps how many times one run may send
execution back to an earlier stage. **`--critic <target>`** runs a single
on-demand critic session and nothing else.

**`--repair`** (or **`--repair M04`**) runs a single on-demand repair session
against typecheck errors that no module owns, and nothing else. It refuses to be
combined with idea text, because it is an alternative to running the pipeline
rather than an option on one. See *The repairer* below.

**`--force-idea`** (a switch, off by default) permits replacing `docs/idea.md`
with a *different* idea while earlier stages have already run against the old
one. Without it that situation is **refused** — see *Re-running* below. Use it
only when you actually mean "carry on against documents that describe the other
idea".

**`--accept-stage <stage>`** records a stage as successful *without re-running
it*, for the case where the stage hit a deterministic cap but left a complete
artifact on disk:

```
npm run orchestrator -- --accept-stage system-design
```

Like `--critic`, it is a complete alternative to running the pipeline: no agent
runs, nothing is spent, `docs/idea.md` is untouched. It refuses unless all three
of these hold — the stage is one this build can run, it is the stage the run
would run **next** (accepting a later one would silently skip the stages in
between), and its artifact passes the same verification the success path applies
(the document exists and has real content beyond its header; for
`spec-implementer`, every module in the plan is recorded complete in a ledger
that provably belongs to *this* plan). The history entry it writes carries a
`note` saying a human accepted it, because "the stage succeeded" and "a human
vouched for the file it left behind" are different facts. See *Deterministic
failures* below for when you would want this.

Those five are the only flags; anything else starting with `--` is rejected
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

- *Retryable* (returned as `ok: false`, `outcome: "failure"`): an
  `error_during_execution` SDK result, an error thrown by the SDK while
  streaming (network/transport/auth), a stream that ends with no result
  message, and a stage
  that claims success without writing its output doc. A module that fails one of
  `spec-implementer`'s four verification checks is also retried, and is **told
  what went wrong** (see *Informed retries* below) — but on its own budget, not
  the stage's; see *Two retry budgets* immediately below.
- *Not a failure at all* (`outcome: "partial"`): the module cap or the run
  budget stopped the work. No retry is spent.
- *Not retryable* (thrown, halts immediately): a missing `STAGE_IO` entry, a
  missing/malformed `agents/<stage>.md`, or an SDK result whose subtype is one
  of the three **deterministic** caps below. Retrying a configuration fault just
  prints the same error three times; retrying a cap failure also *spends the cap
  again*.

Halts print `Run halted: <message>` rather than a stack dump; set
`PIPELINE_DEBUG=1` for the stack.

### Two retry budgets: per stage, and per module

There are two, and they count different things. The distinction exists because
one stage is not like the others.

| budget | value | where it lives | what it counts | who enforces it |
| --- | --- | --- | --- | --- |
| `MAX_RETRIES_PER_STAGE` | 3 | `state.retries[stage]` in `state/run.json` — **persisted, never auto-reset** | attempts at a whole *stage* | `recordRetry` (`orchestrator/state.ts`), called only by the control loop in `main()` |
| `MAX_ATTEMPTS_PER_MODULE` | 3 | the workspace ledger (`pipeline-progress.json`), counted by `failedAttemptCount` | attempts at *one module* of `spec-implementer` | the module loop itself (`runModuleStage`) |

For the eight document stages the stage budget is the only one that applies, and
it is the right shape: one stage, one call, one artifact, three attempts.

For `spec-implementer` it was the wrong shape, and expensively so. That stage is
a loop over every module in `docs/implementer.md` — 53 in the current plan — and
a module failing verification used to be reported as a *stage* failure. Three
failures spread anywhere across 53 modules therefore exhausted the budget for the
entire build; and because `state.retries` is persisted and only `--accept-stage`
clears it, every subsequent run then halted on its *first* module failure with no
attempts left at all. A 53-module build was not survivable.

So module failures are now retried inside the module loop, against a per-module
budget, and **never touch `state.retries["spec-implementer"]`**. The stage
counter still covers genuine stage-*level* faults there (an SDK failure outside a
module, a run that ends with the stage unfinished), so the runaway guard survives
— it is simply no longer spent on the wrong thing.

The count lives in the **ledger** rather than in `state/run.json` or in memory,
for the same reason the failure records do: the files the attempts left behind
are in the workspace, so the count of attempts at them belongs next to them and
to the diagnostics that describe them. One read of one file tells a resumed run
both *what* broke and *how many times*, and a module can never be charged for
attempts made against a different workspace. A recorded success resets the count,
which is what keeps a go-back safe: a module rebuilt against a revised plan starts
from a full budget, because the old failures were against different input.

**When a module exhausts its budget the stage halts — it does not move on.**
`docs/implementer.md` is dependency-ordered and later modules import earlier
ones, so carrying on past a broken `M05` buys a cascade of failures at full
price. The halt
(`buildModuleExhaustedHaltMessage`, `orchestrator/result-failure.ts`, same idiom
as the deterministic halt below) names the module and its position in the plan,
what the last attempt was rejected for with the verbatim diagnostics, what the
three attempts cost in total, the files it left in the workspace, how many
modules were consequently not attempted, and three ranked things a human can do
(the "attempts 2 and 3 were informed" claim and the "fix the files yourself"
option are both conditional — an SDK-level failure produces no diagnostics to
carry forward and may leave no files, and the message says so rather than
sending a human after evidence that does not exist):
repair the files by hand and mark that ledger entry `"outcome": "success"` (the
only way to accept code the verifier rejected, and deliberately a manual edit),
delete the module's failed ledger entries to buy another three attempts, or read
the module's section of the plan against the diagnostics — because if the spec is
wrong, no number of retries fixes it and the repair is a go-back.

### Deterministic failures (and why a cap failure is never retried)

The SDK's error result subtypes are not interchangeable
(`orchestrator/result-failure.ts` is the whole of this logic, and it imports the
SDK for types only, so it can be exercised without an API key):

| subtype | retried? | why |
| --- | --- | --- |
| `error_during_execution` | yes, up to `MAX_RETRIES_PER_STAGE` (or `MAX_ATTEMPTS_PER_MODULE` inside the module loop) | may genuinely be transient — a network blip, a transport error |
| `error_max_budget_usd` | **no** | the same prompt against the same `maxBudgetUsd` exhausts the cap again |
| `error_max_turns` | **no** | same reason: the identical call runs out of turns at the identical point |
| `error_max_structured_output_retries` | **no** | the SDK already retried internally; the schema or the agent has to change |

This is the same fatal-vs-retryable split `runStage` already made for
configuration faults — it simply had never been applied to result *subtypes*.

It matters because of what it cost. On a live run of a 53-module product,
`system-design` hit the $4.00 per-call cap, was recorded as a failure, and was
re-run three more times at full price — while `docs/hld.md`, 48KB and complete,
had been sitting on disk since the first attempt. The orchestrator threw away
the evidence without ever looking at it.

So on a deterministic failure the orchestrator now **halts immediately** and,
before halting, **checks the stage's expected output exactly as the success path
would** and says what it found. A document that exists and has real content is
reported as `LOOKS COMPLETE`, with its size, its closing words, and the total
size of the documents the stage read (the number to sanity-check the cap
against). It is deliberately *not* auto-promoted to success: a document written
by a call that hit its cap might be truncated mid-thought, and only a human can
judge that. If it is good, `--accept-stage <stage>` records it and the run
continues from the next stage. If it is not, the halt message names the constant
to raise (`MAX_BUDGET_USD_PER_STAGE`) and what the call actually spent.

Known limitation, stated rather than hidden: `--accept-stage` verifies that the
artifact is real, not that it belongs to the current idea. A leftover document
from a previous product would pass. That is what "you are vouching for it"
means.

### Environmental blocks are not the module's fault

A third category sits alongside the two above: an **environmental block**. A
fatal configuration fault throws and is never retried; a transient SDK error is
retried; an environmental block is *neither* — the agent never started, so
there is nothing to retry and nobody to charge.

Two things count as one today: the account's **usage/session/rate limit**, and
the CLI **refusing the permission mode** because the process is running as root.
Both are detected by `detectEnvironmentalBlock` (`orchestrator/result-failure.ts`)
and both halt through `haltIfEnvironmentalBlock` without recording an attempt.

It looks like this, from a live run:

```
rejected: sdk — the SDK call did not succeed: Claude Code returned an error result:
You've hit your session limit · resets 11:50am (Asia/Calcutta)
```

The account had run out of allowance. The agent never started, nothing reached
disk, and retrying could not succeed until the provider's clock said so — yet
the module loop recorded it as a failed attempt at `M05` and did it twice more,
burning the whole `MAX_ATTEMPTS_PER_MODULE` budget in a few seconds. The next
run would then have halted on `M05` with "no budget left" while nothing
whatsoever was wrong with `M05`.

So `detectUsageLimit` (`orchestrator/result-failure.ts`) classifies it and the
run **halts without recording an attempt**. `haltIfEnvironmentalBlock` is called
immediately after every `query()` — before the workspace snapshot, the
typecheck, the verification and the ledger write — because the entire point is
that no attempt is written down. It covers the document stages, the module
loop, the feedback-router and the critic.

Detection is on the SDK error text, because that is the only place the
information exists: the CLI surfaces a limit as a *thrown* error rather than as
a result subtype. Wording varies, so it matches a small set of signals
case-insensitively rather than the one observed sentence:

| signal | pattern | |
| --- | --- | --- |
| session limit | `\bsession limit\b` | "You've hit your session limit" |
| usage limit | `\busage limit\b` | "usage limit reached" |
| rate limit | `\brate[ _-]?limit(ed\|s\|_error)?\b` | "rate_limit_error", "rate-limited" |
| quota | `quota` **with** an exhaustion word within 40 chars | "quota exceeded", "out of quota" |

Deliberately narrow, because **a false positive is worse than a miss**: it would
stop a real, retryable failure from ever being retried and tell a human their
account is throttled when it is not. Bare "limit" is not enough — the phrase
occurs in `error_max_turns`'s own description, in "structured-output retry
limit" and in ordinary model prose — and bare "quota" is not enough, because
generated products have quota *features*. Anything that matches nothing falls
through to the pre-existing transient/deterministic behaviour.

The halt message for this case is short, and it is the one halt in the system
that offers no options, because there is no decision to make:

```
Stopped at "spec-implementer/M05": this Claude account has hit a usage limit.

  provider said: Claude Code returned an error result: You've hit your session limit · resets 11:50am (Asia/Calcutta)
  resets:        resets 11:50am (Asia/Calcutta) (the provider's wording, quoted as-is)
  cost:          $0.8030

NOTHING IS WRONG WITH THE CODE, THE PLAN, OR THE PIPELINE. The agent never ran, so
this was not counted as an attempt and no retry budget was spent on it.

Wait for the limit to reset, then run the same command again:

  npm run orchestrator

Completed modules are skipped, not rebuilt.
```

The reset time is **echoed, never parsed**. The provider's format is the
provider's to change, and a wrong local time here would be worse than none.

One deliberate omission: there is no automatic cleanup of limit-caused entries
already in a ledger. The three bogus `M05` rows the bug wrote were removed by
hand, once. "Purge failures on load" is a rule that would eventually delete real
history.

#### The same shape again: a refused permission mode

The pipeline is non-interactive, so it asks the CLI to skip permission prompts
(`permissionMode: 'bypassPermissions'`, which the CLI receives as
`--dangerously-skip-permissions`). The CLI **refuses that flag when the process
is running as root**, because a skipped prompt as root is unrestricted access to
the machine. Resuming a build in a cloud container — which runs as root — hit it
immediately:

```
Claude Code process exited with code 1. stderr: --dangerously-skip-permissions
cannot be used with root/sudo privileges for security reasons
```

`$0.0000`, no turns, no files: the agent never existed. And the module loop
counted it as a failed attempt at `M24`, three times, exactly as it once did to
`M05`. Same category, same fix — halt, charge nothing.

Detection requires **both** halves, case-insensitively:

| half | pattern | why not on its own |
| --- | --- | --- |
| the flag | `--dangerously-skip-permissions` | appears in `--help` output, docs and any error that merely mentions it |
| the refusal | `<root\|sudo> … privilege(s)` **or** `cannot be used with … <root\|sudo>` | "must not run as root" is ordinary prose, and generated products write about `sudo` |

Requiring the flag *and* a refusal joined to root/sudo is what keeps it from
swallowing unrelated failures: an `EACCES … /root/.npm` from npm, a generated
README warning against running as root, or a `TS2304: Cannot find name 'sudo'`
all match at most one half and fall straight through to the pre-existing
transient behaviour. Same discipline as the usage-limit matcher, which refuses
to fire on a bare "limit".

The halt message says what was asked for, why the CLI said no, and the two ways
out:

```
Stopped at "spec-implementer/M24": the Claude Code CLI refused the permission mode this
orchestrator asks for, because this process is running as root.

  cli said: Claude Code process exited with code 1. stderr: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
  cost:     $0.0000

NOTHING IS WRONG WITH THE CODE, THE PLAN, OR THE MODULE. The agent never started, so
this was not counted as an attempt and no retry budget was spent on it.

...

  1. Run the pipeline as a non-root user. This is the cleaner fix wherever the
     environment allows it: use an ordinary user that owns this repo and the
     workspace, and run the same command as them.

  2. If this environment genuinely is a disposable container — a cloud sandbox, a CI
     runner, something whose whole filesystem you are willing to lose — tell the CLI
     so:

       IS_SANDBOX=1 npm run orchestrator

     Do NOT set IS_SANDBOX on a normal machine and do not put it in a shell profile.
     The root check exists to prevent exactly that case, and IS_SANDBOX=1 is you
     asserting this machine is throwaway.
```

`IS_SANDBOX=1` is stated as the conditional thing it is. It disables the only
check standing between an agent with prompts skipped and a machine that matters,
so it belongs in a throwaway container and nowhere else — least of all in a
shell profile.

### Safety rails

- **Per-call budget cap** (`MAX_BUDGET_USD_PER_STAGE`, default $4.00): passed
  as the SDK's `maxBudgetUsd`. An `error_max_budget_usd` result **halts the run
  immediately** rather than being retried — see *Deterministic failures* above.
  Raised from $2.00 in Phase 3: the live
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

- **The agent cannot install anything.** So the *orchestrator* installs the
  dependencies the agent declared, before each typecheck — see *Workspace
  dependencies* below. Until that has succeeded, `TS2307: Cannot find module` is
  a logged warning rather than a failure; once it has, the same diagnostic
  becomes a failure, because it now means an **undeclared** import.
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

That workspace `tsconfig.json` contains **only relative paths**, and that is
load-bearing: it is committed to the generated product's own git history, so an
absolute path in it is wrong on every machine except the one that wrote it. It
used to carry this repo's own `@types` directory as a second `typeRoots` entry —
`/Users/<me>/agent-files/.../node_modules/@types` on the Mac, rewritten to
`/home/user/...` the moment the same build was resumed in a Linux container, and
pointing at nothing at all on a third checkout. Every machine rewrote a
committed file, and a rewrite is not free: it buys the module being built an
attribution allowance for a change it did not cause.

The borrowing existed because `process`/`Buffer`/`console` are `TS2304: cannot
find name` in a workspace with an empty `node_modules` — which would fail every
module for something no module did. That predates `orchestrator/deps.ts`. The
workspace is now **self-sufficient** instead: bootstrap declares `@types/node` in
the workspace's *own* `package.json` (`ensureNodeTypesDeclared` also adds it to a
workspace bootstrapped before this change, without overwriting a version the
product chose), and the ordinary dependency install puts it under
`./node_modules/@types`. `typeRoots` is therefore just `["./node_modules/@types"]`,
and `lib` still includes `DOM` for the browser-side half of the problem.

**Ordering**, which is the whole difficulty: the per-module install runs *after*
a module's call, because that is when `package.json` may have just gained
entries — too late for module 1, which would be typechecked against a workspace
with no Node types. So `runModuleStage` runs one hash-gated install at stage
start, before the first `query()` and before the typecheck baseline. On a warm
workspace it reports "unchanged" and costs nothing. If that install cannot run
(`--no-install`, no network, a registry that says no), the run logs a loud
`@types/node is declared but not installed` warning naming `TS2304` as the
symptom, so a module failure caused by the environment is not read as a module
failure.

One consequence worth knowing: because the workspace now always declares at
least one dependency, a successful install makes `dependenciesResolved` true
from the first module onwards, so an import the agent never declared is a real
failure (`TS2307`) from module 1 rather than a warning. That is the intended
meaning of that flag; it simply used to be unreachable until the agent declared
something.

**The rest of that `tsconfig.json` is derived from what the product declares,
not fixed** (`orchestrator/workspace.ts`, `detectWorkspaceRuntime` /
`syncWorkspaceTsconfig`). A fixed Node-library config does not merely fail to
help a web product — it *shapes* it. With a generic
`NodeNext`/`no-jsx` template and a Next.js product in the workspace, two
artefacts showed up in real generated code:

- `jsx` unset means `tsc` rejects every `.tsx` file outright (`TS17004`), so the
  agent — which is verified by this typecheck — wrote every UI component as
  `createElement as h(...)` calls instead of JSX.
- `moduleResolution: NodeNext` demands explicit extensions, so
  `import { notFound } from 'next/navigation'` — the import every Next.js
  codebase writes — failed `TS2307`, and a repair pass "fixed" it to
  `'next/navigation.js'`.

Neither is a bug the agent chose; both are the verifier's configuration leaking
into the product's source. So the config follows the manifest:

| declared | `module` / `moduleResolution` | `jsx` | also |
| --- | --- | --- | --- |
| `next` | `esnext` / `bundler` | `preserve` | `allowJs`, `isolatedModules`, `resolveJsonModule`, `esModuleInterop`, `DOM.Iterable` — i.e. what `create-next-app --typescript` generates |
| `react`, no `next` | `esnext` / `bundler` | `react-jsx` | the automatic runtime, so no `import React` is needed |
| neither | `NodeNext` / `NodeNext` | unset | byte-for-byte the previous Node-library config; non-web products are unaffected |

`strict: true` is **not** derived. It holds in every case — it is the verifier's
value, and it is not the kind of thing that gets traded away to make a config
work.

**When it is re-derived.** Not at bootstrap: the workspace `package.json` starts
empty and modules add to it, so the answer is unknowable then and `ensureWorkspace`
can only emit the `node` config. It is re-derived inside `deps.ts`, which already
exists to notice the declared dependency set moving, on every call and always
*before* the typecheck it governs. The file is rewritten **only when the derived
content actually differs**, so an unchanged run does not churn it — and so that
"the config changed this attempt" stays a true statement, which the next section
depends on.

**Workspace dependencies: the orchestrator installs them** (`orchestrator/deps.ts`).

Leaving `node_modules` empty had a cost that was invisible because it looked
like a warning: **TypeScript cannot check anything in a file whose imports it
cannot resolve.** On the first live run, M01 ("Platform foundation" — db, redis,
S3, secrets, telemetry, i.e. almost entirely third-party integration) was
therefore verified almost not at all; across three attempts the only errors that
surfaced were on local `./types.js` / `./errors.js` imports. So after a module's
call returns and **before** the typecheck, the orchestrator runs the install
itself. It is trusted code — the same argument that already justifies it running
`tsc`.

- **What gets installed:** exactly the `dependencies` + `devDependencies` the
  agent wrote into the workspace `package.json`. Nothing is added, pinned or
  substituted by the orchestrator, and every name and version range is
  **printed to the run log before the install runs**, so a human can see what a
  model decided to pull in.
- **`npm install --ignore-scripts`, always.** This is the whole basis on which
  this is acceptable: the package list was chosen by a model, and with npm
  lifecycle scripts disabled (`preinstall`/`install`/`postinstall`/`prepare`),
  **no code from any installed package is ever executed** — nothing runs the
  generated product, and `tsc --noEmit` only parses `.d.ts` declarations. The
  flag is load-bearing, not tidy-up: removing it turns a model-chosen package
  name into arbitrary code execution on the machine. There is a comment in
  `deps.ts` saying so.
- **Scoped to the workspace.** The install runs with `$PIPELINE_WORKSPACE` as
  `cwd`, never this repo.
- **Only when the dependency set changed.** `deps.ts` hashes the sorted
  `dependencies` + `devDependencies` objects and stores that hash in
  `$PIPELINE_WORKSPACE/.pipeline-install-state.json` after a *successful*
  install (the workspace is the natural home — the resume ledger already lives
  there). While the hash matches and `node_modules` is present, the install is
  skipped. Reformatting `package.json` does not trigger a reinstall; adding,
  removing or re-ranging a package does.
- **A failed install never fails the module.** No network, a registry error, a
  package name the model invented, a hanging install (5-minute timeout) — each
  is logged plainly and falls through to the pre-existing behaviour, where
  `TS2307` stays a warning. A dependency install failing is not the agent
  writing bad code, and must not be recorded as if it were.
- **`--no-install` turns it off**, for anyone who does not want model-chosen
  packages fetched onto their machine. It is a real supported choice and costs
  verification coverage, not safety; the run header says which mode is active.

**`.pipeline-install-state.json`** is orchestrator bookkeeping, excluded from
"files the agent wrote" alongside the progress ledger, and the workspace
`.gitignore` created at bootstrap covers `node_modules/`.

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
4. **`tsc --noEmit` is clean *of this module's own errors*.** The orchestrator
   runs TypeScript against the whole workspace, and charges the module only the
   diagnostics that are actually its own — see *Whose typecheck error is this?*
   below, which is the difference between failing a module and failing whoever
   happened to be building. Among the diagnostics it does own, every code fails
   it, with one state-dependent exception — `TS2307: Cannot find module`:

   - **If a dependency install has *not* succeeded** for the currently declared
     set (`--no-install`, the install failed, or `package.json` declares
     nothing), `TS2307` is logged as a warning with the reason, because it means
     "this dependency was never installed" — guaranteed rather than
     informative. Downgrade too little here and every module fails on a missing
     `node_modules`.
   - **If a dependency install *has* succeeded** for the currently declared set,
     every declared package is on disk, so a remaining `TS2307` means the agent
     **imported a package it never added to `package.json`**. That is a real
     defect the verifier previously could not see, and the one an agent is most
     likely to make once imports start resolving, so it **fails the module**,
     with a message that says exactly that rather than "fix the type error".

   Which of the two states applies is decided in exactly one place — the
   `dependenciesResolved` flag returned by `deps.ts` — and never re-derived
   elsewhere. Getting it backwards either fails every module or makes the
   typecheck verifier useless.

**Whose typecheck error is this? Baselining pre-existing diagnostics**
(`orchestrator/baseline.ts`).

`tsc` is run over the **whole workspace**, and the verifier used to fail the
module that happened to be building on every diagnostic it printed. That is an
attribution bug, and it cost real money. On a 53-module live run, **M06**
("Consent and privacy notice ledger") failed all three attempts, at **$2.78**,
on seven errors — five in `apps/web/src/modules/m04_ui/*` and
`apps/web/src/app/[locale]/*`, written by **M04**, and one in
`apps/web/src/modules/m01_platform/redis.ts`, written by **M01**. M06 wrote nine
files, all under `apps/web/src/modules/m06_consent/`, plus a migration. Not one
error was in a file it wrote. The agent could not have fixed them: it was told to
build M06, it built M06, and it was failed for someone else's code.

How those errors got there is the part worth keeping in mind. M01 and M04 passed
verification *before dependency installs existed*. With no `ioredis`, `react`,
`next` or `next-intl` on disk, every file importing them stopped at `TS2307` and
tsc could not see the rest of it. Adding installs later resolved those imports,
exposing genuine bugs that had been hidden all along — and they surfaced on
whichever module was running at the time.

So the workspace's current diagnostics are captured as a **baseline** before a
module's `query()` call, and afterwards the module is answerable for exactly two
things:

- diagnostics that are **new** relative to that baseline, and
- diagnostics in **files it wrote or modified** during the attempt — it touched
  the file, so it owns what it did to it. This is what still catches "module X
  edits a shared file and breaks it", including the case where X breaks a *call
  site* it never opened: that error is new, the call site was checkable before,
  and it stays X's.

Everything else is **inherited**: pre-existing, somebody else's, and it does not
fail the module.

- **The identity of a diagnostic is `(file, error code, message)` — no line
  number.** The baseline is compared across an edit, and edits move lines.
  Including the line would make ten inserted lines at the top of a shared file
  turn every pre-existing error below into a "new" one, landing on the current
  module — a smaller version of the bug this exists to fix. The message text
  already carries the type names that distinguish one error from another.
  Identical code *and* message *and* file are told apart by **counting** rather
  than by set membership: the baseline stores occurrences, and a module owns the
  excess, so adding a second copy of an existing error still fails it.
- **One extra `tsc` per stage, not per module.** The baseline is computed once at
  stage start, then *carried forward*: the post-verification typecheck of module
  N is the pre-call state of module N+1. What is carried forward is that run's
  diagnostics **minus the ones just charged to the module**. Subtracting is not a
  detail — without it, a module that failed on its own type errors would find
  them in the baseline on its retry, be told they are somebody else's, and pass
  without fixing anything.
- **A dependency install mid-stage invalidates the baseline, and is handled
  explicitly.** This is the specific trap that caused the incident: an install
  makes files visible to `tsc` that were hidden behind `TS2307` a moment ago, so
  the baseline taken before it genuinely does not contain those lines. The
  baseline therefore also records **which files were import-blocked when it was
  taken**; when `deps.status === "installed"` — an install that *actually ran*
  this attempt, not `"unchanged"` or `"disabled"` — new diagnostics in those
  files, in files the module did not touch, are attributed as
  `revealed-by-install` rather than to the module. The allowance is scoped as
  tightly as it can be: only after a real install, only in untouched files, only
  in files whose imports were previously unresolved. It costs no third `tsc`
  run, because the post-install typecheck *is* the verification run.
- **A tsconfig rewrite mid-stage is the same trap, entered by the other door,
  and reuses the same rule.** Re-deriving the workspace `tsconfig.json` changes
  the diagnostic set for the *whole* workspace exactly as an install does. When
  `deps.tsconfigRewritten` is true — the content genuinely differed and was
  replaced during this attempt — new diagnostics in files the module did not
  touch are attributed as `revealed-by-config`. This allowance is deliberately
  *wider* than the install's: an install can only reveal what an unresolved
  import was hiding, so `importBlockedFiles` bounds it exactly, whereas turning
  on `jsx`, `isolatedModules` or a different `lib` produces new diagnostics in
  files whose imports always resolved. There is no subset of files that safely
  bounds that, so the bound is the defensible one — rule 1 still runs first, so
  the module owns every file it *touched*, and it is simply not charged for
  untouched files on an attempt where the orchestrator changed the compiler out
  from under it. It fires only when the config actually changed, and never twice
  for the same change.

**Inherited errors are reported, not swallowed.** Not failing the module is
right; leaving real bugs unmentioned forever is not. So they are surfaced three
ways, with the owning module named from the ledger's `filesWritten` — the same
mapping that made the M06 failure diagnosable in the first place:

- **Per module, in the run log**, marked as pre-existing and explicitly not this
  module's fault (five lines then a count, the rest in the ledger):

  ```
        inherited: 3 pre-existing typecheck error(s) in files M06 did not write — NOT its fault and not counted against it (owners: M04 x2, M01 x1)
          [revealed-by-install, owner M01] src/m01/redis.ts(2,20): error TS2351: This expression is not constructable.
          [pre-existing, owner M04] src/m04/TrustChecklist.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
  ```

- **In the ledger**, as `entries[].inheritedDiagnostics`, so the record is
  durable and the reviewer stage can act on it later.
- **At the end of the stage**, as a count by owner, because an error that fails
  nobody and is reported to nobody never gets fixed:

  ```
    inherited typecheck errors outstanding at end of stage: 3 across 3 file(s), owned by 2 module(s)
      M04: 2 error(s) in 2 file(s) — src/m04/CostBadge.ts, src/m04/TrustChecklist.ts
      M01: 1 error(s) in 1 file(s) — src/m01/redis.ts
      these failed no module and are recorded per attempt in pipeline-progress.json (entries[].inheritedDiagnostics); the reviewer stage can act on them
  ```

Somebody has to decide to fix these. The pipeline's job is to make that visible,
not to hide it and not to bill it to the wrong module.

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

**Informed retries: a retried module is told what it broke.** Through Phase 5
this was the single most expensive bug in the pipeline. `buildModulePrompt` took
no failure parameter, so a module retried after a verification failure received a
**byte-identical prompt**. The orchestrator knew exactly what was wrong — it had
the `tsc` diagnostics in its hand — and discarded them, so the agent re-rolled
blind at full price for every attempt in its budget. One live run paid $2.29
to build `M01` and produced this:

```
apps/web/src/modules/m01_platform/db.ts(131,3): error TS2322: Type 'Promise<void> | undefined' is not assignable to type 'Promise<void>'.
FAILED — tsc --noEmit reported 1 error(s)
failed — 50 turns, $2.2903 (cumulative $5.3645); retry 1 of 3
```

One fixable line, and three more $2.29 attempts queued up that would never be
told about it. The run was stopped by hand at $5.36.

Now every rejection is classified, recorded, and rendered into the *next*
attempt's prompt as a clearly-marked leading section (`orchestrator/retry-context.ts`):

- **The real diagnostics, verbatim** — file, line, code, message. **TS2307
  unresolved-import lines are excluded while nothing is installed, and must stay
  excluded.** With an empty `node_modules`, every import of anything produces
  one; forty of them around one real `TS2322` is how the real error gets
  ignored. `classifyTypecheck` separates the two buckets and the retry context
  reuses that split rather than re-deriving it. Once a dependency install has
  succeeded, the surviving `TS2307` lines are *promoted* into this set by the
  verifier — at that point they are undeclared-dependency defects, and a retried
  agent that is not told which import it failed to declare cannot fix it.
- **A per-kind remedy.** The five kinds (`typecheck`, `stub`, `req-claim`,
  `no-files`, `sdk`) are kept apart because the instructions are not
  interchangeable: "go to line 131 and fix that type error, do not rewrite the
  module" is nothing like "you wrote placeholder code, implement it for real", and
  a generic "it failed, try again" is what gets skimmed. `verifyModule` now
  returns a `failureKind` alongside its reason, so the kind is *known* rather
  than pattern-matched back out of a prose sentence.
- **The files the previous attempt left behind**, which are still in the
  workspace, with an instruction to read and repair them rather than start over.
  The list is re-checked against disk first: a ledger entry says what *was*
  written, only `stat` says what is still there. If a human reverted the
  workspace in between, the section says so instead of sending the agent after
  files that are gone.
- **Nothing at all on a first attempt.** With no prior failure the prompt is
  byte-identical to the Phase 5 one, so the first attempt's cost measurements
  stay comparable.

The prompt builder moved to `orchestrator/module-prompt.ts` for this. `run.ts`
imports `query()` at module scope, so any script importing it to inspect a prompt
has the billable path in its import graph; a prompt is the cheapest thing here to
get wrong and the most expensive to verify live, so it has to be renderable by a
script that *cannot* spend money. `module-prompt.ts` and `retry-context.ts` both
import no SDK.

**The failure context persists in the ledger, across processes.** The alternative
— holding it in memory for the lifetime of one orchestrator process — was
considered and rejected. The reason is that the *files* survive a process exit:
stop a run after `M01` fails, re-run tomorrow, and a per-process design gives
that "first" attempt an identical prompt and lets it re-roll blind against broken
files it does not know it wrote. That is the original bug with extra steps. So
each failed ledger entry carries a structured `failure` record (ledger schema
**v3**; the bump is additive, v2 entries load unchanged), and the first attempt of
a new process is fed it and told plainly that the previous attempt ran in a
session it has no memory of. A v2 entry with no structured record is not wasted
either: its prose `failureReason` is parsed back into the best available record,
confined to one clearly-marked legacy function, because there is already one such
ledger in the wild — the halted `M01` run above.

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

**Only `"success"` counts as complete.** A failed module leaves its files in the
workspace *and* a `"failure"` entry in the ledger, and `completedModuleIds`
filters on the outcome — so a later run re-attempts it rather than mistaking that
partial output for a finished module. The same entry is what the re-attempt's
prompt is built from, which is the point: the files and the reason they were
rejected stay together, and the agent repairing them is told they are its own
prior output.

Resume is driven by `state.stage` (the last stage that *succeeded*) plus the
ledger, and never by the history log. So the `"in-progress"` entries a killed
process leaves behind cannot confuse it: they are an honest record that something
was started and never finished, `finishStage` closes only the entry the current
run opened, and only `outcome: "success"` moves `state.stage` — `"failure"` and
`"partial"` both leave it where it was.

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

### The repairer (on demand, never scheduled)

```
npm run orchestrator -- --repair          # every outstanding inherited diagnostic
npm run orchestrator -- --repair M04      # only the ones in files M04 wrote
```

**What it is for.** Attribution (`orchestrator/baseline.ts`) stops the module
that happens to be building from being failed for errors in an *earlier*
module's files. That is correct, and it has a consequence nobody chose: a
diagnostic ruled "inherited" fails nobody, so **nobody is ever asked to fix
it**. On a live 53-module build, seven errors in files written by M01 and M04
were inherited by every module after them. No module-scoped builder is permitted
to touch another module's files, and the `reviewer` stage that could act on them
only runs after all 53 modules are built — roughly $121 away. A cross-module
error had no owner. The repairer is the owner.

**Why it is on demand rather than a stage.** This is evidence, not taste. The
pipeline's own research file (`docs/okf.md` §4) records that adding roles to a
multi-agent pipeline is frequently *negative*: a five-role pipeline measured
lower accuracy than a simpler arrangement (**75% → 45%**), a two-agent team beat
a three-agent waterfall, and roughly **37%** of observed multi-agent failures
come from inter-agent misalignment rather than from any single agent being bad
at its job. Every role added to `PIPELINE_STAGES` is another handoff that can
misalign, on every run, forever. What is defensible against that research is a
narrowly-scoped repairer handed an exact list of diagnostics and verified
mechanically afterwards; what it warns about is a general "fixes anything" role
sitting in the module loop. So the shape is copied from `critic` — it is **not**
in `PIPELINE_STAGES`, is never auto-invoked, and nothing in the module loop
calls it. Like `--critic`, it is a complete alternative to running the pipeline:
no stage runs and `state/run.json` is not touched.

**It repairs what is broken now, not what was broken then.** Targets come from a
**fresh `tsc --noEmit`** over the workspace, never from the ledger's stored
`inheritedDiagnostics`. The ledger records history — errors it lists may since
have been fixed, moved line, or been joined by ones no module attempt observed.
The ledger's role here is the narrower thing `tsc` cannot do: mapping each
diagnostic to the module that wrote the file, via `entries[].filesWritten`.

**Its tools are `Read, Write, Edit, Grep, Glob` — no `Bash`**, per Decision
LD-1, so it cannot run the compiler and its self-report is never the evidence.
Its prompt pastes the diagnostics verbatim and in full, which is the opposite of
what `buildModulePrompt` does with `docs/lld.md`, and deliberately: an agent told
to "fix the type errors" would have to decide *which*, and that is exactly the
freedom that must not be given to something editing another module's files. It
may Grep the owning module's section of `docs/lld.md` and `docs/implementer.md`
so a fix matches what the module was *specified* to do, and it is told in as
many words not to reach for `any`, `as unknown as`, `@ts-ignore`, or type
widening — the same wording the retry-context prompt uses.

#### The rollback guarantee

A repair is **accepted only if both** hold:

1. every targeted diagnostic is gone, **and**
2. **no new diagnostic appeared anywhere in the workspace.**

Condition 2 is the one that makes this safe. The repairer edits files other
modules import, and the cheapest way to make seven errors disappear is to change
a shared signature — which *moves* them to the call sites rather than fixing
them. Checking only the targeted files would score that as a total success. A
repair that fixes three errors and introduces two is not a repair, and there is
no partial credit.

Before the agent runs, the workspace is committed (`orchestrator/vcs.ts`,
`execFile` on `git`, never a shell — the rule `orchestrator/deps.ts` follows for
`npm`). If verification fails, the workspace is `reset --hard` to that commit and
`clean -fd`'d, so **a failed repair leaves nothing behind** — not an edit, and
not a file the agent created. `clean` is deliberately without `-x`, so
`node_modules/` survives: deleting an install the orchestrator paid for in order
to undo an edit would be worse than the edit. A workspace with no commits yet is
handled by construction — the snapshot simply becomes the repository's first
commit — and **if git is unavailable at all, the repairer declines to run**
rather than repairing with no way back.

Comparison is by multiset of `(file, code, message)`, the same identity
`baseline.ts` uses and for the same reason: a repair edits files, edits move
lines, and a line-sensitive key would score every surviving error below an edit
as brand new.

#### Where the outcome is recorded

In the **workspace ledger** (`pipeline-progress.json`), in a **sibling
`repairs[]` array** rather than in `entries[]`, and the distinction matters.
`entries[]` is the *module* ledger: `fileOwners()` reads
`entries[].filesWritten` and gives each file to its last writer, and
`completedModuleIds()` reads `entries[].outcome` to decide what a re-run skips.
A repair recorded there would become the owner of every file it edited — so
every future diagnostic in M04's code would be attributed to the repairer
instead of to M04, destroying the exact attribution the repairer exists because
of — and could make a module look built or unbuilt. Same file, because a repair
is a fact about this workspace's code and has to travel with it (and the
reviewer stage already reads this file); separate array, because the module
ledger's readers must not see it at all.

Each record carries an `R-n` id, what it was asked to fix and whose it was, what
changed, the snapshot commit, cost and turns, and `accepted` / `rolled-back` /
`declined` with a reason. Rejected sessions are recorded too — arguably the more
useful of the two, since "an agent was pointed at these and could not fix them
without breaking something" is what a human needs before paying for a second
attempt. The ledger is written **after** any rollback, because it is a tracked
file and a `reset --hard` would erase a record written before it.

The budget cap is `MAX_BUDGET_USD_PER_REPAIR` ($3, below the $8 per-stage cap):
a repair changes a handful of lines in existing files, and a repairer that has
spent $3 has stopped doing that and started doing something else.

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
                   deps.ts      `npm install --ignore-scripts` of the deps the
                                agent declared, hashed so it runs only when the
                                set changes. Never throws: a failed install
                                falls back to TS2307-as-warning.
                   verify.ts    per-module verification + stub detection
                   baseline.ts  whose typecheck error is this: baselines the
                                workspace's diagnostics before each module and
                                charges it only what is new or in a file it
                                touched. Handles the mid-stage dependency
                                install that changes what `tsc` can see.
                   progress.ts  the workspace progress log / resume ledger,
                                plus the sibling repairs[] array
                   repair.ts    the on-demand repairer: which diagnostics to
                                target, the accept/reject rule (targets gone AND
                                nothing new anywhere), and the prompt. NO SDK
                                import, for module-prompt.ts's reason. Its
                                header has the evidence for why a repairer is an
                                auxiliary agent and not a pipeline stage.
                   vcs.ts       snapshot-and-restore of the workspace via
                                execFile on `git` (never a shell). The rollback
                                is what makes a repair safe to attempt at all;
                                handles the no-commits-yet workspace.
                   module-prompt.ts
                                the per-module spec-implementer prompt.
                                NO SDK import, so a prompt change can be
                                rendered and read without a billable call.
                   retry-context.ts
                                what a retried module is told about its own
                                previous attempt: failure kinds, the filtered
                                diagnostics, the per-kind remedy. Also owns
                                MAX_ATTEMPTS_PER_MODULE and counts a module's
                                attempts out of the ledger. No SDK import, and
                                no import of progress.ts/verify.ts (both
                                depend on it).
                   router.ts    the router contract: output schema, runtime
                                validation, the confidence gate, planDrain.
                                PURE — no SDK import, so the gate can be
                                exercised without a billable call.
                   routing.ts   the append-only routing log + RD-n allocation
                   result-failure.ts
                                deterministic vs transient SDK result
                                subtypes, the halt message that reports what
                                a capped call still managed to write, and the
                                halt for a module that used up its per-module
                                attempt budget.
                                Type-only SDK import, so it too can be
                                exercised without a billable call.
  setup.sh         idempotent bootstrap
```

Generated code is **not** in this tree — it lives at `$PIPELINE_WORKSPACE`, or
`~/agent-pipeline-workspace` by default, with its own git history.
