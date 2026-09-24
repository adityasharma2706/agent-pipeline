<!-- Written by: design-planning stage. Read by: architecture-planning, implementation-planning. -->

# Product Design: Functional Requirements and Experience Direction

**Product:** a local, developer-facing pipeline that turns a one-sentence product idea into documented, reviewed and end-to-end-tested software. It has two distinctive features: a **feedback router** that sends problems back to the stage where they started, and an **on-demand critic** that reviews output from a human/UX point of view.
**Inputs:** `docs/idea.md`, `docs/product_understanding.md`, `docs/classification.md`, `docs/okf.md`.
**Scope of this document:** what the product does, how users experience it, and why. It covers the product level only. It does not choose a host platform, orchestration mechanism, file schema, data model or implementation approach. Those belong to architecture-planning. Where this document describes something the user sees (a command, a report section), the names are illustrative unless marked otherwise.

**Requirement IDs are permanent.** All functional requirements are listed in one table in §7. Other sections refer to requirements by ID.

---

## 1. Design stance: the principles behind every decision

These principles come from the research in `okf.md`. When a later stage faces a trade-off, it should resolve it with these.

| # | Principle | Why (evidence) |
|---|---|---|
| P1 | **The router and the critic are the product; the stage list is not.** Put design effort where competitors are weak: attributing failures correctly, and giving human-centred critique that someone can act on. | okf §0.1, §2.3; classification §5.3 |
| P2 | **Show your evidence and your confidence.** Every routing decision, verdict and critique carries its evidence and says how sure it is. The product never presents a guess as a fact. | Attribution is only about 50–70% accurate (okf §3); silent failures (classification §5.5) |
| P3 | **Requirements are the backbone.** Every requirement has a stable ID and can be traced from discovery to plan, code, test and verdict. The most common measured failure is *omitted requirements*. | okf §0.5, §4 |
| P4 | **Every stage must earn its cost.** Keep ceremony low, offer a fast path for small ideas, and let the user compare against a single-agent baseline. | MAST; "Two Calls Beat Five Agents"; SDD ceremony criticism (okf §4, §10) |
| P5 | **Don't rework what already works.** Rework happens only when a check fails, is limited to what the problem actually affects, and leaves correct content alone. | Refinement dropped HumanEval from 96% to 66% (okf §4) |
| P6 | **Cost is the price.** Budgets, limits and a per-stage cost breakdown are core features. | Meter shock (okf §9) |
| P7 | **Documents are the interface.** The main thing the user reads is a set of plain markdown documents they can edit by hand. The terminal output is a thin progress layer on top of them. | Inspectability expectation (okf §10) |
| P8 | **Run unattended, stop honestly.** By default the run proceeds without the human. When it cannot proceed safely (low-confidence rework, loop limit, budget), it stops cleanly, explains why, and can be resumed. It does not bluff its way forward. | product_understanding §5.3; MAST 1.5 and 2.2 |
| P9 | **Advice is separate from action.** Checkers (reviewer, critic, consistency check) report problems; they don't fix them silently. Rework is decided by the router or the user. | Spec Kit `analyze`; AppLooper's read-only testers (okf §2.3) |

---

## 2. Users and what they need to get done

**Primary persona: "Solo builder Sam".** A developer or technical founder with more ideas than time. Sam works in a terminal inside a git repo, pays their own model bill, and will read a two-page summary but not forty pages of generated specs.

| Job to be done | What Sam needs to see | Requirements |
|---|---|---|
| "Turn my idea into a working prototype without doing every step myself." | One command, a run that proceeds on its own, working code at the end | REQ-001, REQ-002, REQ-010–REQ-018 |
| "Show me why it built what it built." | Readable stage documents, a trace from each requirement to its test, and a decision log | REQ-004, REQ-020–REQ-025, REQ-060 |
| "Show me it actually works." | E2E results per requirement, not just "tests passed" | REQ-050–REQ-056 |
| "When something is wrong, fix it at the source." | The router explaining where a problem started and what it will redo | REQ-030–REQ-041 |
| "Tell me if a real person would find this confusing." | Critic findings on a document or on the running app | REQ-042–REQ-049 |
| "Don't surprise me with a huge bill." | A budget, cost per stage, and a clean stop when the limit is reached | REQ-070–REQ-075 |
| "Let me step in when I want to." | Optional checkpoints, hand-editing documents, resume, restarting from a chosen stage | REQ-003, REQ-005, REQ-007, REQ-026–REQ-028 |

**Secondary persona: "Small-team PM Priya".** Priya mostly values the paper trail: a first-draft spec, plan and prototype to discuss with the team. She uses the same features and relies especially on the run report (REQ-060) and the fast path (REQ-008).

**Not designed for:** non-technical users expecting a GUI app builder, or enterprises needing a governed software lifecycle (classification §1).

