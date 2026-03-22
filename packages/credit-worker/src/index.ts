import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentCard } from "./agent-card";
import { CreditAgent } from "./engine";
import { listScenarios } from "./demo";
import { checkIdentityRegistration } from "./erc8004";
import { isChainEnabled, isEscrowEnabled, getAgentWallet, getTreasuryBalance, getEscrowStats, getVaultStats, getReputation, checkIdentityOnchain, getTokenBalance } from "./chain";
import { authMiddleware } from "./auth";
import { computeFee, PROTOCOL_FEE_BPS } from "./pricing";
import { positiveNumber, nonNegativeNumber, boundedString } from "./validate";
import type { AgentRegistrationInput, Env, SpendCategory, TimelineEvent } from "./types";

export { CreditAgent };

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());
app.use("/agents/*", authMiddleware);
app.use("/credit/*", authMiddleware);
app.use("/marketplace/*", authMiddleware);
app.use("/spend/*", authMiddleware);
app.use("/treasury/*", authMiddleware);
app.use("/demo/*", authMiddleware);
app.use("/debug/*", authMiddleware);

// ─── Discovery ───

app.get("/.well-known/agent.json", (c) => c.json(agentCard(c.env)));

app.get("/agent.json", (c) => c.json(devSpotManifest()));

app.get("/agent_log.json", async (c) => {
  const agent = getAgent(c.env);
  const timeline: TimelineEvent[] = await agent.getTimeline(100);
  return c.json({
    agent: "TrustVault Credit",
    version: "0.2.0",
    generated: new Date().toISOString(),
    entries: timeline.map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      type: e.type,
      actor: e.actor,
      action: e.description,
      data: e.data,
    })),
  });
});

app.get("/cover.svg", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(COVER_SVG);
});

app.get("/health", async (c) => {
  const chainEnabled = isChainEnabled(c.env);
  const escrowEnabled = isEscrowEnabled(c.env);
  const escrowStats = escrowEnabled ? await getEscrowStats(c.env) : null;
  const vaultStats = c.env.CREDIT_VAULT ? await getVaultStats(c.env) : null;
  return c.json({
    status: "ok",
    agent: c.env.AGENT_NAME || "TrustVault Credit",
    version: "0.5.0",
    timestamp: Date.now(),
    chain: {
      enabled: chainEnabled,
      network: chainEnabled ? "sepolia" : null,
      escrowEnabled,
      vaultEnabled: !!c.env.CREDIT_VAULT,
      escrowBalance: escrowStats?.balance ? `${escrowStats.balance} tUSDC` : null,
    },
    vault: vaultStats,
  });
});

// ─── Agent Registration ───

app.post("/agents/register", async (c) => {
  const body = await c.req.json<AgentRegistrationInput>();
  const agent = getAgent(c.env);
  const identityRegistered = await checkIdentityRegistration(c.env, body.address);
  return c.json(await agent.registerAgent({ ...body, identityRegistered }));
});

app.get("/agents/:address", async (c) => {
  const agent = getAgent(c.env);
  const record = await agent.getAgent(c.req.param("address"));
  if (!record) return c.json({ error: "Agent not found." }, 404);
  return c.json(record);
});

// ─── Credit ───

app.post("/credit/profile", async (c) => {
  const { agentAddress } = await c.req.json<{ agentAddress: string }>();
  return c.json(await getAgent(c.env).getProfile(agentAddress));
});

app.post("/credit/quote", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }>();
  body.requestedAmount = positiveNumber(body.requestedAmount, "requestedAmount");
  body.purpose = boundedString(body.purpose, "purpose");
  return c.json(await getAgent(c.env).quoteAdvance(body));
});

app.post("/credit/advance", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }>();
  body.requestedAmount = positiveNumber(body.requestedAmount, "requestedAmount");
  body.purpose = boundedString(body.purpose, "purpose");
  return c.json(await getAgent(c.env).createAdvance(body));
});

app.post("/credit/default", async (c) => {
  const body = await c.req.json<{ advanceId: string; reason: string }>();
  return c.json(await getAgent(c.env).defaultAdvance(body));
});

// ─── Marketplace: Legacy (direct assignment) ───

