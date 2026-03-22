import { computeCreditProfile } from "./credit";
import type {
  AgentState,
  CreditAdvance,
  CreditProfile,
  DemoScenario,
  PortfolioReport,
  RiskReport,
  TimelineEvent,
} from "./types";
import { clamp, rc, repaymentRate } from "./utils";

// ── Timeline ──

export function createEvent(
  type: TimelineEvent["type"],
  actor: string,
  description: string,
  data: Record<string, unknown> = {},
): TimelineEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type,
    actor,
    description,
    data,
  };
}

// ── Shared helpers ──

function defaultLoss(advances: CreditAdvance[]): number {
  return rc(advances.reduce((s, a) => s + a.approvedAmount - (a.repaidAmount ?? 0), 0));
}

function profileMap(state: AgentState): Map<string, CreditProfile> {
  const map = new Map<string, CreditProfile>();
  for (const agent of Object.values(state.agents)) {
    map.set(agent.address, computeCreditProfile(agent));
  }
  return map;
}

// ── Portfolio Dashboard ──

export function computePortfolio(state: AgentState): PortfolioReport {
  const agents = Object.values(state.agents);
  const advances = Object.values(state.advances);
  const jobs = Object.values(state.jobs);
  const profiles = profileMap(state);

  const activeAdvances = advances.filter((a) => a.status === "active");
  const repaidAdvances = advances.filter((a) => a.status === "repaid");
  const defaultedAdvances = advances.filter((a) => a.status === "defaulted");
  const completedCount = repaidAdvances.length + defaultedAdvances.length;

  const totalExposure = rc(activeAdvances.reduce((s, a) => s + a.approvedAmount, 0));
  const totalRepaid = rc(agents.reduce((s, a) => s + a.totalRepaid, 0));
  const totalDefaulted = defaultLoss(defaultedAdvances);
  const totalBorrowed = rc(agents.reduce((s, a) => s + a.totalBorrowed, 0));

  const creditScores = [...profiles.values()].map((p) => p.creditScore);
  const averageCreditScore =
    creditScores.length > 0
      ? Math.round(creditScores.reduce((s, v) => s + v, 0) / creditScores.length)
      : 0;

  const exposureByCategory: Record<string, number> = {};
  for (const adv of activeAdvances) {
    const job = state.jobs[adv.jobId];
    const cat = job?.category ?? "unknown";
    exposureByCategory[cat] = rc((exposureByCategory[cat] ?? 0) + adv.approvedAmount);
  }

  const topBorrowers = agents
    .filter((a) => a.totalBorrowed > 0)
    .sort((a, b) => b.totalBorrowed - a.totalBorrowed)
    .slice(0, 5)
    .map((a) => ({
      address: a.address,
      name: a.name,
      totalBorrowed: a.totalBorrowed,
      outstandingBalance: a.outstandingBalance,
      creditScore: profiles.get(a.address)?.creditScore ?? 0,
      repaymentRate: repaymentRate(a.repaidAdvances, a.defaultedAdvances),
    }));

  return {
    summary: {
      totalAgents: agents.length,
      totalJobs: jobs.length,
      totalAdvances: advances.length,
      activeAdvances: activeAdvances.length,
      totalExposure,
      totalRepaid,
      totalDefaulted,
      totalFeesEarned: rc(state.treasury.totalFeesEarned),
      repaymentRate: completedCount > 0 ? rc(repaidAdvances.length / completedCount) : 1,
      defaultRate: completedCount > 0 ? rc(defaultedAdvances.length / completedCount) : 0,
      averageAdvanceSize: advances.length > 0 ? rc(totalBorrowed / advances.length) : 0,
      averageCreditScore,
    },
    exposureByCategory,
    topBorrowers,
    recentActivity: state.timeline.slice(-20).reverse(),
  };
}

// ── Risk Report ──

