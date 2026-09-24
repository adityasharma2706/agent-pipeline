<!-- Written by: implementation-planning stage (module list) and appended to by spec-implementer (progress log). Read by: system-design, spec-implementer. -->

# Implementation Plan: Module Breakdown and Build Order

**Summary**
- 36 buildable modules (M01–M36) in 8 phases. Each phase ends at a milestone that can be verified and committed before the next phase starts.
- The order is foundations first, then a walking skeleton (document stages running end to end with status, resume and report), then build/verify, E2E, the Feedback Router, the Critic, and finally the Should/Could extras.
- Every module lists the requirement IDs from `docs/design.md` §7 it satisfies and the modules it depends on. Every requirement ID is covered by at least one module (see the coverage matrix and the final section).
- Component names follow `docs/architecture.md` §3. Architecture decisions are cited as AD-n.

**How to read this:** "Depends on" lists only *build-time* dependencies (what must exist before this module can be built and tested). Some modules also *extend* earlier modules, for example by adding a CLI verb or a report section. Those extensions are listed under "Extends".

---

## Phase 0: Foundations (no agent calls)

### M01 Config & Policy
Loads `pipeline.config.yaml` and merges CLI-flag overrides. Holds the typed policy object: default budget, stage shares, model tier map, checkpoint list, router thresholds and caps (3 go-backs per run, 2 attempts per issue), unattended hand-edit policy (default: stop and ask, AD-12), sandbox mode, critic auto-invoke point, flake re-run count, warning threshold.
- **Depends on:** none
- **REQs:** REQ-003, REQ-027, REQ-037, REQ-049, REQ-070, REQ-071 (the configuration side of each)

### M02 Document Model & Contract Validator
A markdown parser for stage documents. It reads the HTML header comment and the YAML front-matter (`stage`, `run_id`, `generated_from`, `schema_version`), and extracts **ID blocks** (REQ-n, AD-n, T-n, INC-n, E2E-n, F-n) and plain `REQ-nnn` cross-references (AD-4). It also computes per-block content hashes. The contract validator checks: header present, summary of 5 lines or fewer, Assumptions and Open questions sections present, well-formed and unique ID anchors, every REQ has acceptance intent, and ADs carry context/decision/consequences/REQs/status.
- **Depends on:** none
- **REQs:** REQ-004, REQ-011, REQ-012, REQ-020, REQ-021, REQ-022, REQ-023

### M03 VCS Gateway
The only module that commits. It creates and uses the `pipeline/<run-id>` branch (AD-8). It makes one commit per stage, increment and rework unit, with structured trailers (`Pipeline-Run`, `Stage`, `Refs:`, `Routing-Decision`). It detects non-pipeline commits and working-tree edits, and maps units to commits so any single one can be inspected or reverted.
- **Depends on:** M01
- **REQs:** REQ-017, REQ-026, REQ-038 (diff visible), REQ-063

### M04 Run State, Event Log & Run Lock
Handles the `state.json` snapshot using atomic write-rename, the append-only `events.jsonl`, and the project lock file with PID and heartbeat. Stale locks are recovered (AD-16). It also reconciles state from git trailers when a commit has no matching state update (architecture §6).
- **Depends on:** M01
- **REQs:** REQ-005, REQ-006, REQ-009, REQ-062 (event source for verbose output)

### M05 Budget & Cost Ledger
Handles the append-only `ledger.jsonl`, with cost attributed by run, stage, increment, go-back and critic. It enforces the run budget and optional per-stage shares. Its pre-call check computes `min(stage remaining, run remaining)`. It raises the warning-threshold event with a projection, sends a budget-exhausted signal, and exposes a historical per-stage cost query used for estimates (AD-14).
- **Depends on:** M01, M04
- **REQs:** REQ-070, REQ-071, REQ-072, REQ-073, REQ-074, REQ-075

**Milestone 0:** unit tests pass for parsing and validation, commits with trailers, lock recovery, and ledger enforcement. No API key is needed.

---

## Phase 1: Walking skeleton (document stages end to end)

### M06 Agent Host Adapter
The only module that imports the Claude Agent SDK (AD-2). It wraps `query()` with: model selection by role tier (AD-13), permission profiles (read-only / docs-write / code-write) enforced via permission callbacks and PreToolUse hooks, shell execution denied or routed to the sandbox, per-call `max_budget_usd` from M05, usage streamed to the ledger, and per-stage transcript logs. Every unit of work gets a fresh session.
- **Depends on:** M01, M05
- **REQs:** REQ-056 (permission side), REQ-062, REQ-070, REQ-072, REQ-074, REQ-081 (single swap point)

