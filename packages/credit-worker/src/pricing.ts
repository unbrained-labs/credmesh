/**
 * Dynamic fee pricing engine.
 *
 * Fees are computed from four independent components:
 *   1. Utilization premium  — Aave-style kink model; fees rise when capital is scarce
 *   2. Duration premium     — longer advances carry more risk
 *   3. Agent risk premium   — based on repayment/completion history
 *   4. Pool loss surcharge  — if the pool has absorbed defaults, fees rise to rebuild reserves
 *
 * Total fee is split:
 *   - Underwriter share (e.g. 85%) → vault depositors (increases share price)
 *   - Protocol share   (e.g. 15%) → protocol treasury for sustainability
 */

import { clamp, rc, roundTo } from "./utils";
import type { FeeBreakdown, TreasuryState } from "./types";

// ── Configuration ──

/** Floor and ceiling for the total fee rate (before protocol split). */
const MIN_FEE_RATE = 0.02; // 2% minimum — even the best agents pay something
const MAX_FEE_RATE = 0.25; // 25% cap — never predatory

/** Protocol's share of every fee collected (basis points). 1500 = 15%. */
export const PROTOCOL_FEE_BPS = 1500;

/** Utilization kink model parameters (inspired by Aave's interest rate strategy). */
const OPTIMAL_UTILIZATION = 0.80; // 80% — below this, rates rise slowly
const BASE_RATE = 0.02;           // 2% base when utilization = 0
const SLOPE_1 = 0.04;             // gentle slope below the kink
const SLOPE_2 = 0.60;             // steep slope above the kink (incentivizes deposits)

/** Duration tiers (hours → premium). */
const DURATION_BRACKETS: Array<{ maxHours: number; premium: number }> = [
  { maxHours: 4,   premium: 0.00 },  // flash advances: no duration premium
  { maxHours: 24,  premium: 0.01 },  // same-day: +1%
  { maxHours: 72,  premium: 0.025 }, // multi-day: +2.5%
  { maxHours: 168, premium: 0.04 },  // weekly: +4%
  { maxHours: Infinity, premium: 0.06 }, // longer: +6%
];

// ── Public API ──

/**
 * Compute the dynamic fee for a credit advance.
 *
 * @param principal      - Approved advance amount (USD)
 * @param durationHours  - Job duration in hours
 * @param repaymentRate  - Agent's historical repayment rate [0, 1]
 * @param completionRate - Agent's historical job completion rate [0, 1]
 * @param treasury       - Current treasury state (for utilization + loss data)
 */
export function computeFee(
  principal: number,
  durationHours: number,
  repaymentRate: number,
  completionRate: number,
  treasury: TreasuryState,
): FeeBreakdown {
  // 1. Utilization premium (kink model)
  const utilization = computeUtilization(treasury);
  const utilizationPremium = computeUtilizationPremium(utilization);

  // 2. Duration premium
  const durationPremium = computeDurationPremium(durationHours);

  // 3. Agent risk premium
  const riskPremium = computeRiskPremium(repaymentRate, completionRate);

  // 4. Pool loss surcharge (rebuilds reserves after defaults)
  const poolLossSurcharge = computePoolLossSurcharge(treasury);

  // Combine all components
  const rawRate = utilizationPremium + durationPremium + riskPremium + poolLossSurcharge;
  const totalRate = clamp(roundTo(rawRate, 4), MIN_FEE_RATE, MAX_FEE_RATE);

  const totalFee = rc(principal * totalRate);
  const { underwriterFee, protocolFee } = splitFee(totalFee);

  return {
    totalFee,
    effectiveRate: roundTo(totalRate, 4),
    underwriterFee,
    protocolFee,
    components: {
      utilizationRate: roundTo(utilization, 4),
      utilizationPremium: roundTo(utilizationPremium, 4),
      durationPremium: roundTo(durationPremium, 4),
      riskPremium: roundTo(riskPremium, 4),
      poolLossSurcharge: roundTo(poolLossSurcharge, 4),
      totalRate,
    },
  };
}

/**
 * Split an already-computed fee into underwriter + protocol portions.
 * Used by the waterfall when distributing collected fees.
 */
export function splitFee(totalFee: number): { underwriterFee: number; protocolFee: number } {
  const protocolFee = rc(totalFee * PROTOCOL_FEE_BPS / 10000);
  const underwriterFee = rc(totalFee - protocolFee);
  return { underwriterFee, protocolFee };
}

// ── Internal ──

function computeUtilization(treasury: TreasuryState): number {
  const totalCapital = treasury.totalDeposited - treasury.totalDefaultLoss;
  if (totalCapital <= 0) return 1; // no capital = max utilization
  const utilized = treasury.totalAdvanced - treasury.totalRepaid;
  return clamp(utilized / totalCapital, 0, 1);
}

/**
 * Aave-style kink interest rate model.
 * Below optimal utilization: rate = BASE_RATE + utilization * SLOPE_1 / OPTIMAL
 * Above optimal utilization: rate jumps steeply to discourage over-borrowing.
 */
function computeUtilizationPremium(utilization: number): number {
  if (utilization <= OPTIMAL_UTILIZATION) {
    return BASE_RATE + (utilization / OPTIMAL_UTILIZATION) * SLOPE_1;
  }
  // Above the kink — steep increase
  const excessUtilization = (utilization - OPTIMAL_UTILIZATION) / (1 - OPTIMAL_UTILIZATION);
  return BASE_RATE + SLOPE_1 + excessUtilization * SLOPE_2;
}

function computeDurationPremium(durationHours: number): number {
  // Last bracket has maxHours=Infinity, so the loop always matches.
  for (const bracket of DURATION_BRACKETS) {
    if (durationHours <= bracket.maxHours) return bracket.premium;
  }
  return 0;
}

/**
 * Agents with worse track records pay more.
 * Perfect agent (100% repay, 100% completion): 0% risk premium
 * Worst agent (0% repay, 0% completion): up to 8% risk premium
 */
function computeRiskPremium(repaymentRate: number, completionRate: number): number {
  const repayPenalty = (1 - repaymentRate) * 0.05;  // up to 5%
  const completionPenalty = (1 - completionRate) * 0.03; // up to 3%
  return repayPenalty + completionPenalty;
}

/**
 * If the pool has absorbed losses, add a surcharge to rebuild reserves.
 * Surcharge scales with the loss ratio (defaults / total deposited).
 */
function computePoolLossSurcharge(treasury: TreasuryState): number {
  if (treasury.totalDeposited <= 0) return 0;
  const lossRatio = treasury.totalDefaultLoss / treasury.totalDeposited;
  // Up to 3% surcharge when losses are significant
  return clamp(lossRatio * 0.15, 0, 0.03);
}