app.post("/marketplace/jobs", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    payer: string;
    title: string;
    expectedPayout: number;
    durationHours: number;
    category: string;
  }>();
  body.expectedPayout = positiveNumber(body.expectedPayout, "expectedPayout");
  body.durationHours = positiveNumber(body.durationHours, "durationHours");
  body.title = boundedString(body.title, "title");
  return c.json(await getAgent(c.env).createJob(body));
});

app.post("/marketplace/jobs/:jobId/complete", async (c) => {
  const { actualPayout } = await c.req.json<{ actualPayout?: number }>();
  return c.json(
    await getAgent(c.env).completeJob({
      jobId: c.req.param("jobId"),
      actualPayout,
    }),
  );
});

// ─── Marketplace: Bidding ───

app.post("/marketplace/post", async (c) => {
  const body = await c.req.json<{
    postedBy: string;
    title: string;
    expectedPayout: number;
    durationHours: number;
    category: string;
    requiredCapabilities?: string[];
  }>();
  return c.json(await getAgent(c.env).postJob(body));
});

app.get("/marketplace/open", async (c) => {
  return c.json(await getAgent(c.env).listOpenJobs());
});

app.post("/marketplace/jobs/:jobId/bid", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    proposedCost: number;
    estimatedHours: number;
    capabilities: string[];
    pitch: string;
  }>();
  return c.json(
    await getAgent(c.env).submitBid({
      jobId: c.req.param("jobId"),
      ...body,
    }),
  );
});

app.get("/marketplace/jobs/:jobId/bids", async (c) => {
  return c.json(await getAgent(c.env).getBids(c.req.param("jobId")));
});

app.post("/marketplace/jobs/:jobId/award", async (c) => {
  const { bidId } = await c.req.json<{ bidId: string }>();
  return c.json(
    await getAgent(c.env).awardBid({
      jobId: c.req.param("jobId"),
      bidId,
    }),
  );
});

// ─── Treasury ───

app.post("/treasury/deposit", async (c) => {
  const body = await c.req.json<{
    lenderAddress: string;
    amount: number;
    memo?: string;
  }>();
  body.amount = positiveNumber(body.amount, "amount");
  return c.json(await getAgent(c.env).deposit(body));
});

app.get("/treasury", async (c) => {
  return c.json(await getAgent(c.env).getTreasury());
});

// ─── Fee Transparency ───

app.get("/fees", async (c) => {
  const agent = getAgent(c.env);
  const treasury = await agent.getTreasury();
  // Show current fee curve at sample amounts
  const sampleAdvance = 20;
  const sampleBreakdown = computeFee(sampleAdvance, 24, 1.0, 1.0, treasury);
  const riskyBreakdown = computeFee(sampleAdvance, 24, 0.5, 0.7, treasury);

  return c.json({
    model: "dynamic-utilization",
    protocolFeeBps: PROTOCOL_FEE_BPS,
    protocolFeePercent: `${(PROTOCOL_FEE_BPS / 100).toFixed(1)}%`,
    description: "Fees are computed dynamically from pool utilization (kink model), advance duration, agent risk, and pool loss history. Protocol retains a share for sustainability.",
    currentPool: {
      totalDeposited: treasury.totalDeposited,
      totalAdvanced: treasury.totalAdvanced,
      totalFeesEarned: treasury.totalFeesEarned,
      underwriterFeesEarned: treasury.totalUnderwriterFees,
      protocolFeesEarned: treasury.totalProtocolFees,
      totalDefaultLoss: treasury.totalDefaultLoss,
    },
    exampleRates: {
      bestCase: {
        description: "Perfect agent, 24h advance, $20",
        ...sampleBreakdown,
      },
      riskyCase: {
        description: "50% repay rate, 70% completion, 24h advance, $20",
        ...riskyBreakdown,
      },
    },
  });
});

// ─── Spend Controls ───

app.post("/spend/record", async (c) => {
  const body = await c.req.json<{
    advanceId: string;
    category: SpendCategory;
    amount: number;
    vendor: string;
    description: string;
  }>();
  body.amount = positiveNumber(body.amount, "amount");
  body.vendor = boundedString(body.vendor, "vendor");
  body.description = boundedString(body.description, "description");
  return c.json(await getAgent(c.env).recordSpend(body));
});

app.get("/spend/:advanceId", async (c) => {
  return c.json(await getAgent(c.env).getSpendHistory(c.req.param("advanceId")));
});

// ─── Dashboard ───

app.get("/dashboard/portfolio", async (c) => {
  return c.json(await getAgent(c.env).getPortfolio());
});