### M07 Stage Registry & Mode Profiles
Declarative stage manifests. Each declares: id, output document, required inputs, role template, model tier, permission profile, budget share, whether it can be a checkpoint, and which profiles (`full`, `fast`) include it. Includes the stage dependency graph that M09 uses.
- **Depends on:** M01
- **REQs:** REQ-003, REQ-008 (profile mechanism), REQ-010, REQ-013, REQ-071

### M08 Trace Index
Derived graph rebuilt from `docs/`, test manifests and verdict files, and cached in `.pipeline/trace.json`. Its edges are REQ→AD, REQ→task, task→INC/commit, REQ→E2E, E2E→verdict/evidence, and finding→REQ. It answers coverage, orphan and downstream-impact queries.
- **Depends on:** M02
- **REQs:** REQ-015, REQ-023, REQ-024, REQ-033, REQ-052

### M09 Staleness / Dependency Tracker
Records the upstream block hashes each artefact was generated from (`.pipeline/hashes/`). It computes staleness at ID-block granularity, falling back to section and then document (AD-5), and propagates it transitively. It classifies hand edits as `user-edit` and detects answers written into Open questions sections. It returns an explainable stale set at the level of documents, sections, REQ IDs and increments.
- **Depends on:** M02, M03, M07, M08
- **REQs:** REQ-006, REQ-007, REQ-013, REQ-026, REQ-027, REQ-028, REQ-033, REQ-038

### M10 Stage Runner & Preservation Guard
Runs one stage, in normal or revise mode, in this order: precondition check via M09, context assembly, agent call via M06, contract validation via M02 (one re-prompt, then escalate), the Preservation Guard (in revise mode, non-stale blocks must keep the same hash), then commit via M03, record hashes, and rebuild the trace index.
- **Depends on:** M02, M03, M06, M07, M09
- **REQs:** REQ-002, REQ-004, REQ-011, REQ-012, REQ-013, REQ-026, REQ-038

### M11 Document Stage Definitions
Role prompts and manifests for the six document stages: understanding, classification (with the supported-type verdict: web/CLI full, library/API partial, others unsupported), discovery, design (permanent REQ IDs plus EARS-style acceptance intent), architecture (ADR-form ADs citing REQs, superseded ADs kept), and implementation planning (tasks and increments citing REQs, every Must REQ covered). Each stage records assumptions and open questions instead of blocking.
- **Depends on:** M07, M10
- **REQs:** REQ-002, REQ-010, REQ-012, REQ-014, REQ-020, REQ-021, REQ-022, REQ-023

### M12 Run Controller
The explicit state machine `idle → running → {checkpoint | escalated | budget_stopped | crashed} → … → done`. It acquires the lock, persists state at safe points, and picks the next unit from the registry profile and the stale set. It stops cleanly on a budget-exhausted signal and resumes by re-deriving the next work from files, git and state. At this phase it only covers forward flow. Rework scheduling is added in M28.
- **Depends on:** M04, M05, M07, M09, M10
- **REQs:** REQ-002, REQ-006, REQ-009, REQ-010, REQ-013, REQ-073

### M13 CLI Command Surface & Progress Renderer
Core verbs: `start` (from a sentence or a file, with `--budget`), `status`, `resume` (with extra budget), and `budget`. Renders one compact progress line per stage or increment with cost so far, shows the supported-type line after classification, shows budget warnings, and has a `--verbose` mode that tails the per-stage logs. It contains no business logic. Later modules add verbs to it.
- **Depends on:** M04, M05, M12
- **REQs:** REQ-001, REQ-005, REQ-006, REQ-014 (early statement to the user), REQ-062, REQ-070, REQ-074, REQ-075

### M14 Reporter
Renders `docs/run_report.md` at **every** stop. Contents: a one-line outcome, the coverage matrix with gaps highlighted, go-backs and their outcomes, open critic findings, the open-questions roll-up (answered/unanswered, with source links), itemised cost per stage and per go-back, how to run the product, and next actions. It also renders the `status` view and the escalation block. Sections whose data sources don't exist yet show "n/a" until M21, M28 and M32 fill them in.
- **Depends on:** M02, M04, M05, M08, M09
- **REQs:** REQ-005, REQ-024, REQ-060, REQ-061, REQ-074

