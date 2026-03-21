import type { Env } from "./types";

export function agentCard(env: Env) {
  return {
    name: env.AGENT_NAME || "TrustVault Credit",
    description:
      "Programmable working capital for autonomous agents. Computes credit profiles, quotes revenue-backed advances, and repays from verified marketplace payouts.",
    version: "0.1.0",
    capabilities: [
      "agent-credit-underwriting",
      "marketplace-receivable-financing",
      "programmable-credit-constraints",
    ],
    endpoints: {
      health: "/health",
      registerAgent: "/agents/register",
      createJob: "/marketplace/jobs",
      creditProfile: "/credit/profile",
      creditQuote: "/credit/quote",
      creditAdvance: "/credit/advance",
    },
  };
}

