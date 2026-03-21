import type {
  CreditAdvance,
  SpendCategory,
  SpendPolicy,
  TreasuryDeposit,
  TreasuryState,
  WaterfallResult,
} from "./types";

export const DEFAULT_TREASURY: TreasuryState = {
  totalDeposited: 0,
  totalAdvanced: 0,
  totalRepaid: 0,
  totalFeesEarned: 0,
  totalDefaultLoss: 0,
  availableFunds: 0,
  deposits: [],
};

export function depositFunds(
  treasury: TreasuryState,
  lenderAddress: string,
  amount: number,
  memo: string,
): { treasury: TreasuryState; deposit: TreasuryDeposit } {
  const deposit: TreasuryDeposit = {
    id: crypto.randomUUID(),
    lenderAddress,
    amount: rc(amount),
    memo,
    createdAt: Date.now(),
  };

  return {
    treasury: {
      ...treasury,
      totalDeposited: rc(treasury.totalDeposited + deposit.amount),
      availableFunds: rc(treasury.availableFunds + deposit.amount),
      deposits: [...treasury.deposits, deposit],
    },
    deposit,
  };
}

export function reserveFunds(
  treasury: TreasuryState,
  amount: number,
): TreasuryState {
  return {
    ...treasury,
    totalAdvanced: rc(treasury.totalAdvanced + amount),
    availableFunds: rc(treasury.availableFunds - amount),
  };
}

export function returnFunds(
  treasury: TreasuryState,
  principalRepaid: number,
  feesEarned: number,
): TreasuryState {
  return {
    ...treasury,
    totalRepaid: rc(treasury.totalRepaid + principalRepaid),
    totalFeesEarned: rc(treasury.totalFeesEarned + feesEarned),
    availableFunds: rc(treasury.availableFunds + principalRepaid + feesEarned),
  };
}

export function recordDefaultLoss(
  treasury: TreasuryState,
  lostAmount: number,
): TreasuryState {
  return {
    ...treasury,
    totalDefaultLoss: rc(treasury.totalDefaultLoss + lostAmount),
  };
}

const LATE_PENALTY_RATE = 0.05;

export function settleWaterfall(
  grossPayout: number,
  advances: CreditAdvance[],
): WaterfallResult {
  const breakdown: string[] = [];
  let remaining = rc(grossPayout);
  breakdown.push(`Gross payout received: $${grossPayout.toFixed(2)}`);

  // 1. Principal
  const totalPrincipal = rc(advances.reduce((s, a) => s + a.approvedAmount, 0));
  const principalRepaid = rc(Math.min(remaining, totalPrincipal));
  remaining = rc(remaining - principalRepaid);
  breakdown.push(
    `Principal repaid: $${principalRepaid.toFixed(2)} of $${totalPrincipal.toFixed(2)}`,
  );

  // 2. Fees
  const totalFees = rc(advances.reduce((s, a) => s + a.fee, 0));
  const feePaid = rc(Math.min(remaining, totalFees));
  remaining = rc(remaining - feePaid);
  breakdown.push(
    `Fees paid: $${feePaid.toFixed(2)} of $${totalFees.toFixed(2)}`,
  );

  // 3. Late penalty
  const now = Date.now();
  const overdueAdvances = advances.filter(
    (a) => a.status === "active" && a.dueAt < now,
  );
  let penaltyApplied = 0;
  if (overdueAdvances.length > 0) {
    const penaltyBase = rc(
      overdueAdvances.reduce((s, a) => s + a.approvedAmount, 0),
    );
    const penalty = rc(penaltyBase * LATE_PENALTY_RATE);
    penaltyApplied = rc(Math.min(remaining, penalty));
    remaining = rc(remaining - penaltyApplied);
    breakdown.push(
      `Late penalty (${overdueAdvances.length} overdue): $${penaltyApplied.toFixed(2)}`,
    );
  }

  // 4. Agent remainder
  const agentNet = rc(remaining);
  breakdown.push(`Agent net: $${agentNet.toFixed(2)}`);

  const totalDue = rc(totalPrincipal + totalFees);
  const shortfall = rc(Math.max(0, totalDue - principalRepaid - feePaid));

  let status: WaterfallResult["status"];
  if (shortfall <= 0) {
    status = "full_repayment";
  } else if (principalRepaid > 0 || feePaid > 0) {
    status = "partial_repayment";
  } else {
    status = "total_default";
  }

  if (shortfall > 0) {
    breakdown.push(`Shortfall: $${shortfall.toFixed(2)}`);
  }

  return {
    grossPayout: rc(grossPayout),
    principalRepaid,
    feePaid,
    penaltyApplied,
    agentNet,
    shortfall,
    status,
    breakdown,
  };
}

export function buildSpendPolicy(
  advanceAmount: number,
  purpose: string,
): SpendPolicy {
  const p = purpose.toLowerCase();
  let allowedCategories: SpendPolicy["allowedCategories"];

  if (p.includes("compute") || p.includes("inference")) {
    allowedCategories = ["compute", "api", "storage"];
  } else if (p.includes("tool") || p.includes("browser")) {
    allowedCategories = ["api", "browser", "storage"];
  } else if (p.includes("gas") || p.includes("onchain")) {
    allowedCategories = ["gas"];
  } else if (p.includes("hiring") || p.includes("sub-agent") || p.includes("subagent")) {
    allowedCategories = ["sub-agent"];
  } else {
    allowedCategories = ["compute", "api", "gas", "sub-agent", "browser", "storage", "other"];
  }

  return {
    allowedCategories,
    maxSingleSpend: rc(advanceAmount * 0.5),
    dailyLimit: rc(advanceAmount),
  };
}

export function validateSpend(
  policy: SpendPolicy,
  category: SpendCategory,
  amount: number,
  totalSpentToday: number,
  totalSpent: number,
  advanceAmount: number,
): { approved: boolean; reason?: string } {
  if (!policy.allowedCategories.includes(category)) {
    return {
      approved: false,
      reason: `Category "${category}" not allowed. Permitted: ${policy.allowedCategories.join(", ")}.`,
    };
  }
  if (amount > policy.maxSingleSpend) {
    return {
      approved: false,
      reason: `Amount $${amount.toFixed(2)} exceeds single-spend limit $${policy.maxSingleSpend.toFixed(2)}.`,
    };
  }
  if (rc(totalSpentToday + amount) > policy.dailyLimit) {
    return {
      approved: false,
      reason: `Would exceed daily limit $${policy.dailyLimit.toFixed(2)}.`,
    };
  }
  if (rc(totalSpent + amount) > advanceAmount) {
    return {
      approved: false,
      reason: `Would exceed total advance amount $${advanceAmount.toFixed(2)}.`,
    };
  }
  return { approved: true };
}

function rc(v: number): number {
  return Math.round(v * 100) / 100;
}
