import type { Bid, JobReceivable } from "./types";

/**
 * Rank bids by composite score:
 * - Credit score: 40%
 * - Cost efficiency (lower cost = better): 30%
 * - Speed (fewer hours = better): 30%
 */
export function rankBids(bids: Bid[], job: JobReceivable): Bid[] {
  if (bids.length === 0) return [];

  const maxCost = Math.max(...bids.map((b) => b.proposedCost), 1);
  const maxHours = Math.max(...bids.map((b) => b.estimatedHours), 1);

  return [...bids].sort((a, b) => {
    const scoreA = compositeScore(a, maxCost, maxHours);
    const scoreB = compositeScore(b, maxCost, maxHours);
    return scoreB - scoreA;
  });
}

function compositeScore(bid: Bid, maxCost: number, maxHours: number): number {
  const creditNorm = bid.creditScore / 100;
  const costEfficiency = 1 - bid.proposedCost / maxCost;
  const speedEfficiency = 1 - bid.estimatedHours / maxHours;
  return creditNorm * 0.4 + costEfficiency * 0.3 + speedEfficiency * 0.3;
}

export function evaluateBid(
  bid: Bid,
  job: JobReceivable,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (bid.creditScore <= 0) {
    reasons.push("Agent has no credit score.");
  }
  if (bid.proposedCost > job.expectedPayout) {
    reasons.push("Proposed cost exceeds expected payout.");
  }
  if (
    job.requiredCapabilities &&
    job.requiredCapabilities.length > 0
  ) {
    const missing = job.requiredCapabilities.filter(
      (cap) => !bid.capabilities.includes(cap),
    );
    if (missing.length > 0) {
      reasons.push(`Missing capabilities: ${missing.join(", ")}.`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

export function awardJob(
  job: JobReceivable,
  bid: Bid,
): JobReceivable {
  return {
    ...job,
    agentAddress: bid.agentAddress,
    awardedBidId: bid.id,
  };
}
