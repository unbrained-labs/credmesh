import type { AgentRecord, CreditDecision, CreditProfile, CreditQuote, JobReceivable, TreasuryState } from "./types";
import { clamp, rc, repaymentRate as calcRepaymentRate, roundTo } from "./utils";
import { computeFee } from "./pricing";

const HARD_CAP = 100;
const PAYOUT_ADVANCE_RATIO = 0.3;

export function computeCreditProfile(agent: AgentRecord): CreditProfile {
  const repayRate = calcRepaymentRate(agent.repaidAdvances, agent.defaultedAdvances);
  const completionRate = getCompletionRate(agent);
  const reasons = buildReasons(agent, repayRate, completionRate);

  let score = 0;
  score += agent.trustScore * 0.35;
  score += Math.min(agent.attestationCount, 20) * 1.2;
  score += Math.min(agent.cooperationSuccessCount, 10) * 2.5;
  score += Math.min(agent.successfulJobs, 20) * 2.5;
  score += Math.min(agent.repaidAdvances, 10) * 3;
  score += agent.identityRegistered ? 10 : 0;
  score += Math.min(agent.averageCompletedPayout, 200) * 0.05;

  score -= agent.failedJobs * 6;
  score -= agent.defaultedAdvances * 20;
  score -= Math.min(agent.outstandingBalance, 100) * 0.2;

  const creditScore = clamp(Math.round(score), 0, 100);
  const rawLimit = creditScore * 0.8 + repayRate * 20 + completionRate * 15;
  const creditLimit = rc(clamp(rawLimit, 0, HARD_CAP));
  const availableCredit = rc(Math.max(0, creditLimit - agent.outstandingBalance));

  return {
    agent,
    creditScore,
    creditLimit,
    availableCredit,
    repaymentRate: repayRate,
    completionRate,
    outstandingBalance: rc(agent.outstandingBalance),
    reasons,
  };
}

export function quoteAdvance(
  profile: CreditProfile,
  job: JobReceivable,
  requestedAmount: number,
  purpose: string,
  treasury: TreasuryState,
): CreditQuote {
  const reasons = [...profile.reasons];
  const constraints = [
    "Repayment sweeps from the linked job payout first.",
    "Advance is scoped to the declared task and duration.",
  ];

  const p = purpose.toLowerCase();
  if (p.includes("compute") || p.includes("tool") || p.includes("browser")) {
    constraints.push("Use restricted to approved tool and compute vendors.");
  }

  const payoutCap = rc(job.expectedPayout * PAYOUT_ADVANCE_RATIO);
  const approvedAmount = rc(Math.min(requestedAmount, payoutCap, profile.availableCredit, HARD_CAP));
  const utilizationRatio = job.expectedPayout <= 0 ? 1 : approvedAmount / job.expectedPayout;

  // Dynamic fee computation
  const feeBreakdown = computeFee(
    approvedAmount,
    job.durationHours,
    profile.repaymentRate,
    profile.completionRate,
    treasury,
  );

  let decision: CreditDecision = "DECLINED";
  if (profile.creditScore >= 65 && approvedAmount >= requestedAmount && requestedAmount > 0) {
    decision = "APPROVED";
  } else if (profile.creditScore >= 45 && approvedAmount > 0) {
    decision = "MANUAL_REVIEW";
  }

  reasons.push(`Expected payout: $${job.expectedPayout.toFixed(2)}.`);
  reasons.push(`Advance capped at ${(PAYOUT_ADVANCE_RATIO * 100).toFixed(0)}% of expected payout.`);
  reasons.push(`Fee rate: ${(feeBreakdown.effectiveRate * 100).toFixed(2)}% (utilization ${(feeBreakdown.components.utilizationRate * 100).toFixed(0)}%).`);

  if (profile.availableCredit <= 0) {
    reasons.push("No available credit remaining.");
  }
  if (requestedAmount > payoutCap) {
    reasons.push("Requested amount exceeds receivable-backed cap.");
  }
  if (requestedAmount > profile.availableCredit) {
    reasons.push("Requested amount exceeds available credit.");
  }
  if (profile.agent.defaultedAdvances > 0) {
    reasons.push("Prior defaults reduce confidence and limit.");
  }

  const confidence = clamp(
    roundTo(
      profile.creditScore / 100 * 0.6 +
      profile.repaymentRate * 0.25 +
      profile.completionRate * 0.15 -
      utilizationRatio * 0.1,
      2,
    ),
    0,
    1,
  );

  return {
    decision,
    approvedAmount,
    requestedAmount,
    fee: feeBreakdown.totalFee,
    feeBreakdown,
    maxDurationHours: job.durationHours,
    confidence,
    reasons,
    constraints,
  };
}

function buildReasons(agent: AgentRecord, repayRate: number, completionRate: number): string[] {
  const reasons: string[] = [];

  if (agent.identityRegistered) {
    reasons.push("ERC-8004 identity appears registered.");
  } else {
    reasons.push("Onchain identity not verified, so underwriting is conservative.");
  }

  reasons.push(`Trust score input is ${agent.trustScore}.`);
  reasons.push(`${agent.successfulJobs} successful jobs recorded.`);
  reasons.push(`Repayment rate is ${(repayRate * 100).toFixed(0)}%.`);
  reasons.push(`Completion rate is ${(completionRate * 100).toFixed(0)}%.`);

  if (agent.defaultedAdvances > 0) {
    reasons.push(`${agent.defaultedAdvances} prior credit default(s) recorded.`);
  }

  return reasons;
}

function getCompletionRate(agent: AgentRecord): number {
  const totalJobs = agent.successfulJobs + agent.failedJobs;
  if (totalJobs === 0) return 0.5;
  return roundTo(agent.successfulJobs / totalJobs, 2);
}
