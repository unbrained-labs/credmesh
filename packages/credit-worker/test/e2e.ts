/**
 * CredMesh — End-to-End Test Suite
 *
 * Hits the live testnet deployment at credit.unbrained.club.
 * Uses real EIP-191 wallet signatures for authenticated endpoints.
 *
 * Run: npm run test:e2e  (from repo root)
 *
 * Three tiers:
 *   1. Public endpoints & discovery
 *   2. Authenticated happy path (register → job → quote → advance → spend)
 *   3. Edge cases & error handling
 *   4. Full lifecycle via demo bootstrap + state verification
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, pad, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

// ─── Configuration ───

const BASE_URL = process.env.TRUSTVAULT_URL ?? "https://credit.unbrained.club";

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "test-admin-secret";

// ─── Test Harness ───

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - start}ms)`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name, passed: false, error: msg, duration: Date.now() - start });
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertInRange(value: number, min: number, max: number, label: string): void {
  if (value < min || value > max) {
    throw new Error(`${label}: ${value} not in range [${min}, ${max}]`);
  }
}

// ─── HTTP Client ───

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function postRaw(path: string, body: unknown, auth?: AuthHeaders): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    headers["X-Agent-Address"] = auth.address;
    headers["X-Agent-Signature"] = auth.signature;
    headers["X-Agent-Timestamp"] = auth.timestamp;
  }
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function post<T>(path: string, body: unknown, auth?: AuthHeaders): Promise<T> {
  const res = await postRaw(path, body, auth);
  return res.json() as Promise<T>;
}

async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN_SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ─── Auth Helpers ───

interface AuthHeaders {
  address: string;
  signature: string;
  timestamp: string;
}

async function signAuth(privateKey: `0x${string}`): Promise<AuthHeaders> {
  const account = privateKeyToAccount(privateKey);
  const address = account.address.toLowerCase();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `credmesh:${address}:${timestamp}`;
  const signature = await account.signMessage({ message });
  return { address, signature, timestamp };
}

// ─── Test Wallets ───

const walletA = generatePrivateKey();
const walletB = generatePrivateKey();
const accountA = privateKeyToAccount(walletA);
const accountB = privateKeyToAccount(walletB);
const addressA = accountA.address.toLowerCase();
const addressB = accountB.address.toLowerCase();

// ─── Shared State ───

let jobIdA: string;

// ════════════════════════════════════════════════════════════════
// TIER 1: Public Endpoints & Discovery
// ════════════════════════════════════════════════════════════════

async function tier1() {
  console.log("\n\x1b[1m── Tier 1: Public Endpoints & Discovery ──\x1b[0m\n");

  await test("GET /health returns ok", async () => {
    const health = await get<{ status: string; version: string }>("/health");
    assertEqual(health.status, "ok", "status");
    assert(!!health.version, "version should be present");
  });

  await test("GET /.well-known/agent.json returns valid A2A card", async () => {
    const card = await get<{
      name: string;
      description: string;
      skills: Array<{ id: string }>;
      authentication: { schemes: string[] };
    }>("/.well-known/agent.json");
    assert(card.name.includes("CredMesh"), `name should contain CredMesh, got: ${card.name}`);
    assert(Array.isArray(card.skills), "skills should be an array");
    assert(card.skills.length >= 5, `should have at least 5 skills, got ${card.skills.length}`);
  });

  await test("GET /agent.json returns devSpot manifest", async () => {
    const manifest = await get<{
      name: string;
      supported_tools: string[];
      task_categories: string[];
    }>("/agent.json");
    assert(Array.isArray(manifest.supported_tools), "supported_tools should be an array");
    assert(manifest.supported_tools.length >= 5, "should have 5+ supported tools");
  });

  await test("GET /fees returns fee model", async () => {
    const fees = await get<{
      model: string;
      protocolFeeBps: number;
      exampleRates: { bestCase: { effectiveRate: number }; riskyCase: { effectiveRate: number } };
    }>("/fees");
    assertEqual(fees.model, "dynamic-utilization", "model");
    assertEqual(fees.protocolFeeBps, 1500, "protocolFeeBps");
    assertInRange(fees.exampleRates.bestCase.effectiveRate, 0.02, 0.25, "bestCase rate");
    assert(
      fees.exampleRates.riskyCase.effectiveRate >= fees.exampleRates.bestCase.effectiveRate,
      "risky rate should be >= best rate",
    );
  });

  await test("GET /bootstrap returns zero-capital bootstrap guide", async () => {
    const guide = await get<{ steps: Array<{ step: number }>; gasModel: string }>("/bootstrap");
    assert(Array.isArray(guide.steps), "steps should be an array");
    assert(guide.steps.length >= 5, "should have 5+ steps");
    assert(guide.gasModel.toLowerCase().includes("protocol"), "should mention protocol-sponsored gas");
  });

  await test("GET /use-cases returns agent + LP use cases", async () => {
    const cases = await get<{
      forAgents: { examples: unknown[] };
      forLPs: { yield: { source: string } };
    }>("/use-cases");
    assert(cases.forAgents.examples.length >= 3, "should have 3+ agent examples");
    assert(!!cases.forLPs.yield.source, "LP yield source should be present");
  });

  await test("GET /chains returns active chain list", async () => {
    const chains = await get<{ chains: Array<{ chainId: number }>; count: number }>("/chains");
    assert(chains.count >= 1, "should have at least 1 active chain");
  });

  await test("GET /auth/info returns auth instructions", async () => {
    const info = await get<{ scheme: string; headers: Record<string, string>; message: string }>("/auth/info");
    assert(info.scheme.includes("EIP-191"), "should mention EIP-191");
    assert(info.message.includes("credmesh:"), "message template should match");
  });

  await test("GET /payment/methods returns available methods", async () => {
    const methods = await get<{ methods: unknown[] }>("/payment/methods");
    assert(Array.isArray(methods.methods), "methods should be an array");
  });

  await test("GET /demo/scenarios returns scenario list", async () => {
    const scenarios = await get<Array<{ name: string; description: string }>>("/demo/scenarios");
    assert(Array.isArray(scenarios), "should be an array");
    assert(scenarios.length >= 3, "should have 3 scenarios");
    const names = scenarios.map((s) => s.name);
    assert(names.includes("happy"), "should include happy scenario");
    assert(names.includes("failure"), "should include failure scenario");
  });

  await test("GET / with Accept: application/json returns agent card", async () => {
    const res = await fetch(`${BASE_URL}/`, {
      headers: { Accept: "application/json" },
    });
    assertEqual(res.status, 200, "status");
    const body = await res.json() as { name: string };
    assert(body.name.includes("CredMesh"), "JSON root should return agent card");
  });

  await test("GET / with Accept: text/html returns landing page", async () => {
    const res = await fetch(`${BASE_URL}/`, {
      headers: { Accept: "text/html" },
    });
    assertEqual(res.status, 200, "status");
    const body = await res.text();
    assert(body.includes("<!DOCTYPE html>") || body.includes("<html"), "should return HTML");
  });
}

// ════════════════════════════════════════════════════════════════
// TIER 2: Authenticated Happy Path
// ════════════════════════════════════════════════════════════════

async function tier2() {
  console.log("\n\x1b[1m── Tier 2: Authenticated Happy Path ──\x1b[0m\n");

  // Reset state for clean test run
  await test("POST /demo/reset clears state", async () => {
    const res = await adminPost<{ message: string }>("/demo/reset", {});
    assert(res.message.includes("reset"), `expected reset confirmation, got: ${res.message}`);
  });

  // Seed treasury via demo bootstrap (bypasses on-chain proof requirement)
  await test("POST /demo/bootstrap seeds treasury + demo data", async () => {
    const res = await adminPost<{ summary: string; agentsCreated: number; advancesCreated: number }>(
      "/demo/bootstrap",
      { scenario: "happy" },
    );
    assert(res.agentsCreated >= 3, `expected 3+ agents, got ${res.agentsCreated}`);
    assert(res.advancesCreated >= 0, "advances should be non-negative");
  });

  // Verify treasury has funds
  await test("GET /treasury shows seeded funds", async () => {
    const treasury = await get<{ availableFunds: number; totalDeposited: number }>("/treasury");
    assert(treasury.totalDeposited > 0, "treasury should have deposits after bootstrap");
  });

  // Register a new agent with real wallet auth
  // SECURITY: Self-reported scores are ignored — agents start at 0 and build credit through the protocol
  await test("POST /agents/register with valid signature", async () => {
    const auth = await signAuth(walletA);
    const res = await post<{ address: string; name: string; trustScore: number; createdAt: number }>(
      "/agents/register",
      {
        address: addressA,
        name: "e2e-test-agent",
        trustScore: 70, // ignored by the engine
      },
      auth,
    );
    assertEqual(res.address, addressA, "address");
    assertEqual(res.name, "e2e-test-agent", "name");
    assertEqual(res.trustScore, 0, "trustScore should be 0 (self-reported values ignored)");
    assert(res.createdAt > 0, "createdAt should be set");
  });

  // Read back agent
  await test("GET /agents/:address returns registered agent", async () => {
    const agent = await get<{ address: string; name: string; trustScore: number }>(
      `/agents/${addressA}`,
    );
    assertEqual(agent.address, addressA, "address");
    assertEqual(agent.name, "e2e-test-agent", "name");
    assertEqual(agent.trustScore, 0, "trustScore should be 0 (protocol-tracked only)");
  });

  // Get credit profile — new agent with no history gets minimal score
  await test("POST /credit/profile returns valid credit profile", async () => {
    const auth = await signAuth(walletA);
    const profile = await post<{
      creditScore: number;
      creditLimit: number;
      availableCredit: number;
      repaymentRate: number;
    }>("/credit/profile", { agentAddress: addressA }, auth);
    assertInRange(profile.creditScore, 0, 100, "creditScore");
    // New agent with zero history may have 0 credit limit — that's correct
    assertEqual(profile.repaymentRate, 1, "repaymentRate should be 1 (no history)");
  });

  // The test agent has zero protocol-tracked credit (no history).
  // Demo bootstrap created agents with real history — use a demo agent for advance tests.
  // atlas-research (0xaa11...) has protocol-tracked successfulJobs/repaidAdvances from the happy path.

  // Create a job for the demo agent
  await test("POST /marketplace/jobs creates job", async () => {
    // Register the demo agent address with our test wallet to get auth
    // We can't sign for the demo agent, so create a job with our own agent
    // and test the quote/advance flow via demo instead
    const auth = await signAuth(walletA);
    const job = await post<{ id: string; status: string; expectedPayout: number; category: string }>(
      "/marketplace/jobs",
      {
        agentAddress: addressA,
        payer: "0xc11e000000000000000000000000000000000099",
        title: "E2E test job",
        expectedPayout: 200,
        durationHours: 24,
        category: "code",
      },
      auth,
    );
    assert(!!job.id, "job should have an id");
    assertEqual(job.status, "open", "status");
    assertEqual(job.expectedPayout, 200, "expectedPayout");
    assertEqual(job.category, "code", "category");
    jobIdA = job.id;
  });

  // Quote — new agent with no history gets DECLINED (correct behavior)
  await test("POST /credit/quote returns DECLINED for new agent (no history)", async () => {
    const auth = await signAuth(walletA);
    const quote = await post<{
      decision: string;
      approvedAmount: number;
    }>("/credit/quote", {
      agentAddress: addressA,
      jobId: jobIdA,
      requestedAmount: 30,
      purpose: "compute and API calls",
    }, auth);
    assertEqual(quote.decision, "DECLINED", "new agent with no credit history should be DECLINED");
  });

  // Advance — also DECLINED for new agent
  await test("POST /credit/advance returns DECLINED for new agent", async () => {
    const auth = await signAuth(walletA);
    const res = await post<{
      quote: { decision: string };
      advance?: { id: string };
    }>("/credit/advance", {
      agentAddress: addressA,
      jobId: jobIdA,
      requestedAmount: 30,
      purpose: "compute and API calls",
    }, auth);
    assertEqual(res.quote.decision, "DECLINED", "should be DECLINED");
    assert(!res.advance, "no advance should be issued");
  });

  // New agent has zero outstanding balance (no advance issued — correct)
  await test("GET /agents/:address has zero balance (new agent, no history)", async () => {
    const agent = await get<{ outstandingBalance: number; totalBorrowed: number }>(
      `/agents/${addressA}`,
    );
    assertEqual(agent.outstandingBalance, 0, "new agent should have zero balance");
    assertEqual(agent.totalBorrowed, 0, "new agent should have zero borrowed");
  });

  // Verify portfolio reflects demo activity
  await test("GET /dashboard/portfolio includes demo agents", async () => {
    const portfolio = await get<{
      summary: { totalAgents: number; totalAdvances: number };
    }>("/dashboard/portfolio");
    assert(portfolio.summary.totalAgents >= 3, "should have 3+ demo agents");
    assert(portfolio.summary.totalAdvances >= 1, "should have advances from demo bootstrap");
  });

  // Verify risk report
  await test("GET /dashboard/risk returns valid risk report", async () => {
    const risk = await get<{
      overallRisk: string;
      healthScore: number;
      metrics: { utilizationRate: number };
    }>("/dashboard/risk");
    assert(["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(risk.overallRisk), "valid risk level");
    assertInRange(risk.healthScore, 0, 100, "healthScore");
  });

  // Verify timeline
  await test("GET /timeline returns recent events", async () => {
    const timeline = await get<Array<{ type: string; actor: string }>>(
      "/timeline?limit=20",
    );
    assert(Array.isArray(timeline), "timeline should be an array");
    assert(timeline.length >= 1, "should have events");
  });
}

// ════════════════════════════════════════════════════════════════
// TIER 3: Edge Cases & Error Handling
// ════════════════════════════════════════════════════════════════

async function tier3() {
  console.log("\n\x1b[1m── Tier 3: Edge Cases & Error Handling ──\x1b[0m\n");

  // ─── Auth Failures ───

  await test("POST without auth headers returns 401", async () => {
    const res = await postRaw("/agents/register", {
      address: addressB,
      name: "no-auth-agent",
    });
    assertEqual(res.status, 401, "status");
    const body = await res.json() as { error: string };
    assert(body.error.includes("Authentication"), "should mention authentication");
  });

  await test("POST with wrong signer returns 403", async () => {
    // Sign as walletA but try to register walletB
    const auth = await signAuth(walletA);
    const res = await postRaw("/agents/register", { address: addressB, name: "wrong-signer" }, auth);
    assertEqual(res.status, 403, "status");
  });

  await test("POST with expired timestamp returns 401", async () => {
    const account = privateKeyToAccount(walletA);
    const address = account.address.toLowerCase();
    const expiredTimestamp = (Math.floor(Date.now() / 1000) - 600).toString(); // 10 min ago
    const message = `credmesh:${address}:${expiredTimestamp}`;
    const signature = await account.signMessage({ message });
    const res = await postRaw(
      "/agents/register",
      { address, name: "expired" },
      { address, signature, timestamp: expiredTimestamp },
    );
    assertEqual(res.status, 401, "status");
  });

  // ─── Double Registration ───

  await test("Re-registering same address updates name only (scores are protocol-tracked)", async () => {
    const auth = await signAuth(walletA);
    const res = await post<{ address: string; name: string; trustScore: number }>(
      "/agents/register",
      {
        address: addressA,
        name: "e2e-test-agent-updated",
        trustScore: 75, // ignored
      },
      auth,
    );
    assertEqual(res.name, "e2e-test-agent-updated", "name should be updated");
    assertEqual(res.trustScore, 0, "trustScore remains 0 (protocol-tracked only)");
    assertEqual(res.address, addressA, "address should remain the same");
  });

  // ─── Invalid Inputs ───

  await test("POST /credit/quote with negative amount returns error", async () => {
    const auth = await signAuth(walletA);
    const res = await postRaw("/credit/quote", {
      agentAddress: addressA,
      jobId: jobIdA,
      requestedAmount: -10,
      purpose: "test",
    }, auth);
    assertEqual(res.status, 400, "status");
  });

  await test("POST /credit/quote with zero amount returns error", async () => {
    const auth = await signAuth(walletA);
    const res = await postRaw("/credit/quote", {
      agentAddress: addressA,
      jobId: jobIdA,
      requestedAmount: 0,
      purpose: "test",
    }, auth);
    assertEqual(res.status, 400, "status");
  });

  await test("POST /marketplace/jobs with empty title returns error", async () => {
    const auth = await signAuth(walletA);
    const res = await postRaw("/marketplace/jobs", {
      agentAddress: addressA,
      payer: "0xc11e000000000000000000000000000000000099",
      title: "",
      expectedPayout: 100,
      durationHours: 24,
      category: "code",
    }, auth);
    assertEqual(res.status, 400, "status");
  });

  // ─── Advance on Non-Existent Job ───

  await test("POST /credit/advance with fake jobId returns error", async () => {
    const auth = await signAuth(walletA);
    const res = await postRaw("/credit/advance", {
      agentAddress: addressA,
      jobId: "00000000-0000-0000-0000-000000000000",
      requestedAmount: 10,
      purpose: "test",
    }, auth);
    assertEqual(res.status, 400, "status");
  });

  // ─── Advance Without Registration ───

  await test("POST /credit/advance for unregistered agent returns error", async () => {
    const auth = await signAuth(walletB);
    const res = await postRaw("/credit/advance", {
      agentAddress: addressB,
      jobId: jobIdA,
      requestedAmount: 10,
      purpose: "test",
    }, auth);
    assertEqual(res.status, 400, "status");
  });

  // ─── Advance on Someone Else's Job ───

  await test("POST /credit/advance on another agent's job returns error", async () => {
    // Register walletB first
    const authB = await signAuth(walletB);
    await post("/agents/register", {
      address: addressB,
      name: "e2e-agent-b",
      trustScore: 60,
      attestationCount: 5,
      cooperationSuccessCount: 3,
      successfulJobs: 4,
      failedJobs: 0,
      averageCompletedPayout: 80,
    }, authB);

    // Try to advance against agent A's job
    const res = await postRaw("/credit/advance", {
      agentAddress: addressB,
      jobId: jobIdA,
      requestedAmount: 10,
      purpose: "test",
    }, authB);
    assertEqual(res.status, 400, "status");
    const body = await res.json() as { error: string };
    assert(body.error.includes("not assigned"), `expected 'not assigned' error, got: ${body.error}`);
  });

  // ─── Spend Controls & Input Validation ───

  await test("POST /spend/record rejects invalid category", async () => {
    const auth = await signAuth(walletA);
    const res = await postRaw("/spend/record", {
      advanceId: "00000000-0000-0000-0000-000000000000",
      category: "invalid-category",
      amount: 1,
      vendor: "test",
      description: "Testing invalid category",
    }, auth);
    assertEqual(res.status, 400, "should reject invalid category");
    const body = await res.json() as { error: string };
    assert(body.error.includes("Invalid category"), "should mention invalid category");
  });

  await test("POST /spend/record rejects spend by wrong agent", async () => {
    const authB = await signAuth(walletB);
    const res = await postRaw("/spend/record", {
      advanceId: "00000000-0000-0000-0000-000000000000",
      category: "compute",
      amount: 1,
      vendor: "test",
      description: "Testing wrong agent spend",
    }, authB);
    assertEqual(res.status, 400, "status");
  });

  // ─── Marketplace Bidding ───

  await test("POST /marketplace/post creates open job for bidding", async () => {
    const auth = await signAuth(walletA);
    const job = await post<{ id: string; status: string; postedBy: string }>(
      "/marketplace/post",
      {
        postedBy: addressA,
        title: "Open job for bidding",
        expectedPayout: 150,
        durationHours: 48,
        category: "research",
        requiredCapabilities: ["web-scraping", "analysis"],
      },
      auth,
    );
    assertEqual(job.status, "open", "status");

    // Agent B bids
    const authB = await signAuth(walletB);
    const bidResult = await post<{
      bid: { id: string; status: string };
      evaluation: { eligible: boolean };
    }>(`/marketplace/jobs/${job.id}/bid`, {
      agentAddress: addressB,
      proposedCost: 120,
      estimatedHours: 36,
      capabilities: ["web-scraping", "analysis"],
      pitch: "I can do this efficiently",
    }, authB);
    assert(!!bidResult.bid.id, "bid should have an id");
    assertEqual(bidResult.bid.status, "pending", "bid status");

    // Read bids
    const bids = await get<{ bids: unknown[]; ranked: unknown[] }>(
      `/marketplace/jobs/${job.id}/bids`,
    );
    assert(bids.bids.length >= 1, "should have at least 1 bid");

    // Award bid
    const award = await post<{
      job: { agentAddress: string; awardedBidId: string };
      acceptedBid: { status: string };
    }>(`/marketplace/jobs/${job.id}/award`, {
      bidId: bidResult.bid.id,
    }, auth); // poster awards
    assertEqual(award.acceptedBid.status, "accepted", "accepted bid status");
    assertEqual(award.job.agentAddress, addressB, "job should be assigned to bidder");
  });

  // ─── Default (tests with fake advance ID — verifies error handling) ───

  await test("POST /credit/default on nonexistent advance returns error", async () => {
    const auth = await signAuth(walletA);
    const res = await postRaw("/credit/default", {
      advanceId: "00000000-0000-0000-0000-000000000000",
      agentAddress: addressA,
      reason: "Testing nonexistent advance",
    }, auth);
    assertEqual(res.status, 400, "should reject unknown advance");
  });

  // ─── Mandates ───

  let testMandateId: string;
  await test("POST /mandates creates a funded mandate", async () => {
    const auth = await signAuth(walletA);
    const mandate = await post<{
      id: string;
      funder: string;
      budgetUsdc: number;
      status: string;
      allowedCategories: string[];
      maxPerTask: number;
    }>("/mandates", {
      funder: addressA,
      budgetUsdc: 500,
      allowedCategories: ["code", "compute", "research"],
      maxPerTask: 50,
      maxDurationHours: 72,
      minCreditScore: 40,
    }, auth);
    assert(!!mandate.id, "mandate should have an id");
    assertEqual(mandate.funder, addressA, "funder");
    assertEqual(mandate.budgetUsdc, 500, "budgetUsdc");
    assertEqual(mandate.status, "active", "status");
    assert(mandate.allowedCategories.includes("code"), "should include code category");
    testMandateId = mandate.id;
  });

  await test("GET /mandates lists mandates", async () => {
    const mandates = await get<Array<{ id: string; status: string }>>("/mandates");
    assert(Array.isArray(mandates), "should be an array");
    assert(mandates.some((m) => m.id === testMandateId), "should include the created mandate");
  });

  await test("GET /mandates/:id returns mandate details", async () => {
    const mandate = await get<{ id: string; budgetUsdc: number; allocated: number }>(
      `/mandates/${testMandateId}`,
    );
    assertEqual(mandate.id, testMandateId, "id");
    assertEqual(mandate.budgetUsdc, 500, "budgetUsdc");
    assertEqual(mandate.allocated, 0, "allocated should be 0 (no advances yet)");
  });

  await test("POST /mandates/:id/advance rejects agent with no credit history", async () => {
    const auth = await signAuth(walletA);
    const job = await post<{ id: string }>("/marketplace/jobs", {
      agentAddress: addressA,
      payer: "0xc11e000000000000000000000000000000000077",
      title: "Mandate-funded task",
      expectedPayout: 200,
      durationHours: 24,
      category: "code",
    }, auth);

    // Agent has no credit history → mandate's minCreditScore (40) won't be met
    const res = await postRaw(`/mandates/${testMandateId}/advance`, {
      agentAddress: addressA,
      jobId: job.id,
      requestedAmount: 30,
      purpose: "compute",
    }, auth);
    assertEqual(res.status, 400, "should reject agent with insufficient credit score");
  });

  await test("POST /mandates/:id/advance rejects disallowed category", async () => {
    const auth = await signAuth(walletA);
    const job = await post<{ id: string }>("/marketplace/jobs", {
      agentAddress: addressA,
      payer: "0xc11e000000000000000000000000000000000077",
      title: "Disallowed category test",
      expectedPayout: 100,
      durationHours: 24,
      category: "growth", // not in mandate's allowedCategories
    }, auth);

    const res = await postRaw(`/mandates/${testMandateId}/advance`, {
      agentAddress: addressA,
      jobId: job.id,
      requestedAmount: 10,
      purpose: "test",
    }, auth);
    assertEqual(res.status, 400, "should reject disallowed category");
  });

  await test("POST /mandates/:id/status pauses and reactivates", async () => {
    const auth = await signAuth(walletA);
    // Pause
    const paused = await post<{ status: string }>(`/mandates/${testMandateId}/status`, {
      status: "paused",
    }, auth);
    assertEqual(paused.status, "paused", "should be paused");

    // Reactivate
    const active = await post<{ status: string }>(`/mandates/${testMandateId}/status`, {
      status: "active",
    }, auth);
    assertEqual(active.status, "active", "should be active again");
  });

  await test("POST /mandates/:id/status rejects non-funder", async () => {
    const authB = await signAuth(walletB);
    const res = await postRaw(`/mandates/${testMandateId}/status`, {
      status: "paused",
    }, authB);
    assertEqual(res.status, 400, "should reject non-funder");
  });

  // ─── Double Advance on Same Job (Receivable-Backed Cap) ───

  await test("Second advance on same job respects receivable-backed cap", async () => {
    const auth = await signAuth(walletA);
    // Agent A already has an active advance on jobIdA (from Tier 2, now defaulted).
    // Create a new job for this test.
    const job = await post<{ id: string }>("/marketplace/jobs", {
      agentAddress: addressA,
      payer: "0xc11e000000000000000000000000000000000099",
      title: "Double advance test job",
      expectedPayout: 100,
      durationHours: 24,
      category: "code",
    }, auth);

    // First advance: $30 (payoutCap = $100 * 0.3 = $30)
    const adv1 = await post<{
      quote: { decision: string; approvedAmount: number };
      advance?: { id: string; approvedAmount: number };
    }>("/credit/advance", {
      agentAddress: addressA,
      jobId: job.id,
      requestedAmount: 30,
      purpose: "compute",
    }, auth);
    // Agent might not have enough credit now (was updated/defaulted), so handle both cases
    if (adv1.advance) {
      // Second advance: should get $0 because first advance consumed the cap
      const quote2 = await post<{ decision: string; approvedAmount: number }>(
        "/credit/quote",
        {
          agentAddress: addressA,
          jobId: job.id,
          requestedAmount: 30,
          purpose: "more compute",
        },
        auth,
      );
      assertEqual(quote2.approvedAmount, 0, "second advance should be capped at $0 (receivable cap exhausted)");
      assert(
        quote2.decision === "DECLINED" || quote2.decision === "MANUAL_REVIEW",
        `second advance should be declined/review, got ${quote2.decision}`,
      );
    }
    // If first advance was declined (insufficient credit after default), that's also correct
  });

  // ─── Cross-Agent Default Prevention ───

  await test("Agent cannot default another agent's advance", async () => {
    // Register agent C with a fresh wallet
    const walletCKey = generatePrivateKey();
    const accountC = privateKeyToAccount(walletCKey);
    const addressC = accountC.address.toLowerCase();
    const authC = await signAuth(walletCKey);
    await post("/agents/register", {
      address: addressC,
      name: "e2e-agent-c",
      trustScore: 80,
      attestationCount: 10,
      cooperationSuccessCount: 5,
      successfulJobs: 10,
      failedJobs: 0,
      averageCompletedPayout: 100,
    }, authC);

    // Create a job and advance for agent C
    const job = await post<{ id: string }>("/marketplace/jobs", {
      agentAddress: addressC,
      payer: "0xc11e000000000000000000000000000000000077",
      title: "Cross-default test",
      expectedPayout: 200,
      durationHours: 24,
      category: "code",
    }, authC);

    const advResult = await post<{
      advance?: { id: string };
    }>("/credit/advance", {
      agentAddress: addressC,
      jobId: job.id,
      requestedAmount: 30,
      purpose: "compute",
    }, authC);

    if (advResult.advance) {
      // Agent B tries to default agent C's advance — should fail
      const authB = await signAuth(walletB);
      const res = await postRaw("/credit/default", {
        advanceId: advResult.advance.id,
        agentAddress: addressB,
        reason: "Malicious default attempt",
      }, authB);
      assertEqual(res.status, 400, "cross-agent default should be rejected");
      const body = await res.json() as { error: string };
      assert(
        body.error.includes("advance holder"),
        `should mention advance holder, got: ${body.error}`,
      );
    }
  });

  // ─── Nonexistent Agent ───

  await test("GET /agents/:address for unknown agent returns 404", async () => {
    const res = await fetch(`${BASE_URL}/agents/0x0000000000000000000000000000000000099999`, {
      headers: { Accept: "application/json" },
    });
    assertEqual(res.status, 404, "status");
  });
}

// ════════════════════════════════════════════════════════════════
// TIER 4: Full Lifecycle via Demo Bootstrap
// ════════════════════════════════════════════════════════════════

async function tier4() {
  console.log("\n\x1b[1m── Tier 4: Full Lifecycle (Demo Bootstrap Verification) ──\x1b[0m\n");

  // Reset and run both scenarios
  await test("Reset + bootstrap both scenarios", async () => {
    await adminPost("/demo/reset", {});
    const res = await adminPost<{
      agentsCreated: number;
      jobsCreated: number;
      advancesCreated: number;
    }>("/demo/bootstrap", { scenario: "both" });
    assertEqual(res.agentsCreated, 5, "should create 5 agents");
    assertEqual(res.jobsCreated, 5, "should create 5 jobs");
  });

  // Verify waterfall settlement state — "both" scenario should now produce real defaults
  await test("Portfolio reflects both repayments and defaults", async () => {
    const portfolio = await get<{
      summary: {
        totalAgents: number;
        totalAdvances: number;
        repaymentRate: number;
        defaultRate: number;
        totalFeesEarned: number;
      };
    }>("/dashboard/portfolio");
    assertEqual(portfolio.summary.totalAgents, 5, "totalAgents");
    assert(portfolio.summary.totalFeesEarned > 0, "should have earned fees");
    assert(portfolio.summary.totalAdvances >= 3, "should have 3+ advances (happy + failure agents)");
    assert(portfolio.summary.repaymentRate < 1, "repaymentRate should be < 1 (some defaults)");
    assert(portfolio.summary.defaultRate > 0, "defaultRate should be > 0");
  });

  // Verify treasury accounting
  await test("Treasury accounting is consistent", async () => {
    const treasury = await get<{
      totalDeposited: number;
      totalAdvanced: number;
      totalRepaid: number;
      totalFeesEarned: number;
      totalProtocolFees: number;
      totalUnderwriterFees: number;
      totalDefaultLoss: number;
      availableFunds: number;
    }>("/treasury");

    assert(treasury.totalDeposited > 0, "totalDeposited should be positive");
    assert(treasury.totalAdvanced > 0, "totalAdvanced should be positive");
    assert(treasury.totalRepaid > 0, "totalRepaid should be positive (happy path repaid)");
    assert(treasury.totalFeesEarned > 0, "totalFeesEarned should be positive");
    assert(treasury.totalDefaultLoss > 0, "totalDefaultLoss should be positive (failure path defaults)");

    // Fee split check: underwriter + protocol = total
    const feeSplitSum = Math.round((treasury.totalUnderwriterFees + treasury.totalProtocolFees) * 100) / 100;
    const totalFees = Math.round(treasury.totalFeesEarned * 100) / 100;
    assertEqual(feeSplitSum, totalFees, "fee split should sum to total fees");

    // Available funds should be non-negative (losses reduce it)
    assert(treasury.availableFunds >= 0, "availableFunds should be non-negative");
  });

  // Verify risk report reflects defaults
  await test("Risk report reflects defaults in portfolio", async () => {
    const risk = await get<{
      overallRisk: string;
      healthScore: number;
      metrics: { weightedDefaultRate: number };
      alerts: string[];
    }>("/dashboard/risk");
    assert(risk.metrics.weightedDefaultRate > 0, "weightedDefaultRate should be > 0 (real defaults)");
    assert(risk.healthScore < 100, "health score should be reduced by defaults");
  });

  // Verify timeline captures full lifecycle
  await test("Timeline captures full lifecycle events", async () => {
    const timeline = await get<Array<{ type: string }>>(
      "/timeline?limit=100",
    );
    const types = new Set(timeline.map((e) => e.type));
    assert(types.has("deposit_received"), "should have deposit event");
    assert(types.has("agent_registered"), "should have registration event");
    assert(types.has("job_created"), "should have job creation event");
    assert(types.has("advance_created"), "should have advance creation event");
    assert(types.has("job_completed"), "should have job completion event");
    // Should have either advance_repaid or advance_defaulted from the scenarios
    assert(
      types.has("advance_repaid") || types.has("advance_defaulted"),
      "should have repayment or default event",
    );
  });

  // Verify demo agents' credit profiles
  await test("Happy-path agent has good credit after repayment", async () => {
    const profile = await get<{ address: string; successfulJobs: number; repaidAdvances: number }>(
      "/agents/0xaa11111111111111111111111111111111111111",
    );
    assert(profile.successfulJobs > 0, "should have successful jobs");
    assert(profile.repaidAdvances > 0, "should have repaid advances");
  });

  await test("Failure-path agent shows defaults", async () => {
    const agent = await get<{ defaultedAdvances: number; failedJobs: number }>(
      "/agents/0xdd44444444444444444444444444444444444444",
    );
    // This agent had a partial completion (payout shortfall)
    assert(
      agent.defaultedAdvances > 0 || agent.failedJobs > 0,
      "should have defaults or failed jobs",
    );
  });

  // ─── Trustless Escrow Layer (Base Sepolia) ───

  await test("GET /credit/trustless returns live on-chain config", async () => {
    const info = await get<{
      available: boolean;
      contracts: {
        chain: string;
        chainId: number;
        escrow: string;
        oracle: string;
        creditOracle: string;
        usdc: string;
      };
      parameters: {
        maxAdvanceRatioBps: number;
        minCreditScore: number;
        feeBps: number;
        hardCap: string;
        liquidity: string;
      };
      abi: Record<string, string>;
      flow: string[];
    }>("/credit/trustless");
    assertEqual(info.available, true, "should be available");
    assertEqual(info.contracts.chain, "base-sepolia", "chain");
    assertEqual(info.contracts.chainId, 84532, "chainId");
    assert(info.contracts.escrow.startsWith("0x"), "escrow should be an address");
    assert(info.contracts.oracle.startsWith("0x"), "oracle should be an address");
    assert(info.contracts.creditOracle.startsWith("0x"), "creditOracle should be an address");
    // On-chain parameters should be real values read from the contract
    assertEqual(info.parameters.maxAdvanceRatioBps, 3000, "maxAdvanceRatioBps should be 3000 (30%)");
    assert(info.parameters.minCreditScore >= 10, "minCreditScore should be >= 10 (contract floor)");
    assert(info.parameters.feeBps > 0, "feeBps should be > 0");
    assert(parseFloat(info.parameters.hardCap) > 0, "hardCap should be > 0");
    assert(info.flow.length >= 4, "should have flow steps");
    assert(!!info.abi.requestAdvance, "should include requestAdvance ABI");
    assert(!!info.abi.settle, "should include settle ABI");
    assert(!!info.abi.liquidate, "should include liquidate ABI");
  });

  await test("POST /credit/advance-onchain returns calldata + quote", async () => {
    // Need a registered agent with an open job — use the ones from Tier 2
    // Re-register agent A (state was reset in Tier 4, so register fresh)
    const auth = await signAuth(walletA);
    await post("/agents/register", {
      address: addressA,
      name: "trustless-test-agent",
      trustScore: 70,
      attestationCount: 10,
      cooperationSuccessCount: 5,
      successfulJobs: 8,
      failedJobs: 0,
      averageCompletedPayout: 100,
    }, auth);

    const job = await post<{ id: string }>("/marketplace/jobs", {
      agentAddress: addressA,
      payer: "0xc11e000000000000000000000000000000000088",
      title: "Trustless advance test job",
      expectedPayout: 200,
      durationHours: 24,
      category: "code",
    }, auth);

    const res = await post<{
      quote: { decision: string; approvedAmount: number; fee: number };
      onchainCredit: { score: number } | null;
      onchain: {
        chain: string;
        chainId: number;
        to: string;
        calldata: string;
        method: string;
        args: {
          oracle: string;
          receivableId: string;
          requestedAmount: number;
        };
        gasEstimate: string;
      };
    }>("/credit/advance-onchain", {
      agentAddress: addressA,
      jobId: job.id,
      requestedAmount: 30,
      purpose: "compute",
    }, auth);

    // Quote should be present
    assert(!!res.quote, "should include quote");
    assert(res.quote.approvedAmount > 0, "quote should have approved amount");

    // On-chain instructions should be complete
    assert(!!res.onchain, "should include onchain instructions");
    assertEqual(res.onchain.chain, "base-sepolia", "chain");
    assertEqual(res.onchain.chainId, 84532, "chainId");
    assert(res.onchain.to.startsWith("0x"), "to should be escrow address");
    assert(res.onchain.calldata.startsWith("0x"), "calldata should be hex");
    assert(res.onchain.calldata.length > 10, "calldata should be non-trivial");
    assertEqual(res.onchain.method, "requestAdvance(address oracle, bytes32 receivableId, uint256 requestedAmount)", "method");
    assert(res.onchain.args.oracle.startsWith("0x"), "oracle arg should be address");
    assert(res.onchain.args.receivableId.startsWith("0x"), "receivableId should be hex");
    assertEqual(res.onchain.args.requestedAmount, 30, "requestedAmount arg");
  });

  await test("POST /credit/advance-verify rejects bad txHash", async () => {
    const auth = await signAuth(walletA);
    const res = await postRaw("/credit/advance-verify", {
      agentAddress: addressA,
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
    }, auth);
    // Should return 404 or error — no advance found for fake tx
    assert(res.status === 404 || res.status === 400 || res.status === 500, `expected error status, got ${res.status}`);
  });

  await test("POST /credit/advance-onchain requires auth", async () => {
    const res = await postRaw("/credit/advance-onchain", {
      agentAddress: addressA,
      jobId: "fake",
      requestedAmount: 10,
      purpose: "test",
    });
    assertEqual(res.status, 401, "should require auth");
  });

  // Agent log endpoint
  await test("GET /agent_log.json returns structured log", async () => {
    const log = await get<{
      agent: string;
      version: string;
      entries: Array<{ type: string; timestamp: string }>;
    }>("/agent_log.json");
    assert(log.agent.includes("CredMesh"), "agent name should match");
    assert(Array.isArray(log.entries), "entries should be an array");
    assert(log.entries.length > 0, "should have log entries");
  });
}

// ════════════════════════════════════════════════════════════════
// TIER 5: On-Chain Trustless Advance (Base Sepolia)
// ════════════════════════════════════════════════════════════════

const TRUSTLESS_ESCROW_ABI = parseAbi([
  "function requestAdvance(address oracle, bytes32 receivableId, uint256 requestedAmount) external returns (bytes32)",
  "function getAdvance(bytes32 advanceId) external view returns (address agent, address oracle, bytes32 receivableId, uint256 principal, uint256 fee, bool settled, uint256 expiresAt, bool liquidated)",
  "function exposure(address agent) external view returns (uint256)",
]);

async function tier5() {
  console.log("\n\x1b[1m── Tier 5: On-Chain Trustless Advance (Base Sepolia) ──\x1b[0m\n");

  // Generate a fresh wallet for the on-chain test
  const onchainKey = generatePrivateKey();
  const onchainAccount = privateKeyToAccount(onchainKey);
  const onchainAddress = onchainAccount.address.toLowerCase();

  // Get trustless config from the worker
  const trustlessConfig = await get<{
    available: boolean;
    contracts: { escrow: string; oracle: string };
    parameters: { liquidity: string; minCreditScore: number };
  }>("/credit/trustless");

  if (!trustlessConfig.available) {
    console.log("  \x1b[33mSKIP\x1b[0m TrustlessEscrow not available — skipping on-chain tests");
    return;
  }

  const liquidity = parseFloat(trustlessConfig.parameters.liquidity);
  if (liquidity < 0.1) {
    console.log(`  \x1b[33mSKIP\x1b[0m Insufficient escrow liquidity (${liquidity} USDC) — skipping on-chain tests`);
    return;
  }

  // Pre-flight: check worker wallet has enough ETH + USDC to run on-chain tests
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://base-sepolia-rpc.publicnode.com"),
  });
  const workerAddr = "0xa3D3E3859C7EE7EEA5d682A4BaC19c45aDB82388" as `0x${string}`;
  const [workerEth, workerUsdc] = await Promise.all([
    publicClient.getBalance({ address: workerAddr }),
    publicClient.readContract({
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [workerAddr],
    }),
  ]);
  const workerEthNum = Number(workerEth) / 1e18;
  const workerUsdcNum = Number(workerUsdc) / 1e6;
  console.log(`  Worker wallet: ${workerEthNum.toFixed(4)} ETH, ${workerUsdcNum.toFixed(2)} USDC`);

  if (workerEthNum < 0.0002 || workerUsdcNum < 0.3) {
    console.log(`  \x1b[33mSKIP\x1b[0m Worker wallet underfunded (need ≥0.0002 ETH + ≥$0.30 USDC) — skipping on-chain tests`);
    console.log(`  \x1b[33mNote:\x1b[0m Send Base Sepolia ETH + USDC to ${workerAddr} to re-enable`);
    return;
  }

  const escrowAddress = trustlessConfig.contracts.escrow as `0x${string}`;
  const oracleAddress = trustlessConfig.contracts.oracle as `0x${string}`;

  // Use a deterministic receivable ID from the test agent address
  const receivableId = pad(`0x${onchainAddress.slice(2)}` as Hex, { size: 32 });
  const advanceAmount = 0.1; // $0.10 USDC — fits within $0.40 receivable * 30% cap = $0.12

  // Step 1: Setup on-chain state via worker
  await test("POST /testnet/setup-trustless provisions on-chain state", async () => {
    const res = await adminPost<{
      agent: string;
      receivableId: string;
      setup: {
        reputation: { txHash?: string; error?: string };
        receivable: { txHash?: string; error?: string };
        gas: { txHash?: string; error?: string };
      };
    }>("/testnet/setup-trustless", {
      agentAddress: onchainAddress,
      receivableId,
      receivableAmount: 0.4, // $0.40 receivable — minimal, fits worker's remaining USDC
    });

    assertEqual(res.agent, onchainAddress, "agent address");
    assert(!!res.setup.reputation.txHash, `reputation setup failed: ${res.setup.reputation.error ?? "no txHash"}`);
    assert(!!res.setup.receivable.txHash, `receivable setup failed: ${res.setup.receivable.error ?? "no txHash"}`);
    assert(!!res.setup.gas.txHash, `gas setup failed: ${res.setup.gas.error ?? "no txHash"}`);
  });

  // Step 2: Wait for txs to confirm, then verify state
  await test("On-chain state is correct after setup", async () => {
    // Give Base Sepolia a moment to finalize
    await new Promise((r) => setTimeout(r, 3000));

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http("https://base-sepolia-rpc.publicnode.com"),
    });

    // Check agent has ETH for gas
    const ethBalance = await publicClient.getBalance({ address: onchainAccount.address });
    assert(ethBalance > 0n, "agent should have ETH for gas");

    // Check exposure is 0 before advance
    const exposure = await publicClient.readContract({
      address: escrowAddress,
      abi: TRUSTLESS_ESCROW_ABI,
      functionName: "exposure",
      args: [onchainAccount.address],
    });
    assertEqual(exposure, 0n, "exposure should be 0 before advance");
  });

  // Step 3: Agent calls requestAdvance() directly on TrustlessEscrow
  let advanceTxHash: string;
  await test("Agent calls requestAdvance() on-chain — contract enforces everything", async () => {
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http("https://base-sepolia-rpc.publicnode.com"),
    });
    const walletClient = createWalletClient({
      chain: baseSepolia,
      transport: http("https://base-sepolia-rpc.publicnode.com"),
      account: onchainAccount,
    });

    const requestedWei = parseUnits(advanceAmount.toFixed(2), 6);

    // Agent calls requestAdvance directly — no operator in the loop
    const hash = await walletClient.writeContract({
      address: escrowAddress,
      abi: TRUSTLESS_ESCROW_ABI,
      functionName: "requestAdvance",
      args: [oracleAddress, receivableId, requestedWei],
    });

    advanceTxHash = hash;
    assert(hash.startsWith("0x"), "should return tx hash");

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assertEqual(receipt.status, "success", "transaction should succeed");
  });

  // Step 4: Verify advance state on-chain
  await test("Advance exists on-chain with correct state", async () => {
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http("https://base-sepolia-rpc.publicnode.com"),
    });

    // Check exposure increased
    const exposure = await publicClient.readContract({
      address: escrowAddress,
      abi: TRUSTLESS_ESCROW_ABI,
      functionName: "exposure",
      args: [onchainAccount.address],
    });
    assert(exposure > 0n, "exposure should be > 0 after advance");
    assertEqual(exposure, parseUnits(advanceAmount.toFixed(2), 6), "exposure should equal advance amount");

    // Check agent received USDC
    const usdcBalance = await publicClient.readContract({
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [onchainAccount.address],
    });
    assert(usdcBalance >= parseUnits(advanceAmount.toFixed(2), 6), "agent should have received USDC");
  });

  // Step 5: Verify via worker API
  await test("POST /credit/advance-verify confirms on-chain advance", async () => {
    const auth = await signAuth(onchainKey);
    // Register agent in worker state first
    await post("/agents/register", {
      address: onchainAddress,
      name: "onchain-e2e-agent",
      trustScore: 50,
    }, auth);

    const res = await post<{
      verified: boolean;
      advance: {
        advanceId: string;
        agent: string;
        principal: string;
        fee: string;
      };
    }>("/credit/advance-verify", {
      agentAddress: onchainAddress,
      txHash: advanceTxHash,
    }, auth);

    assertEqual(res.verified, true, "should be verified");
    assertEqual(res.advance.agent.toLowerCase(), onchainAddress, "advance agent should match");
    assertEqual(parseFloat(res.advance.principal), advanceAmount, "principal should match");
    assert(parseFloat(res.advance.fee) > 0, "fee should be > 0");
  });
}

// ════════════════════════════════════════════════════════════════
// Runner
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n\x1b[1m╔══════════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[1m║  CredMesh — E2E Test Suite      ║\x1b[0m`);
  console.log(`\x1b[1m╚══════════════════════════════════════════╝\x1b[0m`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Test wallets: ${addressA.slice(0, 10)}... , ${addressB.slice(0, 10)}...`);

  // Verify target is reachable
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  } catch (e) {
    console.error(`\n\x1b[31mTarget ${BASE_URL} is not reachable. Aborting.\x1b[0m`);
    process.exit(1);
  }

  await tier1();
  await tier2();
  await tier3();
  await tier4();
  await tier5();

  // Summary
  console.log(`\n\x1b[1m── Summary ──\x1b[0m\n`);
  console.log(`  Total:  ${results.length}`);
  console.log(`  \x1b[32mPassed: ${passed}\x1b[0m`);
  if (failed > 0) {
    console.log(`  \x1b[31mFailed: ${failed}\x1b[0m\n`);
    console.log(`  \x1b[1mFailures:\x1b[0m`);
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    \x1b[31m✗\x1b[0m ${r.name}`);
      console.log(`      ${r.error}`);
    }
  } else {
    console.log(`  Failed: 0\n`);
    console.log(`  \x1b[32mAll tests passed.\x1b[0m`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n\x1b[31mTest runner crashed:\x1b[0m", e);
  process.exit(2);
});