---

## 3. Product decisions on open questions

The earlier stages left these questions open. This stage takes a product-level position on each so that architecture has a clear target. Each position is an assumption that can be revisited (see §9).

| Open question (source) | Decision | Rationale |
|---|---|---|
| How much human involvement? (PU Q1) | **Unattended by default.** The user can turn on approval checkpoints at named points (default candidates: after discovery, after architecture). The run also stops by itself for the escalations in §5.4. | Matches the target user. Checkpoints respond to the "control over going back" expectation. |
| Which product types in v1? (PU Q3, okf §12.2) | **v1 fully supports web apps and command-line tools.** Libraries and HTTP APIs get lighter support: consumer-level usage checks (Should). Anything else (mobile, data pipelines, embedded) is flagged at classification. The run still produces all documents and code, but the E2E verdict is reported as **"not verified: unsupported type"** rather than faked. | E2E cost and tooling depend on product type (okf §7). Web and CLI cover the core audience and the pipeline itself. |
| Router autonomy and limits (PU Q2, okf §12.3) | **Nearest-first, evidence-gated, capped.** The router acts automatically only when it has high confidence *or* the target is the nearest plausible stage. Going far back on low confidence requires human confirmation, or stops the run in unattended mode. There is a hard cap on go-backs per run, and a repeated failure escalates instead of looping. | Attribution accuracy is about 50–70% (okf §3), and wrong routing wastes budget (okf §11.1). |
| Redo everything downstream or only affected parts? (PU Q2, okf §12.4) | **Only affected parts, as far as it's possible to tell.** The product shows which documents and which requirement IDs are stale, and rework preserves content that isn't affected. Architecture decides how fine-grained the tracking is, but the product promise is "the user can see exactly what will be redone and why". | P5; cost (okf §9.1) |
| Critic targets and who can call it (PU Q5, okf §12.6) | **Both documents and the running app.** The user can call it at any time. The pipeline may call it automatically at one configurable point (default: off, or after E2E when the budget allows). The critic never triggers rework directly. The user (or router policy, if enabled) *promotes* findings into rework. | PU §5.7; P9 |
| Handoff format (okf §12.5) | **Human-readable markdown documents are the contract**, with requirement IDs and cross-references that people can read. How to add machine-readable structure is left to architecture. | P7; the evidence is against pure-JSON handoffs (okf §4) |
| Hand edits (okf §12.9) | **Hand edits are first-class.** A hand-edited document marks everything downstream as stale, and the user is told about it before the next run continues. | Inspectability and control expectations |
| Resume and re-run (PU Q7) | **Resuming after any stop is required, and so is restarting from a chosen stage.** Only one active run per project directory in v1. | okf §10 |
| Baseline comparison (okf §12.8) | **Could-have.** An optional single-agent baseline run on the same idea, with a side-by-side report. | Classification §6 asks for it, but it isn't needed for the core loop. |
| "Done" (PU Q10) | **A run is "done" when every Must requirement has an E2E verdict (pass / fail / not verifiable) and no automatic rework remains within limits.** "Done" is not the same as "all passed". The report states the outcome honestly. | P2, P8 |
| Self-building (PU Q9) | Treated as a **stretch acceptance scenario**, not a v1 requirement. The pipeline's own idea is a good dogfood input. | — |

---

## 4. Shape of the experience

### 4.1 What the user touches
1. **One command to start a run** from a sentence or an idea file (REQ-001).
2. **Short terminal progress output.** One line per stage start and finish, with cost so far, plus clearly marked events (go-back, escalation, checkpoint). No streaming of agent chatter by default. A verbose mode is available (REQ-062).
3. **The `docs/` folder**, one readable document per stage, each with a standard header saying who wrote it and who reads it. This is the main surface (REQ-004).
4. **The run report**, a single short document at the end: the only thing Sam *must* read (REQ-060).
5. **A small set of verbs** for control: status, resume, restart from a stage, approve/reject at a checkpoint, invoke the critic, promote a finding, set the budget (REQ-005–REQ-007, REQ-026–REQ-028, REQ-042, REQ-046, REQ-070).

### 4.2 Stage roster (functional view)
Each stage reads earlier documents and writes one document. Every stage ends its document with **Assumptions** and **Open questions** (REQ-012).

