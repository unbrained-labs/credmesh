import type { Env } from "./types";

export function agentCard(env: Env) {
  return {
    name: env.AGENT_NAME || "TrustVault Credit",
    description:
      "Programmable working capital for autonomous agents. Underwrites revenue-backed advances, enforces spend controls, and settles repayment via waterfall from verified marketplace payouts.",
    version: "0.2.0",
    capabilities: [
      "agent-credit-underwriting",
      "marketplace-receivable-financing",
      "programmable-spend-controls",
      "repayment-waterfall",
      "portfolio-risk-dashboard",
      "marketplace-bidding",
    ],
    endpoints: {
      health: "/health",
      registerAgent: "/agents/register",
      getAgent: "/agents/:address",
      creditProfile: "/credit/profile",
      creditQuote: "/credit/quote",
      creditAdvance: "/credit/advance",
      creditDefault: "/credit/default",
      createJob: "/marketplace/jobs",
      postJob: "/marketplace/post",
      listOpenJobs: "/marketplace/open",
      submitBid: "/marketplace/jobs/:jobId/bid",
      getBids: "/marketplace/jobs/:jobId/bids",
      awardBid: "/marketplace/jobs/:jobId/award",
      completeJob: "/marketplace/jobs/:jobId/complete",
      treasuryDeposit: "/treasury/deposit",
      treasury: "/treasury",
      recordSpend: "/spend/record",
      spendHistory: "/spend/:advanceId",
      portfolio: "/dashboard/portfolio",
      risk: "/dashboard/risk",
      timeline: "/timeline",
      demoBootstrap: "/demo/bootstrap",
      demoReset: "/demo/reset",
      demoScenarios: "/demo/scenarios",
    },
  };
}
