import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentCard } from "./agent-card";
import { CreditAgent } from "./engine";
import { listScenarios } from "./demo";
import { checkIdentityRegistration } from "./erc8004";
import { isChainEnabled, isEscrowEnabled, getEscrowStats, getVaultStats, getReputation, checkIdentityOnchain, getTokenBalance, mintTestTokens, getVaultPosition, verifyPayment } from "./chain";
import { authMiddleware, assertAuthorized, AuthorizationError } from "./auth";
import { computeFee, PROTOCOL_FEE_BPS } from "./pricing";
import { positiveNumber, boundedString, ethAddress } from "./validate";
import { getX402Config } from "./x402";
import { getPaymentMethods } from "./payments";
import { mppGate, isMppEnabled } from "./mpp";
import { landingHTML } from "./landing";
import { getActiveChains, getChainConfig, getChainClients, explorerUrl } from "./chains";
import type { AgentRegistrationInput, Env, PortfolioReport, RiskReport, SpendCategory, TimelineEvent, TreasuryState } from "./types";

export { CreditAgent };

const app = new Hono<{ Bindings: Env; Variables: { verifiedAddress: string } }>();

app.use("*", cors());

// Auth on financial endpoints — POST requires wallet signature, GET is public
app.use("/agents/*", authMiddleware);
app.use("/credit/*", authMiddleware);
app.use("/marketplace/*", authMiddleware);
app.use("/spend/*", authMiddleware);
app.use("/treasury/*", authMiddleware);
// Demo/bootstrap endpoints are intentionally public (judges, dashboards, agents bootstrapping)

// ─── Root (Landing Page) ───

app.get("/", (c) => {
  const accept = c.req.header("accept") ?? "";
  // Agents requesting JSON get the agent card
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return c.json(agentCard(c.env));
  }
  // Browsers get the landing page
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(landingHTML());
});

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

// ─── Use Cases & LP Onboarding ───