**Milestone A:** `start "<idea>"` runs understanding through implementation planning on a `pipeline/<run-id>` branch, with one commit per stage. `status` works. Killing the process mid-run and running `resume` continues without redoing completed stages. A budget stop writes a report.

---

## Phase 2: Checks, control and build

### M15 Decision Log
Renders `docs/decisions.md` from events: stage, router and user decisions, each with what, why and what it replaced (supersession links). It also keeps AD `Status: superseded by AD-n` consistent.
- **Depends on:** M02, M04
- **REQs:** REQ-022, REQ-025

### M16 Consistency Checker (read-only)
Runs after design, architecture and implementation planning. Its deterministic layer uses M08 to find uncovered Must REQs, orphan tasks and unknown IDs, and uses M03 git history to find reused or renumbered IDs. Its LLM layer runs a read-only contradiction scan over document pairs. Findings go to a signal queue that M25 consumes (they are recorded in the report until the router exists).
- **Depends on:** M03, M06, M08, M10
- **REQs:** REQ-015, REQ-020, REQ-023, REQ-034

### M17 Human Control: Checkpoints, Restart, Hand Edits
Handles the checkpoint state and the `approve` / `reject` verbs, `restart --from <stage>` (marks everything downstream stale), and the resume-time hand-edit flow: detect the edit, list the stale set, then confirm (attended) or apply policy (unattended, default stop-and-ask). Open-question answers are treated as edits, and edits are logged as "user edit".
- **Depends on:** M03, M09, M12, M13, M15
- **Extends:** M13 (verbs), M14 (answered state in the roll-up)
- **REQs:** REQ-003, REQ-007, REQ-026, REQ-027, REQ-028, REQ-061

### M18 Sandbox Manager
Docker/Podman container execution (AD-9): worktree mount, no host home directory, network egress restricted, CPU/memory/time limits. It shows a **consent block** (image, mounts, commands, network policy) before the first execution in a run and records it in state. The degraded `local-restricted` mode requires explicit opt-in and is labelled in the report. It exposes an "exec" API and a "start app / stop app" API. **Nothing that executes generated code may be built before this module.**
- **Depends on:** M01, M04
- **REQs:** REQ-016, REQ-044, REQ-050, REQ-056

### M19 Increment Executor & Verification Gate
The implementer stage definition plus a per-increment loop: the agent writes code (code-write profile), the gate builds and runs the increment's own tests in the sandbox, then a commit is made with `Refs: REQ-…, T-…, INC-…`. On failure it makes a bounded local retry, counted against the per-issue attempt cap, and then emits a signal.
- **Depends on:** M03, M10, M12, M18
- **REQs:** REQ-016, REQ-017, REQ-023, REQ-037, REQ-056

### M20 Reviewer (read-only)
The review stage definition. A read-only agent emits findings (location, severity, affected REQ/AD) into `docs/review.md` and the signal queue. It never edits code.
- **Depends on:** M06, M08, M10
- **REQs:** REQ-018, REQ-034

**Milestone B:** a full-mode run produces committed code, one commit per increment, with verification in the sandbox and a consent block shown first. Consistency and review findings appear in the report. Checkpoints, restart-from-stage and hand-edit detection work.

---

## Phase 3: End-to-end testing

### M21 E2E Harness Core
Contains:
- **Scenario Deriver:** sees only REQs, acceptance intent, the supported-type verdict and the public entry points. It has no source access (AD-11), and writes `E2E-n` scenarios that cite REQs.
- **Driver plug-in interface.**
- **Flake Filter:** re-runs failures N times in a fresh instance and marks mixed results `flaky`.
- **Requirement Judge:** per-REQ pass / fail / not verifiable with a reason. It has limited read-only code access, used only to detect omissions.
- **Evidence Store:** `.pipeline/evidence/<run>/<E2E-n>/`, linked from verdicts.
- **Regression mode:** previously failing scenarios, previously passing scenarios for affected REQs, and a smoke subset.

Unsupported product types get `not verifiable: unsupported type`.
- **Depends on:** M06, M08, M10, M11, M18
- **Extends:** M14 (verdict and coverage sections)
- **REQs:** REQ-014, REQ-039, REQ-051, REQ-052, REQ-053, REQ-054