| Stage | Produces (functionally) | Key obligation |
|---|---|---|
| Product understanding | Plain-language intent, users, problem, success, assumptions | Brief premise check. Don't design. |
| Product alignment / classification | Category, comparables, business-model context, pitfalls, **supported-type verdict** | Flags unsupported product types (REQ-014) |
| Deep discovery | Organised research base (OKF) | Findings and options only |
| Design planning | Functional requirements with permanent IDs, flows, experience direction | Every requirement has an ID and acceptance intent (REQ-020, REQ-021) |
| Architecture planning | Technical structure and recorded decisions with reasons | Every architecture decision cites the requirement IDs it serves (REQ-022) |
| Implementation planning | Ordered, small increments, each linked to requirement IDs | Coverage: every Must requirement has at least one task (REQ-023) |
| Incremental implementation | Code, one verified increment at a time, each a checkpoint in version history | Each increment is checked before the next starts (REQ-016) |
| Code review | Findings on correctness, consistency with architecture, and requirement coverage | Reports only; routes through the router (P9) |
| E2E testing | Per-requirement verdicts with evidence | Tests derived from requirements, not from the code (REQ-051) |
| *(cross-cutting)* Feedback router | Routing decisions with evidence, confidence and impact | §5.4 |
| *(on demand)* Critic | Human/UX findings | §5.5 |

### 4.3 Tone and presentation
- **Calm and honest.** It says "3 of 14 requirements not verified", not "Build complete! 🎉". Uncertainty is explicit: *confidence: low / medium / high* with a one-line reason.
- **Summaries first, detail on demand.** Every document opens with a summary of five lines or fewer. Detail follows.
- **Consistent vocabulary** across all output: *run, stage, requirement (REQ-n), increment, verdict, finding, go-back, escalation, stale*.
- **Critic output is always labelled as simulated** ("simulated reviewer, not real-user evidence") (REQ-048).

### 4.4 Illustrative terminal feel (not a spec)
```
▶ run 2026-09-24-a  budget $8.00
✓ understanding        $0.21
✓ classification       $0.34   type: web app (supported)
✓ discovery            $0.88
✓ design               $0.40   18 requirements (12 Must)
✓ architecture         $0.52
✓ impl-plan            $0.19   9 increments
✓ implement 1/9 … 9/9  $2.61
✓ review               $0.30   2 findings → router
✗ e2e                  $0.44   11/12 Must pass · REQ-007 fail
↩ go-back → design     confidence: high  evidence: REQ-007 acceptance contradicts REQ-003
  stale: design§REQ-007, impl-plan task 6, increment 6
…
■ done  $6.92   12/12 Must pass · 1 open question · report: docs/run_report.md
```

---

## 5. Feature areas

### 5.1 Run lifecycle
- Start from a sentence or an idea file. Runs unattended by default (REQ-001, REQ-002).
- Optional checkpoints where the user approves, edits or rejects before the run continues (REQ-003).
- Status at any time: current stage, cost so far, stale items, pending escalations (REQ-005).
- Resume after any stop (crash, budget, escalation, checkpoint) without redoing completed, still-valid work (REQ-006).
- Restart from a chosen stage, which marks everything downstream stale (REQ-007).
- **Fast path** for small ideas: fewer, lighter stages (understanding + requirements + plan → implement → test) with the same traceability and verdicts (REQ-008). The product *suggests* it when an idea looks small, but the user chooses.
- One active run per project directory. A second start is refused with a clear message (REQ-009).

### 5.2 Stages and handoffs
- Each stage writes one human-readable document with a standard header and a leading summary (REQ-004, REQ-011).
- Each stage records assumptions and open questions instead of blocking (REQ-012).
- Each stage checks that its required inputs exist and are not stale before starting, and stops with a clear message if not (REQ-013).
- Classification decides whether the product type is supported and sets expectations for E2E (REQ-014).
- A read-only **consistency check** between documents runs after planning stages and reports contradictions and omissions (e.g. a requirement with no task) as router input (REQ-015).
- Implementation proceeds in small increments. Each is checked (builds or runs, its tests pass) and recorded as a checkpoint in version history before the next begins (REQ-016, REQ-017).
- Review reports findings with location, severity and the requirement or architecture decision affected (REQ-018).

### 5.3 Traceability
- Requirements have permanent IDs, defined in one place, never renumbered or reused (REQ-020).
- Each requirement has testable acceptance intent, written in a consistent, testable style (EARS-like "WHEN … the system SHALL …" is recommended) (REQ-021).
- Architecture decisions, implementation tasks, increments, tests and verdicts each cite the requirement IDs they relate to (REQ-022, REQ-023).
- A **coverage view** (requirement → task → increment → test → verdict), with gaps highlighted, is part of the run report (REQ-024).
- A **decision log** records each significant decision: who (which stage), what, why, and what it replaced if it was superseded (REQ-025).

### 5.4 Feedback router
**What the user sees:** each go-back appears as a short, readable **routing decision** containing:
- the symptom (what failed, where it was detected)
- the suspected origin stage and the requirement IDs involved
- the evidence (links to the failing test, critic finding, contradiction)
- confidence (low / medium / high) with a one-line reason
- alternatives considered (the other candidate stages)
- the **impact**: exactly which documents, sections, requirement IDs and increments will become stale and be redone
- the estimated cost of the rework, and the budget remaining (REQ-030–REQ-033)