app.get("/use-cases", (c) => {
  return c.json({
    title: "Who uses TrustVault Credit?",
    forAgents: {
      headline: "Agents that accept work and need upfront capital",
      description: "You've been hired for a job. Payment comes after delivery. But you need to spend NOW on compute, APIs, gas, or sub-agents. TrustVault Credit advances you working capital against your guaranteed payout.",
      examples: [
        {
          name: "Quantitative Trading Agent",
          scenario: "Runs a multi-hour DeFi yield strategy. Needs $50 for data feeds (Chainlink, Dune), $30 for LLM analysis, $20 for gas across 15 transactions over 6 hours. Expected return: $300.",
          howItWorks: "Agent posts the strategy as a job (expectedPayout: $300, duration: 6h). Requests $100 advance. Pays for data, compute, and gas over 6 hours as the strategy executes. Completes job. Waterfall: $100 principal + $3 fee repaid. Agent nets $197.",
          duration: "4-12 hours",
          feeRange: "2-3% (short duration, proven trader history)",
          whyCredit: "Unlike flash loans (same-block atomic), trading agents need capital ACROSS blocks — for data, compute, and multi-step execution over hours. TrustVault Credit bridges this gap.",
        },
        {
          name: "Code Generation Agent",
          scenario: "Hired for a $200 smart contract audit. Needs $30 for Claude API inference, $5 for test deployment gas, $3 for Foundry compute.",
          howItWorks: "Agent registers, job is created with $200 expected payout. Requests $38 advance for compute. Completes audit. Client pays $200. Waterfall: $38 principal + $1.90 fee repaid. Agent nets $160.10.",
          duration: "24-48 hours",
          feeRange: "4-5% (daily duration, moderate risk)",
          whyCredit: "Agent can accept the job immediately without waiting for a human to pre-fund a wallet.",
        },
        {
          name: "Research / Data Agent",
          scenario: "Hired to analyze DeFi protocol metrics. Needs $15 for Dune API, $8 for LLM summarization, $2 for report hosting.",
          howItWorks: "Requests $25 advance against $80 job payout. Completes research. Waterfall repays $25 + $1.25 fee. Agent nets $53.75.",
          duration: "12-24 hours",
          feeRange: "3-4%",
          whyCredit: "Enables agent to take on multiple research jobs simultaneously without pooling capital.",
        },
        {
          name: "Multi-Agent Coordinator",
          scenario: "Lead agent hired for $500 project. Needs to hire 3 sub-agents at $50 each + $20 compute.",
          howItWorks: "Requests $170 advance. Pays sub-agents. Completes project. Waterfall repays $170 + $10.20 fee. Agent nets $319.80.",
          duration: "48-72 hours",
          feeRange: "5-7% (multi-day, sub-agent spend category)",
          whyCredit: "The lead agent is the underwriter — its reputation backs the advance. Sub-agents get paid upfront.",
        },
      ],
    },
    forLPs: {
      headline: "Earn yield from agent credit fees",
      description: "Deposit USDC into the ERC-4626 vault. Your capital funds short-duration advances to agents. As they repay with fees, your share price increases. Withdrawals available up to idle capital (capital deployed in active advances is locked until repayment).",
      yield: {
        source: "Credit fees from agent advances (3-25% per advance, depending on risk)",
        estimatedAPY: "30-80% (based on capital utilization and advance frequency)",
        comparison: "Aave USDC: 3-5% APY. Agent credit fees are higher because durations are shorter and demand is job-specific.",
        risk: "Default risk. Mitigated by: receivable-backed advances (30% max of job payout), credit scoring, reputation history, and the pool loss surcharge that rebuilds reserves.",
      },
      howToDeposit: {
        step1: "Go to https://trustvault-dashboard.pages.dev",
        step2: "Click 'Connect Wallet' in the Vault panel",
        step3: "Enter amount → Deposit (wallet handles approve + deposit in one flow)",
        step4: "Receive tvCREDIT shares — share price increases as fees accumulate",
        step5: "Withdraw idle capital from the same panel (deployed capital unlocks as advances repay)",
      },
      faucet: "Need testnet tUSDC? POST https://credit.unbrained.club/faucet/0xYourAddress",
      currentVault: "Live stats: https://credit.unbrained.club/health",
    },
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
    vault: vaultStats ? {
      ...vaultStats,
      maxWithdrawable: vaultStats.idleBalance, // only idle capital is instantly redeemable
      note: "totalAssets includes capital deployed in escrow. maxWithdrawable shows instantly redeemable amount.",
    } : null,
  });
});

// ─── Vault (LP agents) ───