### M22 CLI E2E Driver
A command runner inside the sandbox with assertions on stdout, stderr, exit code and golden files. It captures step logs as evidence.
- **Depends on:** M18, M21
- **REQs:** REQ-050, REQ-054

### M23 Web E2E Driver
Playwright inside the sandbox image (AD-10). It uses Playwright MCP for agent-driven exploration and generated Playwright specs for repeatable re-runs, captures accessibility snapshots, and takes screenshots on failure. Selector repair is kept separate from behavioural failure.
- **Depends on:** M18, M21
- **REQs:** REQ-050, REQ-054

### M24 Library / HTTP API E2E Driver (Should)
A consumer-script driver for libraries plus HTTP smoke and contract checks for APIs.
- **Depends on:** M18, M21
- **REQs:** REQ-055

**Milestone C:** a complete forward run (without rework) for a CLI idea and a small web-app idea ends with per-REQ verdicts, linked evidence, flake marking, and an honest report. A mobile idea gets "not verifiable" verdicts.

---

## Phase 4: Feedback Router (core differentiator)

### M25 Router Signal Intake & Issue Registry
Normalises review findings, E2E failures (only after the flake filter), consistency findings, Verification Gate failures, promoted critic findings and user reports into `Issue` records. Each issue gets a stable issue key so recurrences are recognised. Flaky items are recorded but not routed.
- **Depends on:** M16, M19, M20, M21
- **REQs:** REQ-034, REQ-053

### M26 Router Evidence & Attribution
Evidence assembly walks the chain REQ→AD→task→INC→scenario→verdict in M08. Attribution has two layers: deterministic rules encoding okf §3.4, and a strong-tier LLM attributor that ranks candidate stages over documents and evidence. Confidence is bucketed by agreement, with a one-line reason and the alternatives listed. Any earlier stage can be a target.
- **Depends on:** M06, M08, M25
- **REQs:** REQ-030, REQ-031, REQ-032

### M27 Router Planning, Impact & Gate
Nearest-first target selection, escalating one step further back when the same issue key recurs. The impact is the stale set from M09. The cost estimate is historical stage cost × stale fraction + regression cost. The gate applies REQ-036 policy, the go-back and attempt caps, and the budget check, and returns `auto-proceed` / `ask-user` / `escalate`.
- **Depends on:** M01, M05, M09, M26
- **REQs:** REQ-033, REQ-035, REQ-036, REQ-037, REQ-072

### M28 Rework Execution & Outcome Tracking
Writes Routing Decisions to `docs/routing.md` and `.pipeline/routing.jsonl`. Extends the Run Controller to mark the stale set and schedule revise-mode reruns in dependency order: stage runner, then increments, then E2E regression mode. Marks each outcome `resolved` / `recurred` / `rejected` / `overridden`. Recurrence goes back into M27.
- **Depends on:** M10, M12, M14, M15, M19, M21, M27
- **Extends:** M12 (rework states), M14 (go-backs section), M15 (router decisions)
- **REQs:** REQ-030, REQ-038, REQ-039, REQ-041

### M29 Router Overrides & Escalation UX
Adds the verbs `route --to <stage>` (manual go-back or redirect) and `reject` (accept as a known issue). The escalation block shows the problem, the options with the router's recommendation first, and the exact command to continue with each option, both in the terminal and in the report. User decisions enter the gate as user-authored and are logged.
- **Depends on:** M13, M14, M28
- **REQs:** REQ-036, REQ-037, REQ-040, REQ-041

**Milestone D:** the seeded-fault scenarios from design F2 (design-origin contradiction) and F7 (recurrence leading to escalation in unattended mode) behave as specified. Caps stop loops. Rework preserves non-stale blocks, and the change shows as a diff. The routing log records outcomes.

---

## Phase 5: Critic

### M30 Critic Service Core (document mode)
A separate entry point that takes a shared read-only snapshot at HEAD and never takes the run lock (AD-15). It adds the `critic` verb. It runs a cognitive-walkthrough agent over one document or a set of documents. Personas are extracted from the understanding and discovery documents (primary persona by default, with `--persona` / `--flow` overrides). Findings follow a fixed schema (location, problem, heuristic/guideline, severity, evidence, suggestion, REQ IDs). Every report carries the "Simulated reviewer, not real-user evidence" banner and a reliability note. Cost is charged to the run ledger, or to a standalone cap when no run exists.
- **Depends on:** M02, M03, M05, M06, M13
- **REQs:** REQ-042, REQ-043, REQ-045, REQ-046, REQ-048

