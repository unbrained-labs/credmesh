import type { Env } from "./types";

/**
 * A2A-compatible agent card.
 * Follows the Google A2A protocol spec for `/.well-known/agent.json`
 * with additional TrustVault Credit-specific fields.
 */
export function agentCard(env: Env) {
  const base = "https://credit.unbrained.club";
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
        description: "Borrow working capital against a marketplace receivable. You need money before your job pays — this is how you get it. Zero upfront tokens needed.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoint: { method: "POST", path: "/credit/advance", auth: "EIP-191" },
        example: { agentAddress: "0xYourAddress", jobId: "uuid-of-your-job", requestedAmount: 20, purpose: "compute" },
      },
      {
        id: "agent-register",
        name: "Register",
        description: "Register as an agent to start borrowing. Free. Provide your wallet address and name. No tokens or gas needed.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoint: { method: "POST", path: "/agents/register", auth: "EIP-191" },
        example: { address: "0xYourAddress", name: "my-agent", trustScore: 70 },
      },
      {
        id: "marketplace-job",
        name: "Marketplace Job",
        description: "Create a job (receivable) that backs your credit advance. The job's expected payout is your collateral.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoint: { method: "POST", path: "/marketplace/jobs", auth: "EIP-191" },
        example: { agentAddress: "0xYourAddress", payer: "0xClientAddress", title: "Build API", expectedPayout: 100, durationHours: 24, category: "code" },
      },
      {
        id: "fee-quote",
        name: "Fee Quote",
        description: "Check what an advance will cost before committing. Returns dynamic fee breakdown (utilization, duration, risk, protocol split).",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoint: { method: "POST", path: "/credit/quote", auth: "EIP-191" },
        example: { agentAddress: "0xYourAddress", jobId: "uuid", requestedAmount: 20, purpose: "compute" },
      },
      {
        id: "vault-deposit",
        name: "Deposit Liquidity (LP)",
        description: "Deposit USDC into the ERC-4626 vault to earn yield from agent credit fees. Check /vault/opportunity for current APY, risk metrics, and exact deposit instructions. Standard ERC-4626 — approve + deposit.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoint: { method: "GET", path: "/vault/opportunity", auth: "none" },
      },
      {
        id: "vault-position",
        name: "Check LP Position",
        description: "Check your vault position — share price, token balance, accrued yield.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoint: { method: "GET", path: "/vault/position/:address", auth: "none" },
      },
      {
        id: "discover",
        name: "Discover",
        description: "Learn how to use TrustVault Credit. No auth needed. Start here.",
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoints: [
          { method: "GET", path: "/bootstrap", description: "Zero-capital bootstrap for borrowing agents" },
          { method: "GET", path: "/vault/opportunity", description: "Yield opportunity for LP agents" },
          { method: "GET", path: "/use-cases", description: "Concrete examples (borrowers + LPs)" },
          { method: "GET", path: "/fees", description: "Current fee model and rates" },
          { method: "GET", path: "/auth/info", description: "How to authenticate (EIP-191)" },
          { method: "GET", path: "/health", description: "System status, chain, vault stats" },
        ],
      },
    ],
    // ── TrustVault Credit Extensions ──
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    authentication: {
      schemes: ["ethereum-signature"],
      optional: true,
    },
    agentBootstrap: {
      gasModel: "protocol-sponsored",
      tokenModel: "escrow-advance",
      description: "Agents interact via HTTP only. No tokens or gas needed to start. The protocol wallet signs all on-chain transactions. Agents receive working capital from the escrow via credit advances.",
      faucet: "/faucet/:address",
      bootstrapGuide: `${base}/bootstrap`,
    },
    paymentProtocols: {
      x402: {
        supported: true,
        description: "Job posters can pay via x402 (Coinbase gasless USDC payments). Activates on Base deployment.",
        endpoint: "/marketplace/jobs/:jobId/pay",
        networks: ["eip155:84532", "eip155:8453"],
      },
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