app.get("/vault/opportunity", async (c) => {
  const vaultStats = c.env.CREDIT_VAULT ? await getVaultStats(c.env) : null;
  const agent = getAgent(c.env);
  const treasury = await agent.getTreasury() as TreasuryState;
  const portfolio = await agent.getPortfolio() as PortfolioReport;
  const risk = await agent.getRisk() as RiskReport;

  const totalAdvances = portfolio.summary.totalAdvances;
  const avgFeeRate = treasury.totalFeesEarned > 0 && treasury.totalAdvanced > 0
    ? treasury.totalFeesEarned / treasury.totalAdvanced
    : 0.05;
  // Rough APY estimate: fee rate * annual turnover of capital
  // If average advance duration is ~24h, capital turns over ~365x/year
  // Adjusted by utilization (not all capital is deployed at once)
  const utilization = treasury.totalDeposited > 0
    ? (treasury.totalAdvanced - treasury.totalRepaid) / treasury.totalDeposited
    : 0;
  const estimatedAPY = avgFeeRate * 365 * Math.max(utilization, 0.1);

  return c.json({
    type: "yield-opportunity",
    protocol: "TrustVault Credit",
    asset: "tUSDC",
    network: "eip155:11155111",
    vault: {
      standard: "ERC-4626",
      shareToken: "tvCREDIT",
      sharePrice: vaultStats?.sharePrice ?? "1.000000",
      totalAssets: vaultStats?.totalAssets ?? "0",
      totalShares: vaultStats?.totalShares ?? "0",
      feesEarned: vaultStats?.feesEarned ?? "0",
      defaultLoss: vaultStats?.defaultLoss ?? "0",
    },
    yield: {
      currentFeeRate: `${(avgFeeRate * 100).toFixed(2)}%`,
      estimatedAPY: `${(estimatedAPY * 100).toFixed(1)}%`,
      source: "Credit fees from agent advances (85% of fees go to depositors)",
      protocolTake: "15%",
    },
    risk: {
      level: risk.overallRisk,
      healthScore: risk.healthScore,
      defaultRate: `${(portfolio.summary.defaultRate * 100).toFixed(1)}%`,
      utilizationRate: `${(utilization * 100).toFixed(1)}%`,
      maxAdvanceRatio: "30% of job payout (receivable-backed)",
      mitigations: [
        "Advances capped at 30% of expected job payout",
        "Dynamic fees increase with pool utilization (kink model)",
        "Pool loss surcharge rebuilds reserves after defaults",
        "Credit scoring reduces exposure to risky borrowers",
      ],
    },
    pool: {
      totalDeposited: treasury.totalDeposited,
      totalAdvanced: treasury.totalAdvanced,
      totalRepaid: treasury.totalRepaid,
      totalFeesEarned: treasury.totalFeesEarned,
      totalDefaultLoss: treasury.totalDefaultLoss,
      activeAdvances: portfolio.summary.activeAdvances,
      totalBorrowers: portfolio.summary.totalAgents,
    },
    howToDeposit: {
      description: "Approve tUSDC to the vault contract, then call deposit(). Standard ERC-4626 flow.",
      tokenContract: c.env.TEST_USDC ?? "not configured",
      vaultContract: c.env.CREDIT_VAULT ?? "not configured",
      steps: [
        { action: "approve", target: "token", method: "approve(vaultAddress, amount)", description: "Allow vault to pull your tUSDC" },
        { action: "deposit", target: "vault", method: "deposit(amount, yourAddress)", description: "Deposit tUSDC, receive tvCREDIT shares" },
      ],
      withdraw: { method: "redeem(shares, yourAddress, yourAddress)", description: "Burn tvCREDIT shares, receive tUSDC (up to idle capital — deployed capital unlocks as advances repay)" },
      abi: {
        deposit: "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
        redeem: "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
        approve: "function approve(address spender, uint256 amount) returns (bool)",
      },
    },
    monitor: {
      vaultStats: "/health",
      feeModel: "/fees",
      portfolioRisk: "/dashboard/risk",
      position: "/vault/position/{yourAddress}",
    },
  });
});

app.get("/vault/position/:address", async (c) => {
  const address = c.req.param("address");
  const [position, tokenBalance, vaultStats] = await Promise.all([
    getVaultPosition(c.env, address),
    getTokenBalance(c.env, address),
    c.env.CREDIT_VAULT ? getVaultStats(c.env) : null,
  ]);

  const shares = position ? parseFloat(position.shares) : 0;
  const value = position ? parseFloat(position.value) : 0;
  const deposited = shares; // 1:1 at initial deposit
  const earned = value - deposited;

  return c.json({
    address,
    wallet: {
      tUSDC: tokenBalance ? `${tokenBalance}` : "0",
    },
    position: {
      shares: position?.shares ?? "0",
      sharesToken: "tvCREDIT",
      currentValue: position?.value ?? "0",
      currentValueToken: "tUSDC",
      estimatedYield: earned > 0 ? earned.toFixed(6) : "0",
      sharePrice: position?.sharePrice ?? "1.000000",
    },
    pool: {
      totalAssets: vaultStats?.totalAssets ?? "0",
      totalShares: vaultStats?.totalShares ?? "0",
      feesEarned: vaultStats?.feesEarned ?? "0",
      defaultLoss: vaultStats?.defaultLoss ?? "0",
    },
    explorer: `https://sepolia.etherscan.io/address/${address}`,
  });
});

// ─── Agent Registration ───