### M31 Critic App Mode
Starts the built product in the sandbox and reuses the web and CLI drivers. It is coverage-gated: interactions covering the requested flow must be recorded before the report is accepted, and findings that don't cite an action or observation are rejected.
- **Depends on:** M18, M22, M23, M30
- **REQs:** REQ-043, REQ-044

### M32 Findings Store, Promote & Dismiss
`docs/critic/<ts>.md` plus `findings.jsonl`, with states open / promoted / dismissed. Adds the `finding promote|dismiss` verbs. Promotion sends the finding to M25. A dismissal is keyed by (target hash, finding fingerprint) and suppressed while the target is unchanged. Open findings appear in the report.
- **Depends on:** M14, M25, M30
- **REQs:** REQ-034, REQ-047

### M33 Critic Auto-Invocation (Could)
A registry hook at one configured point (default off; suggested point is after E2E when at least 15% of the budget remains). It is budget-gated.
- **Depends on:** M05, M07, M30, M31
- **REQs:** REQ-049

**Milestone E:** design flow F3 works: an app-mode critique of a flow, then one dismissal and two promotions routed to different stages.

---

## Phase 6: Modes and estimates

### M34 Fast Mode & Pre-run Estimate
The `fast` profile content: a merged "brief" stage that still emits REQ IDs, acceptance intent and the supported-type verdict, and skips discovery and architecture. A cheap classifier suggests fast mode when an idea looks small, and the user decides. Also a pre-run cost estimate from mode profile × priors × idea size (Could).
- **Depends on:** M05, M07, M11, M13
- **REQs:** REQ-008, REQ-076

**Milestone F:** design flow F6 completes in fast mode with verdicts, routing and a report. Its cost is compared with the full run.

---

## Phase 7: Could-have extensions

### M35 Baseline Runner (Could)
Runs a single-agent build in a separate worktree and sandbox, reuses the E2E harness and scenario set, and writes a side-by-side verdict and cost comparison. Adds the `baseline` verb.
- **Depends on:** M05, M18, M21, M22, M23
- **REQs:** REQ-080

### M36 Plugin Packaging (Could)
A thin host shell that exposes the pipeline inside an existing coding-agent environment. It builds on the M06 swap point and the M13 verbs. Its shape depends on architecture open question 6 (MCP server vs a skill that shells out to the CLI).
- **Depends on:** M06, M13 (and a finished core for Must parity)
- **REQs:** REQ-081

---

## Dependency overview

```
M01 ─┬─ M03 ─┐          M02 ─┬─ M08 ─┐
     ├─ M04 ─┼─ M05 ─ M06    │       │
     └─ M07 ─┴───────────────┴─ M09 ─┴─ M10 ─┬─ M11
                                             ├─ M12 ─ M13 ─ M17
                                  M14 ◀──────┘
M15, M16, M18 ─ M19, M20 ─▶ M21 ─ M22/M23/M24 ─▶ M25 ─ M26 ─ M27 ─ M28 ─ M29
M30 ─ M31 ─ M32 (needs M25) ─ M33 ;  M34 ;  M35 ;  M36
```

## Requirement → module coverage matrix

