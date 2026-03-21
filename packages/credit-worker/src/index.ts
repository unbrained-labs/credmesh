import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentCard } from "./agent-card";
import { CreditAgent } from "./engine";
import { listScenarios } from "./demo";
import { checkIdentityRegistration } from "./erc8004";
import type { AgentRegistrationInput, Env, SpendCategory } from "./types";

export { CreditAgent };

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// ─── Discovery ───

app.get("/.well-known/agent.json", (c) => c.json(agentCard(c.env)));

app.get("/health", (c) =>
  c.json({
    status: "ok",
    agent: c.env.AGENT_NAME || "TrustVault Credit",
    version: "0.2.0",
    timestamp: Date.now(),
  }),
);

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
  return c.json(await getAgent(c.env).quoteAdvance(body));
});

app.post("/credit/advance", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }>();
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
  return c.json(await getAgent(c.env).deposit(body));
});

app.get("/treasury", async (c) => {
  return c.json(await getAgent(c.env).getTreasury());
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

// ─── Debug ───

app.get("/debug/state", async (c) => {
  return c.json(await getAgent(c.env).getSnapshot());
});

app.onError((error, c) => c.json({ error: error.message }, 400));

function getAgent(env: Env): DurableObjectStub<CreditAgent> {
  const id = env.CREDIT_AGENT.idFromName("trustvault-credit-singleton");
  return env.CREDIT_AGENT.get(id) as DurableObjectStub<CreditAgent>;
}

export default app;