app.get("/dashboard/risk", async (c) => {
  return c.json(await getAgent(c.env).getRisk());
});

// ─── Timeline ───

app.get("/timeline", async (c) => {
  const limit = Number(c.req.query("limit") ?? "50");
  return c.json(await getAgent(c.env).getTimeline(limit));
});

// ─── Demo ───

app.post("/demo/bootstrap", async (c) => {
  const { scenario } = await c.req.json<{
    scenario?: "happy" | "failure" | "both";
  }>();
  return c.json(await getAgent(c.env).bootstrapDemo(scenario ?? "both"));
});

app.post("/demo/reset", async (c) => {
  return c.json(await getAgent(c.env).resetState());
});

app.get("/demo/scenarios", (c) => {
  return c.json(listScenarios());
});

// ─── Onchain ───

app.get("/onchain/:address", async (c) => {
  const address = c.req.param("address");
  const [identity, reputation, balance] = await Promise.all([
    checkIdentityOnchain(c.env, address),
    getReputation(c.env, address),
    getTokenBalance(c.env, address),
  ]);
  return c.json({
    address,
    identity,
    reputation,
    tokenBalance: balance ? `${balance} tUSDC` : null,
    explorer: `https://sepolia.etherscan.io/address/${address}`,
  });
});

// ─── Debug ───

app.get("/debug/state", async (c) => {
  return c.json(await getAgent(c.env).getSnapshot());
});

app.onError((error, c) => {
  const msg = error.message;
  const safe = msg.startsWith("Unknown ") || msg.startsWith("Job is ") || msg.startsWith("Advance is ")
    ? msg
    : "Request failed.";
  console.error("Request error:", msg);
  return c.json({ error: safe }, 400);
});

function getAgent(env: Env): DurableObjectStub<CreditAgent> {
  const id = env.CREDIT_AGENT.idFromName("trustvault-credit-singleton");
  return env.CREDIT_AGENT.get(id) as DurableObjectStub<CreditAgent>;
}

function devSpotManifest() {
  return {
    name: "TrustVault Credit",
    description: "Programmable working capital for autonomous agents. Revenue-backed microcredit underwritten from onchain identity, delivery history, and marketplace receivables.",
    operator_wallet: "0xa3D3E3859C7EE7EEA5d682A4BaC19c45aDB82388",
    erc8004_identity: {
      registry: "0xb5a8d645ff6c749f600a3ff31d71cdfad518737b",
      chain: "sepolia",
      chain_id: 11155111,
    },
    supported_tools: [
      "credit-underwriting",
      "marketplace-bidding",
      "repayment-waterfall",
      "spend-controls",
      "treasury-management",
      "risk-dashboard",
    ],
    task_categories: [
      "agent-credit-underwriting",
      "marketplace-receivable-financing",
      "programmable-spend-controls",
      "portfolio-risk-analysis",
    ],
    compute_constraints: {
      runtime: "cloudflare-workers",
      storage: "durable-objects",
      max_request_duration_ms: 30000,
    },
    endpoints: {
      health: "/health",
      agent_card: "/.well-known/agent.json",
      agent_log: "/agent_log.json",
      dashboard: "https://trustvault-dashboard.pages.dev",
    },
    version: "0.2.0",
  };
}

