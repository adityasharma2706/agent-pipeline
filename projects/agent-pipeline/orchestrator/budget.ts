// Cumulative spend ceiling for a whole run.
//
// Through Phase 3 the only cap was MAX_BUDGET_USD_PER_STAGE, passed to the SDK
// as `maxBudgetUsd`. That is per-query() — which was adequate while every stage
// was exactly one query() call. spec-implementer is a loop of N module calls,
// so N * per-stage was the real ceiling and nothing bounded N * anything.
//
// The default of $25 is not invented here: it is `budget.defaultUsd: 25` from
// this project's own docs/lld.md §M01 defaults, adopted so the orchestrator and
// the design it is building agree on the number.

/** Default cumulative ceiling for one `npm run orchestrator` invocation. */
export const MAX_BUDGET_USD_PER_RUN = 25.0;

export class RunBudget {
  private spentUsd = 0;

  constructor(private readonly capUsd: number = MAX_BUDGET_USD_PER_RUN) {}

  get spent(): number {
    return this.spentUsd;
  }

  get cap(): number {
    return this.capUsd;
  }

  get remaining(): number {
    return Math.max(0, this.capUsd - this.spentUsd);
  }

  /** Records actual spend. Always called, even for a failed call — it still billed. */
  record(costUsd: number): void {
    if (Number.isFinite(costUsd) && costUsd > 0) this.spentUsd += costUsd;
  }

  /**
   * The `maxBudgetUsd` to hand the next query(): the per-stage cap, clamped to
   * what is left in the run. Without the clamp a single stage could step over
   * the run ceiling by up to the full per-stage cap before anyone noticed.
   */
  allowanceFor(perCallCapUsd: number): number {
    return Math.min(perCallCapUsd, this.remaining);
  }

  /**
   * Whether there is enough headroom left to start another call at all.
   *
   * The floor exists because an allowance of a few cents buys a call that is
   * guaranteed to die of `error_max_budget_usd` partway through — spending the
   * money and producing nothing. Below the floor, halt cleanly instead.
   */
  canAfford(minimumUsd: number): boolean {
    return this.remaining >= minimumUsd;
  }
}