app.post("/agents/register", async (c) => {
  const body = await c.req.json<AgentRegistrationInput>();
  assertAuthorized(c.get("verifiedAddress"), body.address); // signer must be the agent
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
  assertAuthorized(c.get("verifiedAddress"), agentAddress);
  return c.json(await getAgent(c.env).getProfile(agentAddress));
});

app.post("/credit/quote", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }>();
  assertAuthorized(c.get("verifiedAddress"), body.agentAddress);
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
  assertAuthorized(c.get("verifiedAddress"), body.agentAddress);
  body.requestedAmount = positiveNumber(body.requestedAmount, "requestedAmount");
  body.purpose = boundedString(body.purpose, "purpose");
  return c.json(await getAgent(c.env).createAdvance(body));
});

app.post("/credit/default", async (c) => {
  const body = await c.req.json<{ advanceId: string; agentAddress: string; reason: string }>();
  assertAuthorized(c.get("verifiedAddress"), body.agentAddress);
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
  assertAuthorized(c.get("verifiedAddress"), body.agentAddress);
  body.expectedPayout = positiveNumber(body.expectedPayout, "expectedPayout");
  body.durationHours = positiveNumber(body.durationHours, "durationHours");
  body.title = boundedString(body.title, "title");
  return c.json(await getAgent(c.env).createJob(body));
});

app.post("/marketplace/jobs/:jobId/complete", async (c) => {
  const body = await c.req.json<{
    actualPayout?: number;
    paymentTxHash?: string;  // On-chain tUSDC transfer to escrow
  }>();
  const callerAddress = c.get("verifiedAddress");
  const jobId = c.req.param("jobId");
  const agent = getAgent(c.env);

  // When escrow is enabled, on-chain payment proof is REQUIRED
  if (isEscrowEnabled(c.env)) {
    if (!body.paymentTxHash) {
      return c.json({
        error: "Payment proof required. Transfer tUSDC to the escrow contract and provide paymentTxHash.",
        escrowAddress: c.env.CREDIT_ESCROW,
        paymentMethods: "/payment/methods",
      }, 402);
    }

    // Check for replay — same tx cannot settle multiple jobs
    const consumed = await agent.isPaymentConsumed(body.paymentTxHash);
    if (consumed) {
      return c.json({ error: "This payment transaction has already been used to settle a job." }, 409);
    }

    // Verify the transfer on-chain
    const escrowAddr = c.env.CREDIT_ESCROW!;
    const verification = await verifyPayment(c.env, body.paymentTxHash, escrowAddr, body.actualPayout ?? 0);
    if (!verification?.verified) {
      return c.json({
        error: "Payment verification failed. Transfer must be tUSDC to the escrow contract.",
        escrowAddress: escrowAddr,
        txHash: body.paymentTxHash,
        verification,
      }, 402);
    }

    // Mark tx as consumed and use verified amount
    await agent.consumePayment(body.paymentTxHash, jobId);
    body.actualPayout = parseFloat(verification.amount);
  }

  return c.json(
    await agent.completeJob({
      jobId,
      actualPayout: body.actualPayout,
      callerAddress,
    }),
  );
});

// ─── MPP-gated job completion (agent pays via mppx.fetch()) ───
// When TEMPO_ACCOUNT or STRIPE_SECRET_KEY is set, this route gates
// job completion behind a real MPP payment. Agents using mppx.fetch()
// handle the 402 challenge automatically.