const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" fill="none">
  <rect width="1200" height="630" fill="#050505"/>
  <rect x="40" y="40" width="1120" height="550" fill="none" stroke="#1a1a1a" stroke-width="1"/>
  <rect x="60" y="60" width="1080" height="510" fill="none" stroke="#333" stroke-width="1"/>

  <!-- Grid lines -->
  <line x1="60" y1="200" x2="1140" y2="200" stroke="#1a1a1a" stroke-width="1"/>
  <line x1="60" y1="340" x2="1140" y2="340" stroke="#1a1a1a" stroke-width="1"/>
  <line x1="400" y1="60" x2="400" y2="570" stroke="#1a1a1a" stroke-width="1"/>
  <line x1="800" y1="60" x2="800" y2="570" stroke="#1a1a1a" stroke-width="1"/>

  <!-- Title block -->
  <rect x="80" y="80" width="12" height="12" fill="#00ff41"/>
  <text x="104" y="92" font-family="monospace" font-size="11" fill="#666" letter-spacing="3">TRUSTVAULT</text>
  <text x="80" y="150" font-family="monospace" font-size="56" fill="#fff" font-weight="bold" letter-spacing="-2">CREDIT</text>
  <text x="80" y="185" font-family="monospace" font-size="16" fill="#666" letter-spacing="1">programmable working capital for autonomous agents</text>

  <!-- Credit flow diagram -->
  <rect x="80" y="230" width="140" height="50" fill="none" stroke="#00ff41" stroke-width="1"/>
  <text x="100" y="260" font-family="monospace" font-size="11" fill="#00ff41">AGENT</text>
  <line x1="220" y1="255" x2="300" y2="255" stroke="#333" stroke-width="1" stroke-dasharray="4"/>
  <text x="232" y="248" font-family="monospace" font-size="9" fill="#666">request</text>

  <rect x="300" y="230" width="140" height="50" fill="none" stroke="#536dfe" stroke-width="1"/>
  <text x="310" y="260" font-family="monospace" font-size="11" fill="#536dfe">CREDIT ENGINE</text>
  <line x1="440" y1="255" x2="520" y2="255" stroke="#333" stroke-width="1" stroke-dasharray="4"/>
  <text x="450" y="248" font-family="monospace" font-size="9" fill="#666">advance</text>

  <rect x="520" y="230" width="140" height="50" fill="none" stroke="#ff9100" stroke-width="1"/>
  <text x="540" y="260" font-family="monospace" font-size="11" fill="#ff9100">TREASURY</text>
  <line x1="660" y1="255" x2="740" y2="255" stroke="#333" stroke-width="1" stroke-dasharray="4"/>
  <text x="672" y="248" font-family="monospace" font-size="9" fill="#666">repay</text>

  <rect x="740" y="230" width="140" height="50" fill="none" stroke="#00ff41" stroke-width="1"/>
  <text x="760" y="260" font-family="monospace" font-size="11" fill="#00ff41">MARKETPLACE</text>

  <!-- Stats block -->
  <text x="80" y="365" font-family="monospace" font-size="9" fill="#666" letter-spacing="2">CAPABILITIES</text>
  <text x="80" y="395" font-family="monospace" font-size="13" fill="#e0e0e0">&#x25A0; credit scoring + underwriting</text>
  <text x="80" y="418" font-family="monospace" font-size="13" fill="#e0e0e0">&#x25A0; marketplace bidding + award</text>
  <text x="80" y="441" font-family="monospace" font-size="13" fill="#e0e0e0">&#x25A0; repayment waterfall settlement</text>
  <text x="80" y="464" font-family="monospace" font-size="13" fill="#e0e0e0">&#x25A0; programmable spend controls</text>
  <text x="80" y="487" font-family="monospace" font-size="13" fill="#e0e0e0">&#x25A0; portfolio risk dashboard</text>
  <text x="80" y="510" font-family="monospace" font-size="13" fill="#e0e0e0">&#x25A0; ERC-8004 identity verification</text>

  <!-- Right side stats -->
  <text x="820" y="365" font-family="monospace" font-size="9" fill="#666" letter-spacing="2">STACK</text>
  <text x="820" y="395" font-family="monospace" font-size="13" fill="#666">runtime</text>
  <text x="1000" y="395" font-family="monospace" font-size="13" fill="#e0e0e0">cloudflare workers</text>
  <text x="820" y="418" font-family="monospace" font-size="13" fill="#666">state</text>
  <text x="1000" y="418" font-family="monospace" font-size="13" fill="#e0e0e0">durable objects</text>
  <text x="820" y="441" font-family="monospace" font-size="13" fill="#666">chain</text>
  <text x="1000" y="441" font-family="monospace" font-size="13" fill="#e0e0e0">sepolia (ERC-8004)</text>
  <text x="820" y="464" font-family="monospace" font-size="13" fill="#666">router</text>
  <text x="1000" y="464" font-family="monospace" font-size="13" fill="#e0e0e0">hono</text>
  <text x="820" y="487" font-family="monospace" font-size="13" fill="#666">lang</text>
  <text x="1000" y="487" font-family="monospace" font-size="13" fill="#e0e0e0">typescript</text>

  <!-- Footer -->
  <text x="80" y="555" font-family="monospace" font-size="10" fill="#ff1744" font-weight="bold">unbrained.club</text>
  <text x="1000" y="555" font-family="monospace" font-size="10" fill="#666">synthesis 2026</text>
</svg>`;

export default app;