**Behaviour:**
- Takes input from review findings, E2E failures, consistency-check results, promoted critic findings, and user reports (REQ-034).
- A test failure is re-run before routing, so flaky failures don't trigger go-backs. Failures that are flaky are reported as such (REQ-053).
- **Nearest-first escalation.** The first attempt targets the closest plausible origin. If the same problem recurs after that rework, the next attempt goes one step further back, using the new evidence (REQ-035).
- **Gating.** It acts automatically on high confidence, or on medium confidence when the target is the nearest plausible stage. Otherwise, in attended mode it asks the user to confirm; in unattended mode it stops with an escalation (REQ-036).
- **Limits.** There is a maximum number of go-backs per run and a maximum number of attempts per issue (user-configurable, with conservative defaults). Reaching a limit stops the run with an escalation, never a silent loop (REQ-037).
- **Scoped rework.** Stale items are redone. Unaffected content in the same document is preserved, and the change is shown as a diff in version history (REQ-038).
- After rework, re-verification covers the previously failing items and runs a regression check on items that passed before (REQ-039).
- The user can override: redirect to a different stage, reject a go-back, or trigger one manually ("this is a discovery problem") (REQ-040).
- Routing decisions and their eventual outcomes (did the rework fix it?) are logged, so router accuracy can be measured over time (REQ-041).

