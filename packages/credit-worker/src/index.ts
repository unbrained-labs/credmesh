import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentCard } from "./agent-card";
import { CreditAgent } from "./engine";
import { checkIdentityRegistration } from "./erc8004";
import type { AgentRegistrationInput, Env } from "./types";

export { CreditAgent };

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/.well-known/agent.json", (c) => c.json(agentCard(c.env)));

app.get("/health", (c) =>
  c.json({
    status: "ok",
    agent: c.env.AGENT_NAME || "TrustVault Credit",
    version: "0.1.0",
    timestamp: Date.now(),
  }),
);

app.post("/agents/register", async (c) => {
  const body = await c.req.json<AgentRegistrationInput>();
  const agent = getAgent(c.env);
  const identityRegistered = await checkIdentityRegistration(c.env, body.address);
  return c.json(await agent.registerAgent({ ...body, identityRegistered }));
});

app.get("/agents/:address", async (c) => {
  const agent = getAgent(c.env);
  const record = await agent.getAgent(c.req.param("address"));
  if (!record) {
    return c.json({ error: "Agent not found." }, 404);
  }
  return c.json(record);
});

app.post("/credit/profile", async (c) => {
  const { agentAddress } = await c.req.json<{ agentAddress: string }>();
  const agent = getAgent(c.env);
  return c.json(await agent.getProfile(agentAddress));
});

app.post("/marketplace/jobs", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    payer: string;
    title: string;
    expectedPayout: number;
    durationHours: number;
    category: string;
  }>();
  const agent = getAgent(c.env);
  return c.json(await agent.createJob(body));
});

app.post("/credit/quote", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }>();
  const agent = getAgent(c.env);
  return c.json(await agent.quoteAdvance(body));
});

app.post("/credit/advance", async (c) => {
  const body = await c.req.json<{
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }>();
  const agent = getAgent(c.env);
  return c.json(await agent.createAdvance(body));
});

app.post("/marketplace/jobs/:jobId/complete", async (c) => {
  const { actualPayout } = await c.req.json<{ actualPayout?: number }>();
  const agent = getAgent(c.env);
  return c.json(await agent.completeJob({ jobId: c.req.param("jobId"), actualPayout }));
});

app.post("/credit/default", async (c) => {
  const body = await c.req.json<{ advanceId: string; reason: string }>();
  const agent = getAgent(c.env);
  return c.json(await agent.defaultAdvance(body));
});

app.get("/debug/state", async (c) => {
  const agent = getAgent(c.env);
  return c.json(await agent.getSnapshot());
});

app.onError((error, c) => c.json({ error: error.message }, 400));

function getAgent(env: Env): DurableObjectStub<CreditAgent> {
  const id = env.CREDIT_AGENT.idFromName("trustvault-credit-singleton");
  return env.CREDIT_AGENT.get(id) as DurableObjectStub<CreditAgent>;
}

export default app;
