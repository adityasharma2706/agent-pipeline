# Resuming a build on another machine

The pipeline's checkpoint is split across **two repos**, and both are needed:

| Repo | Holds |
|---|---|
| `agent-pipeline` (this one) | the orchestrator, the agent definitions, and `docs/` + `state/run.json` — which stage finished and what every stage wrote |
| `exportbuyers` | the generated product **and** `pipeline-progress.json`, the per-module ledger that decides what gets skipped |

Neither alone is enough. `state/run.json` says the pipeline is inside
`spec-implementer`; the ledger says which modules of it are already built.

## Steps

```bash
git clone git@github.com:adityasharma2706/agent-pipeline.git
git clone git@github.com:adityasharma2706/exportbuyers.git

cd agent-pipeline && npm install
cd ../exportbuyers && npm install     # the product's own deps; node_modules is gitignored in both

cd ../agent-pipeline
PIPELINE_WORKSPACE=$(cd ../exportbuyers && pwd) npm run orchestrator
```

`PIPELINE_WORKSPACE` is the part that is easy to miss. It defaults to
`~/agent-pipeline-workspace`, which exists only on the machine the build
started on. Point it at the product checkout or the orchestrator will
bootstrap an empty workspace and rebuild every module from M01.

## What resuming actually does

It reads `state/run.json`, sees the last stage that *succeeded*, and starts at
the one after it. Inside `spec-implementer` it reads the ledger and skips every
module recorded as `success` — completed work is never redone. Only a success
advances anything, so a failed or interrupted attempt is retried rather than
skipped.

## Checks that will stop you, and why

- **Plan hash.** The ledger records a hash of the `docs/implementer.md` it was
  built from. If they disagree, the run halts rather than reusing another
  product's modules — module ids are positional, so every plan starts at M01.
  Both files are committed together, so a matched pair of clones is fine.
- **Changed idea.** Passing a different idea on the command line when
  `docs/idea.md` already holds one is refused, because the documents downstream
  describe the old one. Resume with **no** idea argument.
- **Dependency install.** The orchestrator runs `npm install --ignore-scripts`
  in the workspace when the declared dependency set changes. A fresh clone has
  no `node_modules`, so this runs on the first module and is expected.

## Costs

Every module is a real Claude API call billed to whatever credential the
environment provides. The run budget is cumulative **per invocation**, not per
build, so a long build spans several runs — each one resumes where the last
stopped.