app.post("/marketplace/jobs/:jobId/pay-mpp", async (c, next) => {
  // Dynamic MPP gate: read the job to determine the payment amount
  if (!isMppEnabled(c.env as import("./types").Env)) {
    return c.json({
      error: "MPP not configured. Set TEMPO_ACCOUNT or STRIPE_SECRET_KEY.",
      alternative: "POST /marketplace/jobs/:jobId/complete with paymentTxHash",
    }, 501);
  }

  // Get job payout to set the charge amount
  const jobId = c.req.param("jobId");
  const agent = getAgent(c.env);
  const snapshot = await agent.getSnapshot();
  const jobs = (snapshot as Record<string, unknown>).jobs as Record<string, { expectedPayout: number; status: string }> | undefined;
  const job = jobs?.[jobId];
  if (!job) return c.json({ error: `Unknown job: ${jobId}` }, 404);
  if (job.status !== "open") return c.json({ error: "Job is not open." }, 400);

  // Apply MPP payment gate with the job's expected payout
  const gate = mppGate(String(job.expectedPayout));
  return gate(c, next);
}, async (c) => {
  // If we reach here, MPP has verified and settled the payment
  const jobId = c.req.param("jobId");
  const callerAddress = c.get("verifiedAddress");
  const agent = getAgent(c.env);

  const result = await agent.completeJob({
    jobId,
    callerAddress: callerAddress ?? "system",
  });

  return c.json({
    ...result,
    paymentMethod: "mpp",
  });
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
  assertAuthorized(c.get("verifiedAddress"), body.postedBy);
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
  assertAuthorized(c.get("verifiedAddress"), body.agentAddress);
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
      callerAddress: c.get("verifiedAddress"),
    }),
  );
});

// ─── Treasury ───

