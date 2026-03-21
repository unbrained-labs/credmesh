import type { AgentRecord, CreditDecision, CreditProfile, CreditQuote, JobReceivable } from "./types";

const HARD_CAP = 100;
const PAYOUT_ADVANCE_RATIO = 0.3;

export function computeCreditProfile(agent: AgentRecord): CreditProfile {
  const repaymentRate = getRepaymentRate(agent);
  const completionRate = getCompletionRate(agent);
  const reasons = buildReasons(agent, repaymentRate, completionRate);

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
  const rawLimit = creditScore * 0.8 + repaymentRate * 20 + completionRate * 15;
  const creditLimit = roundCurrency(clamp(rawLimit, 0, HARD_CAP));
  const availableCredit = roundCurrency(Math.max(0, creditLimit - agent.outstandingBalance));

  return {
    agent,
    creditScore,
    creditLimit,
    availableCredit,
    repaymentRate,
    completionRate,
    outstandingBalance: roundCurrency(agent.outstandingBalance),
    reasons,
  };
}

export function quoteAdvance(
  profile: CreditProfile,
  job: JobReceivable,
  requestedAmount: number,
  purpose: string,
): CreditQuote {
  const reasons = [...profile.reasons];
  const constraints = [
    "Repayment sweeps from the linked job payout first.",
    "Advance is scoped to the declared task and duration.",
  ];

  if (purpose.toLowerCase() === "compute" || purpose.toLowerCase() === "tools") {
    constraints.push("Use restricted to approved tool and compute vendors.");
  }

  const payoutCap = roundCurrency(job.expectedPayout * PAYOUT_ADVANCE_RATIO);
  const approvedAmount = roundCurrency(Math.min(requestedAmount, payoutCap, profile.availableCredit, HARD_CAP));
  const utilizationRatio = job.expectedPayout <= 0 ? 1 : approvedAmount / job.expectedPayout;
  const baseFeeRate = 0.05 + (1 - profile.repaymentRate) * 0.05 + (1 - profile.completionRate) * 0.03;
  const fee = roundCurrency(approvedAmount * baseFeeRate);

  let decision: CreditDecision = "DECLINED";
  if (profile.creditScore >= 65 && approvedAmount >= requestedAmount && requestedAmount > 0) {
    decision = "APPROVED";
  } else if (profile.creditScore >= 45 && approvedAmount > 0) {
    decision = "MANUAL_REVIEW";
  }

  reasons.push(`Expected payout: $${job.expectedPayout.toFixed(2)}.`);
  reasons.push(`Advance capped at ${(PAYOUT_ADVANCE_RATIO * 100).toFixed(0)}% of expected payout.`);

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
    fee,
    maxDurationHours: job.durationHours,
    confidence,
    reasons,
    constraints,
  };
}

function buildReasons(agent: AgentRecord, repaymentRate: number, completionRate: number): string[] {
  const reasons: string[] = [];

  if (agent.identityRegistered) {
    reasons.push("ERC-8004 identity appears registered.");
  } else {
    reasons.push("Onchain identity not verified, so underwriting is conservative.");
  }

  reasons.push(`Trust score input is ${agent.trustScore}.`);
  reasons.push(`${agent.successfulJobs} successful jobs recorded.`);
  reasons.push(`Repayment rate is ${(repaymentRate * 100).toFixed(0)}%.`);
  reasons.push(`Completion rate is ${(completionRate * 100).toFixed(0)}%.`);

  if (agent.defaultedAdvances > 0) {
    reasons.push(`${agent.defaultedAdvances} prior credit default(s) recorded.`);
  }

  return reasons;
}

function getRepaymentRate(agent: AgentRecord): number {
  const totalCompletedAdvances = agent.repaidAdvances + agent.defaultedAdvances;
  if (totalCompletedAdvances === 0) return 1;
  return roundTo(agent.repaidAdvances / totalCompletedAdvances, 2);
}

function getCompletionRate(agent: AgentRecord): number {
  const totalJobs = agent.successfulJobs + agent.failedJobs;
  if (totalJobs === 0) return 0.5;
  return roundTo(agent.successfulJobs / totalJobs, 2);
}

function roundCurrency(value: number): number {
  return roundTo(value, 2);
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