export function computeRisk(state: AgentState): RiskReport {
  const agents = Object.values(state.agents);
  const advances = Object.values(state.advances);
  const activeAdvances = advances.filter((a) => a.status === "active");
  const profiles = profileMap(state);
  const alerts: string[] = [];
  const recommendations: string[] = [];

  const totalLimits = [...profiles.values()].reduce((s, p) => s + p.creditLimit, 0);
  const totalOutstanding = rc(agents.reduce((s, a) => s + a.outstandingBalance, 0));
  const utilizationRate = totalLimits > 0 ? rc(totalOutstanding / totalLimits) : 0;

  const totalAdvanced = rc(agents.reduce((s, a) => s + a.totalBorrowed, 0));
  const defaultedAdvances = advances.filter((a) => a.status === "defaulted");
  const defaultLossAmount = defaultLoss(defaultedAdvances);
  const weightedDefaultRate = totalAdvanced > 0 ? rc(defaultLossAmount / totalAdvanced) : 0;

  const coverageRatios = activeAdvances.map((a) => {
    const job = state.jobs[a.jobId];
    return job ? job.expectedPayout / a.approvedAmount : 0;
  });
  const averageCoverageRatio =
    coverageRatios.length > 0
      ? rc(coverageRatios.reduce((s, v) => s + v, 0) / coverageRatios.length)
      : 0;

  const largestSingleExposure =
    agents.length > 0 ? Math.max(...agents.map((a) => a.outstandingBalance)) : 0;

  const now = Date.now();
  const overdueCount = activeAdvances.filter((a) => a.dueAt < now).length;

  let concentrationRisk = 0;
  if (totalOutstanding > 0) {
    const shares = agents.map((a) => a.outstandingBalance / totalOutstanding);
    concentrationRisk = rc(shares.reduce((s, sh) => s + sh * sh, 0));
  }

  let healthScore = 100;
  healthScore -= weightedDefaultRate * 40;
  healthScore -= overdueCount * 8;
  healthScore -= concentrationRisk > 0.5 ? 15 : concentrationRisk > 0.3 ? 5 : 0;
  healthScore -= utilizationRate > 0.8 ? 10 : 0;
  healthScore = clamp(Math.round(healthScore), 0, 100);

  let overallRisk: RiskReport["overallRisk"];
  if (healthScore >= 80) overallRisk = "LOW";
  else if (healthScore >= 60) overallRisk = "MODERATE";
  else if (healthScore >= 40) overallRisk = "HIGH";
  else overallRisk = "CRITICAL";

  if (overdueCount > 0) alerts.push(`${overdueCount} advance(s) are past due.`);
  if (weightedDefaultRate > 0.1) alerts.push(`Weighted default rate is ${(weightedDefaultRate * 100).toFixed(1)}%.`);
  if (concentrationRisk > 0.5) alerts.push("Exposure is heavily concentrated in a single borrower.");
  if (utilizationRate > 0.8) alerts.push("Credit utilization exceeds 80%.");
  if (state.treasury.availableFunds < totalOutstanding * 0.1) alerts.push("Treasury reserves are below 10% of outstanding exposure.");

  if (overdueCount > 0) recommendations.push("Review overdue advances and consider default action.");
  if (concentrationRisk > 0.3) recommendations.push("Diversify lending across more agents.");
  if (utilizationRate > 0.7) recommendations.push("Increase treasury deposits to support growth.");
  if (alerts.length === 0) recommendations.push("Portfolio is healthy. Continue monitoring.");

  return {
    overallRisk,
    healthScore,
    concentrationRisk,
    metrics: { utilizationRate, weightedDefaultRate, averageCoverageRatio, largestSingleExposure, overdueCount },
    alerts,
    recommendations,
  };
}

// ── Demo Bootstrap Data ──

