import type { Env } from "./types";

/**
 * A2A-compatible agent card.
 * Follows the Google A2A protocol spec for `/.well-known/agent.json`
 * with additional TrustVault Credit-specific fields.
 */
export function agentCard(env: Env) {
  const base = "https://trustvault-credit.leaidedev.workers.dev";
  return {
    // ── A2A Standard Fields ──
    name: env.AGENT_NAME || "TrustVault Credit",
    description:
      "Programmable working capital for autonomous agents. Underwrites revenue-backed advances against marketplace receivables, enforces spend controls, and settles repayment via on-chain waterfall.",
    url: base,
    version: "0.6.0",
    provider: {
      organization: "Unbrained Labs",
      url: "https://unbrained.club",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills: [
      {
        id: "credit-advance",
        name: "Credit Advance",
        description: "Issue undercollateralized working capital advance to an agent against a marketplace receivable. Dynamic fee based on utilization, duration, risk, and pool state.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "marketplace-job",
        name: "Marketplace Job",
        description: "Create or bid on jobs in the credit marketplace. Jobs serve as receivable collateral for advances.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "credit-profile",
        name: "Credit Profile",
        description: "Get an agent's credit score, limit, available credit, and underwriting factors.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "fee-quote",
        name: "Fee Quote",
        description: "Get a dynamic fee quote for a proposed advance. Shows utilization premium, duration premium, risk premium, and protocol split.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    // ── TrustVault Credit Extensions ──
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    authentication: {
      schemes: ["ethereum-signature"],
      optional: true,
    },
    onchain: {
      network: "sepolia",
      chainId: 11155111,
      contracts: {
        escrow: "0x9779330f469256c9400efe8880df74a0c29d2ea7",
        vault: "erc-4626",
        token: "0x60f6420c4575bd2777bbd031c2b5b960dfbfc5d8",
        identityRegistry: "0xb5a8d645ff6c749f600a3ff31d71cdfad518737b",
        reputationRegistry: "0xfa20c33daa0bdf4d4b38c46952f2b2c95ace2ecf",
      },
    },
    endpoints: {
      health: `${base}/health`,
      fees: `${base}/fees`,
      agentCard: `${base}/.well-known/agent.json`,
      agentLog: `${base}/agent_log.json`,
      dashboard: "https://trustvault-dashboard.pages.dev",
      skillGuide: "https://github.com/unbrained-labs/trustvault-credit/blob/main/SKILL.md",
      api: {
        registerAgent: { method: "POST", path: "/agents/register" },
        getAgent: { method: "GET", path: "/agents/:address" },
        creditProfile: { method: "POST", path: "/credit/profile" },
        creditQuote: { method: "POST", path: "/credit/quote" },
        creditAdvance: { method: "POST", path: "/credit/advance" },
        createJob: { method: "POST", path: "/marketplace/jobs" },
        postJob: { method: "POST", path: "/marketplace/post" },
        listOpenJobs: { method: "GET", path: "/marketplace/open" },
        submitBid: { method: "POST", path: "/marketplace/jobs/:jobId/bid" },
        completeJob: { method: "POST", path: "/marketplace/jobs/:jobId/complete" },
        treasuryDeposit: { method: "POST", path: "/treasury/deposit" },
        recordSpend: { method: "POST", path: "/spend/record" },
        onchainLookup: { method: "GET", path: "/onchain/:address" },
      },
    },
  };
}