**Escalation experience.** When the run stops for a decision, the terminal shows one block: the problem, the options (with the router's recommendation first), and the exact command to continue with each option. The same block goes into the run report.

### 5.5 Critic (human/UX perspective)
- Invoked on demand by the user against a **document**, a **set of documents**, or the **running app** (REQ-042, REQ-043).
- On documents, it performs a cognitive walkthrough: "Would the target user understand this flow? Is the scope sensible? What's confusing or missing?"
- On the running app, it must actually interact with the product (visit the key flows) before reporting. Every finding cites what it did and saw (REQ-044).
- It uses **personas taken from the discovered users** (defaulting to the primary persona) and can be pointed at a specific persona or flow (REQ-045).
- Every finding is actionable, containing: location, what's wrong, which recognised heuristic or guideline it relates to (e.g. Nielsen heuristics, WCAG 2.2), severity, evidence, suggested direction, and related requirement IDs (REQ-046).
- Findings are advisory. The user can **promote** a finding to the router, dismiss it with a reason, or leave it open. Dismissed findings don't reappear on the next critique of the same thing unless the thing has changed (REQ-047).
- Output is labelled as simulated review, and the critic says which areas it is less reliable on (e.g. complex dashboards, chat/agent UIs) (REQ-048).
- The pipeline can optionally auto-invoke it at one configured point, within the budget (REQ-049).

### 5.6 Review and end-to-end testing
- E2E runs the built product the way its user would: a browser for web apps, commands and their output for CLIs, and consumer-style usage for libraries and APIs (Should) (REQ-050, REQ-055).
- E2E scenarios are derived **from the requirements and acceptance intent**, independently of the implementation, to avoid tests that just confirm the code (REQ-051).
- The verdict is **per requirement**: pass / fail / not verifiable (with reason). It combines executed tests with a requirement-by-requirement check that catches omissions tests may miss (REQ-052).
- Flaky failures are detected by re-running before anything is routed (REQ-053).
- Evidence (steps, outputs, screenshots or snapshots where relevant) is kept and linked from each verdict (REQ-054).
- Generated code runs in isolation from the user's wider system, and the user is told what will be executed and where before the first execution (REQ-056).

### 5.7 Reporting and visibility
- **Run report** (REQ-060): outcome in one line; requirement coverage and verdicts; go-backs with their outcomes; open critic findings; assumptions and open questions aggregated from all stages; cost per stage and total; how to run the built product; recommended next actions.
- **Open questions roll-up**: every stage's open questions are collected in one place, marked answered or unanswered (REQ-061).
- Verbose mode and a per-stage log for people who want to see the agent activity (REQ-062).
- Everything the run changes is recorded in version history with meaningful messages, so the user can inspect or revert any stage or increment (REQ-063).

### 5.8 Cost and budget
- A run budget is set at start, with a sensible default and an override (REQ-070).
- Optional per-stage budget shares (REQ-071).
- Before each go-back, the estimated rework cost is shown against the remaining budget (REQ-072, and REQ-033).
- When the budget runs out, the run stops cleanly at a safe point, saves progress, reports what's left undone, and can be resumed with more budget (REQ-073).
- Live cost in the status output and progress lines. Cost per stage and per go-back in the report (REQ-074).
- A warning threshold (e.g. 80% of budget) with a projection of whether the run is likely to finish (REQ-075).
- Pre-run cost estimate from idea size and mode (Could) (REQ-076).

### 5.9 Human edits and control
- The user can hand-edit any stage document between runs or at a checkpoint (REQ-026).
- On the next run or resume, the product detects the edit, lists what is now stale downstream, and asks (or, in unattended mode, proceeds per configured policy) before redoing it (REQ-027).
- The user can answer recorded open questions in place, and those answers are treated as edits (REQ-028).

---

## 6. Key user flows

### F1: First run, happy path
1. Sam runs the start command with a one-sentence idea and a $8 budget (REQ-001, REQ-070).
2. The pipeline confirms its understanding in one line, shows the product type and whether it's supported (REQ-014), and says it will run unattended.
3. Stages run in order. Each prints one progress line with cost (REQ-074).
4. The design stage produces 18 requirements. The consistency check finds none uncovered (REQ-015, REQ-023).
5. Implementation proceeds in 9 increments, each checked and recorded (REQ-016, REQ-017).
6. Review finds nothing that needs routing. E2E passes all Must requirements (REQ-052).
7. The run ends with a one-line outcome and the path to the run report (REQ-060). Sam reads the summary, then opens the app using the "how to run it" section.

### F2: Late failure routed back to its source
1. E2E fails REQ-007. The failing scenario is re-run and fails again, so it isn't flaky (REQ-053).
2. The router collects evidence. The test matches REQ-007's acceptance intent, the code implements task 6 faithfully, and task 6 matches REQ-007, but REQ-007 contradicts REQ-003. Conclusion: origin = design, confidence high (REQ-030–REQ-032).
3. The router shows the impact (design §REQ-007, impl-plan task 6, increment 6) and the estimated cost against remaining budget (REQ-033).
4. High confidence, so it proceeds automatically (REQ-036). Design revises only REQ-007 and records the change in the decision log (REQ-025, REQ-038).
5. Stale downstream items are redone. E2E re-verifies REQ-007 and runs a regression check on the others (REQ-039).
6. The report lists the go-back, its evidence and its outcome ("fixed") (REQ-041, REQ-060).

### F3: Critic on demand, then promotion
1. Mid-run or after the run, Sam invokes the critic on the running app for the "sign-up" flow (REQ-042, REQ-043).
2. The critic, acting as the discovered primary persona, walks the flow and reports 4 findings. Each has a location, heuristic, severity, evidence and suggested direction, and the report is labelled as simulated (REQ-044–REQ-046, REQ-048).
3. Sam dismisses one ("intentional") with a reason and promotes two (REQ-047).
4. The router attributes one promoted finding to implementation (the spec was clear) and the other to design (the spec itself prescribes the confusing flow). It handles both as in F2.

### F4: Budget stop and resume
1. At 80% of budget, the status line warns and projects that the run won't finish (REQ-075).
2. The budget is exhausted during increment 7. The run finishes the current safe unit, saves progress and stops, listing what's left (REQ-073).
3. Sam resumes with an extra $3. Work continues from increment 7 without redoing earlier stages (REQ-006).

### F5: Hand edit and continue
1. At the after-discovery checkpoint (or after a stop), Sam edits the design document to drop a feature and answers an open question (REQ-003, REQ-026, REQ-028).
2. On continue, the product lists what the edit made stale (e.g. architecture section 3, tasks 4–5) and confirms before redoing it (REQ-027).
3. The decision log records the change as "user edit" (REQ-025).

### F6: Fast path for a small idea
1. Sam starts a run with "a CLI that renames photos by EXIF date". The product suggests fast mode and Sam accepts (REQ-008).
2. The lighter stage set runs. Requirement IDs, per-requirement verdicts, the router and the report all still apply, at a fraction of the cost.

### F7: Escalation, when the router isn't sure
1. The same E2E failure recurs after an implementation-level fix. Nearest-first escalation proposes architecture, with medium confidence and a stage that isn't the nearest (REQ-035, REQ-036).
2. In unattended mode, the run stops with an escalation block: the problem, the options (architecture / design / accept as a known issue), the router's recommendation and its reasoning, and the command to continue with each option (REQ-036, REQ-037).
3. Sam picks design instead (a user override, REQ-040). The override and its outcome are logged for measuring accuracy (REQ-041).

### F8: Unsupported product type
1. The idea is a mobile app. Classification flags it as "supported for documents and code; E2E not available" (REQ-014).
2. The run completes all other stages. The report marks each requirement "not verifiable: unsupported type" and says what the user would need to verify manually (REQ-052, REQ-060).

---

## 7. Functional requirements

**Priority key:** **Must** means required for v1 to deliver its core promise. **Should** means expected by the target user; v1 is weaker without it. **Could** means valuable but can be deferred.
**ID policy:** IDs are permanent and never renumbered, reused or repurposed. A new requirement takes the next unused number. Gaps in numbering are intentional: IDs are grouped by feature area and leave room for growth.

| ID | Requirement | Priority |
|---|---|---|
| REQ-001 | The user can start a run with a single command, giving the idea as a sentence or a file. | Must |
| REQ-002 | By default, a run proceeds through all stages without human input, recording assumptions and open questions instead of blocking. | Must |
| REQ-003 | The user can turn on approval checkpoints at named points (at least after discovery and after architecture). At a checkpoint they can approve, edit documents and then continue, or stop. | Should |
| REQ-004 | Each stage produces one human-readable markdown document in the project's docs folder, with a standard header naming the stage that wrote it and the stages that read it. | Must |
| REQ-005 | The user can ask for run status at any time: current stage, completed stages, cost so far, stale items, and pending escalations. | Must |
| REQ-006 | A stopped run (crash, interruption, budget, escalation, checkpoint) can be resumed without redoing completed work that is still valid. | Must |
| REQ-007 | The user can restart a run from a chosen stage, which marks everything downstream stale and redoes it. | Should |
| REQ-008 | A fast mode runs a lighter stage set for small ideas while keeping requirement IDs, per-requirement verdicts, routing and the run report. The product suggests it when an idea looks small; the user decides. | Should |
| REQ-009 | Only one active run is allowed per project directory. Starting a second is refused with a clear message pointing to status/resume. | Must |
| REQ-010 | The pipeline runs the stages in order: understanding, classification, discovery, design, architecture, implementation planning, incremental implementation, review, and E2E testing. Each stage reads the documents of the stages before it. | Must |
| REQ-011 | Every stage document starts with a summary of five lines or fewer before any detail. | Should |
| REQ-012 | Every stage document ends with an Assumptions section and an Open questions section (which may be empty but must be present). | Must |
| REQ-013 | Before running, a stage checks that its required input documents exist and are not stale. If not, it stops with a clear message naming what's missing. | Must |
| REQ-014 | Classification decides whether the product type is supported for E2E verification (v1: web app and CLI fully; library/API partially; others unsupported) and states this to the user early in the run. | Must |
| REQ-015 | A read-only consistency check after the planning stages reports contradictions between documents and omissions (e.g. a requirement with no task, a task with no requirement) and passes them to the router. | Must |
| REQ-016 | Implementation proceeds in small increments from the implementation plan. Each increment is checked (it builds or runs, and its own tests pass) before the next one starts. | Must |
| REQ-017 | Each completed stage and each completed increment is recorded as a separate checkpoint in version history with a meaningful message. | Must |
| REQ-018 | Code review reports findings with location, severity, and the requirement ID or architecture decision affected. It doesn't change code itself. | Must |
| REQ-020 | Every functional requirement has a permanent ID, defined in exactly one place, and is never renumbered, reused or repurposed. | Must |
| REQ-021 | Every requirement has testable acceptance intent written in a consistent style (EARS-like "WHEN … the system SHALL …" recommended). | Must |
| REQ-022 | Architecture decisions record their context, the decision, its consequences, and the requirement IDs they serve. Superseded decisions stay visible and are marked as replaced. | Should |
| REQ-023 | Every implementation task and increment cites the requirement IDs it implements, and every Must requirement is covered by at least one task. | Must |
| REQ-024 | The run report includes a coverage view (requirement → task → increment → test → verdict) with gaps highlighted. | Must |
| REQ-025 | A decision log records each significant decision (by stage, router or user): what was decided, why, and what it replaced. | Should |
| REQ-026 | The user can hand-edit any stage document between runs or at a checkpoint, and the pipeline treats the edited document as authoritative. | Must |
| REQ-027 | When a stage document was changed by hand, the product detects it on the next run or resume, lists what is now stale downstream, and confirms before redoing it (in unattended mode it applies a configured policy). | Should |
| REQ-028 | The user can answer a recorded open question in place. The answer is treated as an edit and flows to the stages downstream. | Should |
| REQ-030 | For every go-back, the router shows a routing decision containing: the symptom, the suspected origin stage, the requirement IDs involved, and links to the evidence. | Must |
| REQ-031 | Every routing decision states a confidence level (low/medium/high) with a one-line reason, and lists the other candidate stages it considered. | Must |
| REQ-032 | The router can send work back to any earlier stage, not just the one immediately before. | Must |
| REQ-033 | Before rework starts, the router shows its impact (which documents, sections, requirement IDs and increments will be redone) and an estimated cost against the remaining budget. | Must |
| REQ-034 | The router accepts input from review findings, E2E failures, consistency-check results, promoted critic findings, and user-reported problems. | Must |
| REQ-035 | The router escalates nearest-first. It targets the closest plausible origin first, and if the same problem recurs after rework, it considers stages further back using the new evidence. | Must |
| REQ-036 | The router acts automatically only on high confidence, or on medium confidence when the target is the nearest plausible stage. Otherwise it asks the user (attended) or stops with an escalation (unattended). | Must |
| REQ-037 | There is a configurable maximum number of go-backs per run and of attempts per issue, with conservative defaults. Reaching either stops the run with an escalation that explains the options. It never loops silently. | Must |
| REQ-038 | Rework redoes only stale items and preserves unaffected content in the same document. The change is visible as a diff in version history. | Must |
| REQ-039 | After rework, verification re-checks the previously failing items and runs a regression check on items that passed before. | Must |
| REQ-040 | The user can override the router: redirect a go-back to a different stage, reject it (accepting the problem as a known issue), or manually trigger a go-back to a named stage. | Should |
| REQ-041 | Every routing decision, override and outcome (resolved / recurred / rejected) is logged so router accuracy can be reviewed across runs. | Should |
| REQ-042 | The user can invoke the critic at any time, during or after a run, independently of the pipeline's progress. | Must |
| REQ-043 | The critic can review a single document, a set of documents, or the running product (web app and CLI in v1). | Must |
| REQ-044 | When reviewing a running product, the critic must interact with the flows it reviews before reporting, and each finding cites the actions and observations it's based on. | Must |
| REQ-045 | The critic reviews from the perspective of personas taken from the discovered target users (default: primary persona). The user can name a persona or flow to focus on. | Should |
| REQ-046 | Each critic finding includes: location, the problem, the heuristic or guideline it relates to (e.g. Nielsen, WCAG 2.2), severity, evidence, suggested direction, and related requirement IDs. | Must |
| REQ-047 | Critic findings are advisory. The user can promote a finding to the router, dismiss it with a reason, or leave it open. Dismissed findings aren't repeated for unchanged targets. | Must |
| REQ-048 | Critic output is labelled as simulated review (not real-user evidence) and states the areas where it's known to be less reliable. | Must |
| REQ-049 | The pipeline can be configured to invoke the critic automatically at one chosen point (off by default), within the budget. | Could |
| REQ-050 | E2E testing exercises the built product the way its user would: through the UI for web apps, and through commands and their outputs for CLIs. | Must |
| REQ-051 | E2E scenarios are derived from the requirements and their acceptance intent, independently of the implementation, and each scenario cites its requirement ID. | Must |
| REQ-052 | E2E produces a verdict per requirement (pass / fail / not verifiable, with reason), combining executed scenarios with a requirement-by-requirement check for omissions. | Must |
| REQ-053 | Failing checks are re-run before being routed. Failures that pass on re-run are reported as flaky and not routed automatically. | Must |
| REQ-054 | Evidence for each verdict (steps taken, outputs, and screenshots or page snapshots where relevant) is kept and linked from the verdict. | Should |
| REQ-055 | For libraries and HTTP APIs, E2E exercises the public interface the way a consumer would. | Should |
| REQ-056 | Generated code runs in isolation from the user's wider system, and before the first execution in a run the user is told what will be executed and where. | Must |
| REQ-060 | Every run ends with a short run report: a one-line outcome, the coverage and verdicts view, go-backs and their outcomes, open critic findings, aggregated assumptions and open questions, cost per stage and total, how to run the built product, and recommended next actions. | Must |
| REQ-061 | Open questions from all stages are collected in one place, each marked answered or unanswered, with a link to its source. | Should |
| REQ-062 | Terminal output is one progress line per stage/increment event by default, with a verbose mode and per-stage logs available on request. | Should |
| REQ-063 | The user can inspect or revert the changes of any single stage or increment using version history. | Should |
| REQ-070 | Every run has a total budget, with a sensible default that the user can override at start or on resume. | Must |
| REQ-071 | The user can optionally set per-stage budget limits or shares. | Could |
| REQ-072 | Rework is not started if its estimated cost would exceed the remaining budget. The run escalates instead. | Must |
| REQ-073 | When the budget is exhausted, the run stops at the next safe point, saves progress, reports what remains undone, and can be resumed with more budget. | Must |
| REQ-074 | Cost so far is shown in progress output and status, and cost per stage and per go-back is itemised in the run report. | Must |
| REQ-075 | At a warning threshold (default 80% of budget), the user is warned with a projection of whether the run is likely to finish. | Should |
| REQ-076 | Before a run starts, the product can show a rough cost estimate based on idea size and mode. | Could |
| REQ-080 | The user can run a single-agent baseline on the same idea and get a side-by-side comparison of requirement verdicts and cost against the pipeline run. | Could |
| REQ-081 | The pipeline can be packaged so that it can also be used from inside the user's existing coding-agent environment (e.g. as a plugin), without losing any Must behaviour. | Could |

---

## 8. Explicitly out of scope for v1
- Hosted, multi-user or browser-based operation. Non-technical users.
- Multiple concurrent runs in one project, or multi-idea portfolios.
- E2E verification for mobile, desktop GUI, embedded or data-pipeline products (documents and code are still produced; verdicts are "not verifiable").
- Deployment, production hardening, compliance.
- Automatic application of critic findings without promotion.
- Monetisation features (billing, accounts).

## 9. Success measures (product-level)
| Measure | Target direction |
|---|---|
| Share of Must requirements with a "pass" verdict at end of run | High. Report it for every run. Compare against the ~50% omission baseline in okf §4. |
| Router go-backs that end "resolved" (not recurred or overridden) | Track from REQ-041. Aim above the literature's ~50–70% agent-level accuracy. |
| Critic findings promoted by the user vs dismissed | A higher promote rate means findings are actionable. |
| Cost per run and cost share spent on rework | Visible per run. Rework share should fall as the router improves. |
| Pipeline vs single-agent baseline (REQ-080) | The pipeline should win on requirement coverage by enough to justify the extra cost. |
| Time to first readable result (the run report summary) | Short enough that small ideas feel fast in fast mode. |

## 10. Assumptions made by this stage
1. The product is a local developer CLI working in a git repo, as established upstream. Distribution form (standalone vs plugin) is left to architecture. REQ-081 only keeps the plugin option open.
2. "Supported product types" in v1 are web apps and CLIs. This choice sets E2E scope and can be revisited without renumbering.
3. Default limits (go-back cap, attempts per issue, budget default, warning threshold) are product-level *policies*. Their exact values are for architecture/implementation to calibrate. The design only requires that they be conservative and configurable.
4. Confidence levels are presented as three buckets (low/medium/high). How they are computed is not specified here.
5. "Safe point" for stopping means a moment where no document or increment is left half-written from the user's point of view.
6. Requirement IDs in this document are grouped by feature area with gaps. Gaps are not missing requirements.
7. This pipeline's own stages (including this one) are expected to follow these requirements once built, e.g. REQ-011 and REQ-012 for documents.

## 11. Open questions for architecture-planning and later
1. How is "stale" tracked, and at what granularity (document, section, requirement ID)? The product needs REQ-033, REQ-038 and REQ-027 to be *explainable to the user* at requirement/section level where possible.
2. How are confidence and cost estimates produced for routing decisions (REQ-031, REQ-033), and how are they calibrated using the REQ-041 log?
3. What isolation mechanism satisfies REQ-056 on a typical developer machine without heavy setup?
4. Which document structure makes requirement IDs and cross-references reliably machine-checkable (REQ-015, REQ-024) while keeping documents pleasant to read (P7)?
5. Should different stages use different models (e.g. stronger models for routing and critique), and how is that exposed to the user, if at all?
6. What exactly does fast mode (REQ-008) drop or merge, and what signals "this idea looks small"?
7. In unattended mode, what is the default policy for hand-edit detection (REQ-027): proceed and redo, or stop and ask?
8. Should the critic's auto-invocation point (REQ-049) default to after E2E when there's budget left, or stay off?

## 12. Traceability to research
| Design element | Grounded in |
|---|---|
| Router evidence, confidence and nearest-first gating (REQ-030–REQ-037) | okf §3.1, §3.4, §3.5; risk §11.1 |
| Scoped rework and regression re-check (REQ-038, REQ-039) | okf §4 (Two Calls), §6.3 (LangGraph replay cost), risk §11.2 |
| Requirement IDs, acceptance intent, coverage (REQ-020–REQ-024) | okf §0.5, §4 (E2EDevBench), §6.1–6.2 (EARS, RTM) |
| Tests derived from requirements, per-requirement verdicts (REQ-051, REQ-052) | okf §7 (hybrid evaluation), risk §11.3; AppLooper |
| Flaky re-run before routing (REQ-053) | okf §7 (Playwright Healer), §7.1 |
| Critic interaction-grounding, actionability, persona, simulated label (REQ-044–REQ-048) | okf §8 (UXBench, UXAgent, AppLooper), risk §11.4 |
| Budgets, cost reporting, loop limits (REQ-037, REQ-070–REQ-075) | okf §9; classification §5.1; MAST 1.5 |
| Fast mode, baseline (REQ-008, REQ-080) | okf §4.1, §10; classification §5.4, §6 |
| Read-only consistency check, advice separate from action (REQ-015, REQ-018, REQ-047) | Spec Kit analyze; AppLooper read-only testers (okf §2.2) |
| Isolation of generated code (REQ-056) | okf §7, risk §11.8 |