export function generateHappyPath() {
  return {
    agents: [
      {
        address: "0xaa11111111111111111111111111111111111111",
        name: "atlas-research",
        url: "https://atlas-research.agent.example",
        trustScore: 82, attestationCount: 15, cooperationSuccessCount: 8,
        successfulJobs: 12, failedJobs: 1, averageCompletedPayout: 95,
      },
      {
        address: "0xbb22222222222222222222222222222222222222",
        name: "codex-builder",
        url: "https://codex-builder.agent.example",
        trustScore: 75, attestationCount: 10, cooperationSuccessCount: 6,
        successfulJobs: 8, failedJobs: 0, averageCompletedPayout: 120,
      },
      {
        address: "0xcc33333333333333333333333333333333333333",
        name: "scout-browser",
        url: "https://scout-browser.agent.example",
        trustScore: 68, attestationCount: 7, cooperationSuccessCount: 4,
        successfulJobs: 5, failedJobs: 1, averageCompletedPayout: 70,
      },
    ],
    jobs: [
      { agentAddress: "0xaa11111111111111111111111111111111111111", payer: "0xc11e000000000000000000000000000000000001", title: "Market research on DeFi lending protocols", expectedPayout: 100, durationHours: 48, category: "research" },
      { agentAddress: "0xbb22222222222222222222222222222222222222", payer: "0xc11e000000000000000000000000000000000002", title: "Build smart contract integration module", expectedPayout: 150, durationHours: 72, category: "code" },
      { agentAddress: "0xcc33333333333333333333333333333333333333", payer: "0xc11e000000000000000000000000000000000003", title: "Competitive analysis web scraping pipeline", expectedPayout: 80, durationHours: 24, category: "browser-automation" },
    ],
    advances: [
      { agentAddress: "0xaa11111111111111111111111111111111111111", jobIndex: 0, requestedAmount: 15, purpose: "compute" },
      { agentAddress: "0xbb22222222222222222222222222222222222222", jobIndex: 1, requestedAmount: 25, purpose: "tools" },
      { agentAddress: "0xcc33333333333333333333333333333333333333", jobIndex: 2, requestedAmount: 12, purpose: "browser" },
    ],
    completions: [
      { jobIndex: 0, actualPayout: 100 },
      { jobIndex: 1, actualPayout: 150 },
      { jobIndex: 2, actualPayout: 80 },
    ],
  };
}

export function generateFailurePath() {
  return {
    agents: [
      {
        address: "0xdd44444444444444444444444444444444444444",
        name: "risky-runner",
        url: "https://risky-runner.agent.example",
        trustScore: 45, attestationCount: 3, cooperationSuccessCount: 1,
        successfulJobs: 2, failedJobs: 2, averageCompletedPayout: 40,
      },
      {
        address: "0xee55555555555555555555555555555555555555",
        name: "new-agent-99",
        url: "https://new-agent-99.agent.example",
        trustScore: 30, attestationCount: 0, cooperationSuccessCount: 0,
        successfulJobs: 0, failedJobs: 0, averageCompletedPayout: 0,
      },
    ],
    jobs: [
      { agentAddress: "0xdd44444444444444444444444444444444444444", payer: "0xc11e000000000000000000000000000000000004", title: "Automated onchain trade execution", expectedPayout: 60, durationHours: 12, category: "onchain" },
      { agentAddress: "0xee55555555555555555555555555555555555555", payer: "0xc11e000000000000000000000000000000000005", title: "Social media growth campaign", expectedPayout: 40, durationHours: 24, category: "growth" },
    ],
    advances: [
      { agentAddress: "0xdd44444444444444444444444444444444444444", jobIndex: 0, requestedAmount: 10, purpose: "gas" },
      { agentAddress: "0xee55555555555555555555555555555555555555", jobIndex: 1, requestedAmount: 8, purpose: "compute" },
    ],
    partialCompletions: [{ jobIndex: 0, actualPayout: 30 }],
    defaults: [{ advanceIndex: 1, reason: "Agent failed to deliver any output." }],
  };
}

export function listScenarios(): DemoScenario[] {
  return [
    { name: "happy", description: "Three agents with solid history complete jobs and repay advances in full. Credit profiles improve.", agents: 3, jobs: 3, advances: 3, includesDefault: false },
    { name: "failure", description: "Two weak agents take advances. One delivers short, causing partial default. The other fails entirely.", agents: 2, jobs: 2, advances: 2, includesDefault: true },
    { name: "both", description: "Runs both scenarios. Shows the contrast between strong and weak borrowers in the same portfolio.", agents: 5, jobs: 5, advances: 5, includesDefault: true },
  ];
}
