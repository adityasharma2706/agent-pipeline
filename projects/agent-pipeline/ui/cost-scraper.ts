// Reads spend out of the orchestrator's console output.
//
// It is deliberately a READER of what the CLI already prints rather than a
// second accounting system: the numbers a human sees in the UI and in a
// terminal are then the same numbers, and the CLI stays the single source of
// truth for money.
//
// It lives in its own module, separate from server.ts, because server.ts binds
// a port the moment it is imported and so cannot be exercised directly.

/**
 * Lines that carry a RUNNING TOTAL for the run so far. Both are printed when a
 * stage ends: `(cumulative $X of $Y)` and the final `Total cost: $X`.
 */
const TOTAL_PATTERNS = [/cumulative \$([0-9]+\.[0-9]+)/, /Total cost: \$([0-9]+\.[0-9]+)/];

/**
 * A single module's spend inside spec-implementer's loop:
 *
 *     `      ok — 2 file(s), 4 REQ(s), $0.8327`
 *
 * Anchored on the `REQ(s), $` shape so it cannot match the stage-level
 * `ok — 3 turns, $0.12 (cumulative $...)` line and count the same money twice.
 */
const MODULE_COST_PATTERN = /REQ\(s\), \$([0-9]+\.[0-9]+)\s*$/;

/**
 * Running spend for one run.
 *
 * The running total is only printed when a STAGE ends, and spec-implementer's
 * module loop can run for the best part of an hour between two of those — so
 * the UI used to show $0.00 for most of a real run. Per-module amounts are
 * therefore added as they arrive, but only as a provisional top-up: when the
 * stage's own `cumulative $X` line lands it is the authoritative total for
 * everything spent so far (modules included), so it REPLACES the accumulated
 * sum rather than adding to it, and the per-module accumulator resets to zero.
 * That is what stops a module being counted twice.
 */
export class CostScraper {
  /** The last running total the orchestrator itself reported. */
  private reportedTotalUsd = 0;
  /** Per-module spend seen since that total — provisional until the next one. */
  private moduleSpendSinceTotalUsd = 0;

  /** Spend so far, in USD, rounded to a sub-cent that JSON round-trips cleanly. */
  get totalUsd(): number {
    return Math.round((this.reportedTotalUsd + this.moduleSpendSinceTotalUsd) * 1e6) / 1e6;
  }

  reset(): void {
    this.reportedTotalUsd = 0;
    this.moduleSpendSinceTotalUsd = 0;
  }

  /** Feeds one console line in. Returns true when the displayed total changed. */
  observe(text: string): boolean {
    const before = this.totalUsd;

    for (const pattern of TOTAL_PATTERNS) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const value = Number.parseFloat(match[1] ?? "");
      if (!Number.isFinite(value)) return false;
      // Monotonic: a later stage's total is never smaller, and a stray smaller
      // number must not walk the displayed figure backwards.
      this.reportedTotalUsd = Math.max(this.reportedTotalUsd, value);
      this.moduleSpendSinceTotalUsd = 0;
      return this.totalUsd !== before;
    }

    const moduleMatch = MODULE_COST_PATTERN.exec(text);
    if (moduleMatch === null) return false;
    const moduleCost = Number.parseFloat(moduleMatch[1] ?? "");
    if (!Number.isFinite(moduleCost) || moduleCost < 0) return false;
    this.moduleSpendSinceTotalUsd += moduleCost;
    return this.totalUsd !== before;
  }
}