| REQ | Modules | | REQ | Modules |
|---|---|---|---|---|
| REQ-001 | M13 | | REQ-037 | M01, M19, M27, M29 |
| REQ-002 | M10, M11, M12 | | REQ-038 | M03, M09, M10, M28 |
| REQ-003 | M01, M07, M17 | | REQ-039 | M21, M28 |
| REQ-004 | M02, M10 | | REQ-040 | M29 |
| REQ-005 | M04, M13, M14 | | REQ-041 | M28, M29 |
| REQ-006 | M04, M09, M12, M13 | | REQ-042 | M30 |
| REQ-007 | M09, M17 | | REQ-043 | M30, M31 |
| REQ-008 | M07, M34 | | REQ-044 | M18, M31 |
| REQ-009 | M04, M12 | | REQ-045 | M30 |
| REQ-010 | M07, M11, M12 | | REQ-046 | M30 |
| REQ-011 | M02, M10 | | REQ-047 | M32 |
| REQ-012 | M02, M10, M11 | | REQ-048 | M30 |
| REQ-013 | M07, M09, M10, M12 | | REQ-049 | M01, M33 |
| REQ-014 | M11, M13, M21 | | REQ-050 | M18, M22, M23 |
| REQ-015 | M08, M16 | | REQ-051 | M21 |
| REQ-016 | M18, M19 | | REQ-052 | M08, M21 |
| REQ-017 | M03, M19 | | REQ-053 | M21, M25 |
| REQ-018 | M20 | | REQ-054 | M21, M22, M23 |
| REQ-020 | M02, M11, M16 | | REQ-055 | M24 |
| REQ-021 | M02, M11 | | REQ-056 | M06, M18, M19 |
| REQ-022 | M02, M11, M15 | | REQ-060 | M14 |
| REQ-023 | M02, M08, M11, M16, M19 | | REQ-061 | M14, M17 |
| REQ-024 | M08, M14 | | REQ-062 | M04, M06, M13 |
| REQ-025 | M15 | | REQ-063 | M03 |
| REQ-026 | M03, M09, M10, M17 | | REQ-070 | M01, M05, M06, M13 |
| REQ-027 | M01, M09, M17 | | REQ-071 | M01, M05, M07 |
| REQ-028 | M09, M17 | | REQ-072 | M05, M06, M27 |
| REQ-030 | M26, M28 | | REQ-073 | M05, M12 |
| REQ-031 | M26 | | REQ-074 | M05, M06, M13, M14 |
| REQ-032 | M26 | | REQ-075 | M05, M13 |
| REQ-033 | M08, M09, M27 | | REQ-076 | M34 |
| REQ-034 | M16, M20, M25, M32 | | REQ-080 | M35 |
| REQ-035 | M27 | | REQ-081 | M06, M36 |
| REQ-036 | M27, M29 | | | |

Gaps in the numbering (e.g. REQ-019, REQ-029, REQ-057–059) are intentional, per design §7 and assumption 6. They are not missing requirements.

---

## Assumptions
1. Module boundaries follow architecture §3 components. Large components (Router, Critic, E2E) are split so that each module can be verified on its own.
2. Should and Could items (M17, M24, M33–M36) come after the Must core, except where a Must depends on them. M17 sits in Phase 2 because hand-edit detection shares machinery with resume (REQ-006).
3. Before M25 exists, consistency and review findings go into a queue and appear in the report. They are not routed until Phase 4, so Milestones B and C are "forward-only".
4. Prompts for the implementer, reviewer, scenario deriver, judge, attributor and critic live with their owning modules (M19, M20, M21, M26, M30), not in M11.
5. The sandbox base image (Node + Playwright) is built as part of M18/M23 and pulled on the first run.
6. Seeded-fault fixture projects for Milestone D are built alongside M28 as test assets, not as a separate module.

## Open questions
1. REQ-081 (M36): the packaging shape is blocked on architecture open question 6. The module may be dropped from v1 if neither option preserves Must behaviour.
2. M21: how Requirement Judge code access is limited (architecture open question 5) affects that module's scope. It is assumed read-only and omission-only for now.
3. M28: Preservation Guard heuristics for sections without IDs (architecture open question 4) may need a small follow-up module if whole-section hashing proves too strict.
4. M35: should the baseline share the pipeline's derived scenarios or derive its own (architecture open question 8)? The default is to share them.
5. Should M24 (Library/API driver, Should) be pulled forward if the dogfood target (the pipeline itself as a CLI) doesn't need it? Currently it is not needed, so it stays in Phase 3 as optional.

## Requirements not yet covered

**None. Every requirement ID in `docs/design.md` §7 (REQ-001–REQ-018, REQ-020–REQ-028, REQ-030–REQ-056, REQ-060–REQ-063, REQ-070–REQ-076, REQ-080–REQ-081) maps to at least one module in the matrix above.**

Some requirements are covered only by conditional or low-priority modules:
- **REQ-081:** covered by M36, but only as a Could-have. Its design is still pending (see open question 1), so it may be deferred.
- **REQ-049, REQ-076, REQ-080:** covered by Could-have modules M33, M34 and M35, which sit at the end of the build order and may be deferred without affecting any Must requirement.
