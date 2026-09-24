<!-- Written by: product-understanding stage. Read by: product-alignment, deep-discovery, reviewer. -->

# Product Understanding

## 1. The core idea in plain language

You give the tool a rough product idea, even a single sentence. It then runs that idea through the steps a small, disciplined product team would follow, using a series of specialised AI agents:

1. **Understand** what the idea is really asking for.
2. **Research** the idea just enough to check that its premise holds up.
3. **Classify** the kind of product it is, so later stages know which playbook applies.
4. **Discover** the details: requirements, users, edge cases, constraints.
5. **Plan** the work.
6. **Design the architecture.**
7. **Implement** it in small steps, one piece at a time.
8. **Review the code.**
9. **Test end to end.**

Two features make it more than a straight line of steps:

- **A feedback router.** When a later stage finds a problem, the router can send the work back to *any* earlier stage, not just the one right before it. For example, a failing end-to-end test might trace back to a wrong requirement. The goal is to fix a problem where it started, not patch it further down.
- **A critic you call on demand.** A separate agent can be pointed at any output (a plan, a spec, a UI, the finished app) to review it the way a human user or UX reviewer would. It asks things like "Would a person actually understand this or enjoy using it?", not "Does this compile?"

In short, it's an automated product team that turns an idea into working, tested software. It hands off written documents between stages, it can go back and rework earlier decisions, and it keeps checking the result from a human point of view.

## 2. Who it's for

- **Main user:** a single builder: a solo developer, technical founder or hobbyist. They have more ideas than time and want to go from idea to working prototype without doing every step of the process by hand. Judging from the setup (a local `npm run orchestrator -- "<idea>"` command, files in `docs/`, a git repo), this is a developer-facing command-line tool run on their own machine, not a hosted SaaS product.
- **Secondary users:** small teams or product people who want a first-draft spec, plan and prototype they can inspect, and who value the paper trail (each stage's document) as much as the code.
- **Not the target (assumed):** large organisations looking for a governed replacement for their software development lifecycle, and non-technical users who expect a no-code app builder with a polished GUI.

## 3. What problem it solves

- **Getting from idea to working software takes a lot of work.** Turning a vague idea into a spec, a plan, an architecture, code and tests takes many different skills and a lot of switching between them. Solo builders usually skip steps (especially discovery, review and testing) and pay for it later.
- **Single-prompt AI coding drifts and stays shallow.** Asking one AI agent to "build X" tends to skip clarifying intent, make hidden assumptions and produce code that doesn't match what the person wanted. Separate stages with written handoffs make each decision visible and open to review.
- **Mistakes found late are expensive when you can't go back.** In a strict one-way pipeline, a requirements mistake found during testing gets patched in the code instead of fixed at the source. The feedback router exists to send each problem back to where it began.
- **Automated checks miss the human experience.** Tests and code review confirm that the code is correct. They don't confirm that the product is usable or sensible. The critic agent fills that gap.

**Premise check (brief):** The idea fits an established line of work. MetaGPT and ChatDev showed that "a software company made of role-specialised agents with structured handoffs" works, and current coding tools commonly use planner/coder/reviewer subagents. Published critiques point to real risks: early frameworks had weak feedback loops, and recent results suggest that many agents can do *worse* than a simple self-refinement loop, especially with smaller models. So the premise holds up, and the parts that set this idea apart are the ones prior work did poorly: routing feedback to any stage, and a critique from a human/UX point of view. Later stages should keep the pipeline no heavier than it needs to be.

## 4. What success looks like (intent-level, not design)

- A user gives one sentence and, with little babysitting, gets back:
  - a readable set of stage documents explaining what was built and why
  - working code, built step by step
  - evidence that it was reviewed and tested end to end
- When something goes wrong late, the system visibly sends it back to the right earlier stage instead of piling patches on top.
- The user can call the critic at any point and get useful, human-centred feedback.
- The user trusts the output because each step can be inspected, not just because it runs.

## 5. Assumptions I made

1. **Runs locally and is aimed at developers.** It's a command-line or local orchestrator working on files in a git repo, not a hosted multi-user service.
2. **Stages communicate through files.** Each stage writes a markdown document (e.g. `docs/<stage>.md`) that later stages read. This matches the existing file headers ("Written by / Read by").
3. **Runs without supervision by default.** Stages run without asking a human for input and record open questions instead of blocking, as this stage is doing now. Human checkpoints may be optional.
4. **Output is a working prototype or MVP**, not production-hardened software with deployment, compliance, etc.
5. **Built on LLM agents**, most likely the Claude Agent SDK given the environment, each with its own role, tools and instructions.
6. **"Incremental implementation" means small, verified, committed steps**, each checked before moving on. This is consistent with how the user is known to prefer building large systems in phases.
7. **The critic gives advice only.** It reports findings. Whether they trigger rework is decided by the user or the feedback router, not the critic.
8. **Cost and time budgets matter.** Runs are limited by a budget (this stage runs under one), so the pipeline should avoid runaway loops.

## 6. Open questions

These are for later stages (alignment, discovery), not for this one to settle:

1. **How much human involvement?** Fully automatic from start to finish, or optional approval points (e.g. after discovery, after architecture)? How are the critic's findings shown to the human?
2. **Feedback router limits:** How does the router decide *which* stage caused a problem? What stops endless loops (maximum go-backs, budget limits, a point where it hands over to a human)? When an early stage is redone, are all later stages redone, or only the affected parts?
3. **What kinds of products?** Web apps only, or also CLIs, libraries, mobile or data pipelines? The classification stage suggests several, but it's unclear how many should be supported at first.
4. **What does "end-to-end testing" mean** for products without a UI? Does it require running the app (browser automation, etc.) in a sandbox?
5. **What can the critic review?** Text documents only, or also running software (screenshots, click-throughs)? Can it be called by the user, by other agents, or both?
6. **Research depth and sources:** web search only, or also competitor and market analysis? How much is "enough"?
7. **Resuming and re-running:** Can a user restart from a given stage, edit a document by hand and continue, or run several ideas at once?
8. **Which models, and how much they cost:** one model for every stage, or different models per role? What budget per run is acceptable?
9. **Is this pipeline also meant to build itself?** The first idea it was given describes the pipeline itself. Is that a real goal, or just a demo input?
10. **What counts as "done":** Who or what decides the pipeline has finished successfully?

## 7. Out of scope for this document

This document is about agreeing on intent only. Product classification, detailed requirements, UX design, technical architecture and implementation choices are left to the later stages.

## Sources (premise check)

- [MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework](https://arxiv.org/pdf/2308.00352)
- [ChatDev: Communicative Agents for Software Development](https://arxiv.org/pdf/2307.07924)
- [Two Calls Beat Five Agents: Evaluating Multi-Agent Pipelines Against Self-Refinement](https://arxiv.org/pdf/2607.26922)
- [Traceability and Accountability in Role-Specialized Multi-Agent LLM Pipelines](https://arxiv.org/pdf/2510.07614)
- [AppLooper: An Agentic Application Engineering Loop with Virtual-User Feedback](https://arxiv.org/pdf/2608.14093)