app.post("/treasury/deposit", async (c) => {
  const body = await c.req.json<{
    lenderAddress: string;
    amount: number;
    memo?: string;
    depositTxHash?: string; // On-chain proof of vault deposit
  }>();
  assertAuthorized(c.get("verifiedAddress"), body.lenderAddress);
  body.amount = positiveNumber(body.amount, "amount");

  // When chain is enabled, require on-chain deposit proof with replay prevention
  const agent = getAgent(c.env);
  if (isChainEnabled(c.env) && c.env.CREDIT_VAULT) {
    if (!body.depositTxHash) {
      return c.json({
        error: "On-chain deposit proof required. Deposit tUSDC into the vault contract and provide depositTxHash.",
        vaultContract: c.env.CREDIT_VAULT,
      }, 402);
    }
    const consumed = await agent.isPaymentConsumed(body.depositTxHash) as boolean;
    if (consumed) {
      return c.json({ error: "This deposit transaction has already been recorded." }, 409);
    }
    const verification = await verifyPayment(c.env, body.depositTxHash, c.env.CREDIT_VAULT, body.amount);
    if (!verification?.verified) {
      return c.json({ error: "Deposit verification failed. Transfer must be tUSDC to the vault.", txHash: body.depositTxHash }, 402);
    }
    await agent.consumePayment(body.depositTxHash, `deposit:${body.lenderAddress}`);
    body.amount = parseFloat(verification.amount);
  }

  return c.json(await agent.deposit(body));
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
  // Authorization is inside the engine — it checks advance.agentAddress matches caller
  return c.json(await getAgent(c.env).recordSpend({
    ...body,
    callerAddress: c.get("verifiedAddress"),
  }));
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

// ─── Faucet (testnet only) ───

const FAUCET_AMOUNT = 100; // 100 tUSDC per drip
const FAUCET_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const TESTNET_CHAIN_IDS = ["11155111", "84532"]; // Sepolia, Base Sepolia
const faucetLastDrip = new Map<string, number>(); // In-memory (acceptable for testnet)

app.post("/faucet/:address", async (c) => {
  // Validate address format
  let address: string;
  try { address = ethAddress(c.req.param("address"), "address"); }
  catch { return c.json({ error: "Invalid Ethereum address (0x + 40 hex chars)." }, 400); }
  if (address === "0x0000000000000000000000000000000000000000") {
    return c.json({ error: "Cannot mint to zero address." }, 400);
  }

  // Testnet guard — only allow on known testnets
  const chainId = c.env.CHAIN_ID ?? "";
  if (chainId && !TESTNET_CHAIN_IDS.includes(chainId)) {
    return c.json({ error: "Faucet is only available on testnets." }, 403);
  }

  if (!isChainEnabled(c.env)) {
    return c.json({ error: "Chain not configured." }, 503);
  }

  // Rate limit (in-memory — resets on cold start, acceptable for testnet)
  const lastDrip = faucetLastDrip.get(address) ?? 0;
  const now = Date.now();
  if (now - lastDrip < FAUCET_COOLDOWN_MS) {
    const waitMinutes = Math.ceil((FAUCET_COOLDOWN_MS - (now - lastDrip)) / 60000);
    return c.json({ error: `Rate limited. Try again in ${waitMinutes} minutes.` }, 429);
  }

  const result = await mintTestTokens(c.env, address, FAUCET_AMOUNT);
  if (!result) {
    return c.json({ error: "Mint failed." }, 500);
  }

  faucetLastDrip.set(address, now);

  return c.json({
    message: `Minted ${result.amount} tUSDC to ${address}`,
    txHash: result.txHash,
    amount: `${result.amount} tUSDC`,
    explorer: `https://sepolia.etherscan.io/tx/${result.txHash}`,
    note: "Testnet tokens only. 1 drip per hour per address.",
  });
});

app.get("/faucet/info", (c) => {
  return c.json({
    token: "tUSDC (TestUSDC)",
    network: "sepolia",
    amountPerDrip: `${FAUCET_AMOUNT} tUSDC`,
    cooldown: "1 hour",
    usage: "POST /faucet/0xYourAddress",
    note: "Zero-capital bootstrap: register → get tokens from faucet → start borrowing. On mainnet, agents receive advances directly from the escrow without needing pre-existing tokens.",
  });
});

// ─── Agent Bootstrap ───

app.get("/bootstrap", (c) => {
  const x402Config = getX402Config(c.env);
  return c.json({
    title: "Zero-Capital Agent Bootstrap",
    description: "Agents interact via HTTP only. No tokens or gas needed to start.",
    steps: [
      {
        step: 1,
        action: "Generate a wallet address (any Ethereum keypair)",
        cost: "Free (local computation)",
      },
      {
        step: 2,
        action: "POST /agents/register with your address and name",
        cost: "Free (HTTP call)",
      },
      {
        step: 3,
        action: "Get assigned a job or bid on one via /marketplace",
        cost: "Free (HTTP call)",
      },
      {
        step: 4,
        action: "POST /credit/advance to request working capital",
        cost: "Free (HTTP call). Escrow sends tUSDC to your address on-chain.",
      },
      {
        step: 5,
        action: "Spend the advance on compute, APIs, gas, sub-agents",
        cost: "Track via POST /spend/record",
      },
      {
        step: 6,
        action: "Complete the job. Waterfall repays principal + fees automatically.",
        cost: "Free (HTTP call). Worker signs all chain transactions.",
      },
    ],
    gasModel: "Protocol-sponsored. The worker wallet signs all on-chain transactions. Agents never need ETH for gas.",
    tokenModel: "Agents receive tokens from the escrow via advances. No pre-funding required.",
    faucet: {
      available: isChainEnabled(c.env),
      endpoint: "POST /faucet/:address",
      note: "For testing/LP deposits. Agents borrowing via advances don't need this.",
    },
    x402: {
      available: !!x402Config,
      description: "Job posters can pay via x402 (gasless USDC payments via HTTP 402). Payment flows into escrow automatically.",
      endpoint: x402Config ? "POST /marketplace/jobs/:jobId/pay" : null,
      network: x402Config?.network ?? "Not configured (set X402_FACILITATOR_URL to enable)",
    },
  });
});

// ─── Multi-Chain ───

app.get("/chains", (c) => {
  const active = getActiveChains(c.env);
  return c.json({
    description: "Active chains where TrustVault Credit contracts are deployed. Add a chain by setting {PREFIX}_RPC_URL + {PREFIX}_USDC environment variables.",
    chains: active,
    count: active.length,
  });
});

app.get("/chain/:chainId/health", async (c) => {
  const chainId = c.req.param("chainId");
  const config = getChainConfig(c.env, chainId);
  if (!config) return c.json({ error: `Chain ${chainId} not configured.` }, 404);

  const clients = getChainClients(config);
  const walletAddress = clients.account.address;

  let escrowBalance: string | null = null;
  if (config.escrow) {
    try {
      const bal = await clients.publicClient.readContract({
        address: config.token,
        abi: [{ type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
        functionName: "balanceOf",
        args: [config.escrow],
      });
      escrowBalance = `${Number(bal) / 1e6} USDC`;
    } catch { /* chain may not be reachable */ }
  }

  return c.json({
    chain: config.meta.name,
    chainId: config.meta.chainId,
    network: config.meta.id,
    explorer: config.meta.explorer,
    contracts: {
      token: config.token,
      escrow: config.escrow ?? null,
      vault: config.vault ?? null,
      reputation: config.reputation ?? null,
      identity: config.identity ?? null,
    },
    escrowBalance,
  });
});

app.get("/chain/:chainId/credit-check/:address", async (c) => {
  const chainId = c.req.param("chainId");
  let address: string;
  try { address = ethAddress(c.req.param("address"), "address"); }
  catch { return c.json({ error: "Invalid Ethereum address." }, 400); }
  const config = getChainConfig(c.env, chainId);
  if (!config?.reputation) return c.json({ error: `No reputation oracle on ${chainId}.` }, 404);

  const clients = getChainClients(config);
  try {
    const [score, attestations] = await clients.publicClient.readContract({
      address: config.reputation,
      abi: [{ type: "function", name: "getReputation", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "score", type: "uint256" }, { name: "attestationCount", type: "uint256" }], stateMutability: "view" }],
      functionName: "getReputation",
      args: [address as `0x${string}`],
    }) as [bigint, bigint];
    return c.json({
      chain: config.meta.id,
      address,
      score: Number(score),
      attestationCount: Number(attestations),
      explorer: explorerUrl(chainId, "address", address),
    });
  } catch (e) {
    return c.json({ error: "Failed to read reputation.", chain: chainId }, 500);
  }
});

// ─── Payment Methods ───

app.get("/payment/methods", (c) => {
  return c.json(getPaymentMethods(c.env));
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

// ─── Auth Helper ───

app.get("/auth/info", (c) => {
  return c.json({
    scheme: "EIP-191 wallet signature",
    headers: {
      "X-Agent-Address": "0xYourWalletAddress",
      "X-Agent-Signature": "0x... (EIP-191 signature of the message below)",
      "X-Agent-Timestamp": "Unix seconds (must be within 5 minutes of server time)",
    },
    message: "trustvault-credit:{address}:{timestamp}",
    example: "trustvault-credit:0xabcdef1234567890abcdef1234567890abcdef12:1711234567",
    note: "GET requests are public. POST/PUT/DELETE require authentication. Sign with any EIP-191 compatible wallet (ethers.js, viem, MetaMask).",
    readEndpoints: "GET /health, /fees, /bootstrap, /treasury, /timeline, /onchain/:address — no auth needed",
  });
});

app.onError((error, c) => {
  if (error instanceof AuthorizationError) {
    return c.json({ error: error.message }, 403);
  }
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
    description: "Programmable working capital for autonomous agents. Revenue-backed microcredit with dynamic utilization-based fees, on-chain escrow, ERC-4626 vault for depositor yield, and reputation-linked underwriting.",
    operator_wallet: "0xa3D3E3859C7EE7EEA5d682A4BaC19c45aDB82388",
    erc8004_identity: {
      registry: "0xb5a8d645ff6c749f600a3ff31d71cdfad518737b",
      chain: "sepolia",
      chain_id: 11155111,
    },
    supported_tools: [
      "credit-underwriting",
      "dynamic-fee-pricing",
      "marketplace-bidding",
      "repayment-waterfall",
      "spend-controls",
      "erc4626-vault",
      "on-chain-escrow",
      "risk-dashboard",
    ],
    task_categories: [
      "agent-credit-underwriting",
      "marketplace-receivable-financing",
      "programmable-spend-controls",
      "portfolio-risk-analysis",
    ],
    onchain: {
      network: "sepolia",
      token: "tUSDC",
      escrow: "0x9779330f469256c9400efe8880df74a0c29d2ea7",
      vault: "ERC-4626",
    },
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
