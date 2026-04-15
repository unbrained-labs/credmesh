#!/usr/bin/env node
/**
 * CredMesh — MCP Server
 *
 * Makes CredMesh's credit infrastructure discoverable and callable
 * by any MCP-compatible AI agent (Claude, GPT, Claw agents, etc.)
 *
 * Run: npx credmesh-mcp
 * Or:  node dist/index.js
 *
 * Environment:
 *   CREDMESH_URL — base URL (default: https://credmesh.xyz)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.CREDMESH_URL ?? process.env.TRUSTVAULT_URL ?? "https://credmesh.xyz";

// ─── HTTP Client ───

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(
  path: string,
  body: unknown,
  auth?: { address: string; signature: string; timestamp: string },
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    headers["X-Agent-Address"] = auth.address;
    headers["X-Agent-Signature"] = auth.signature;
    headers["X-Agent-Timestamp"] = auth.timestamp;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

// ─── Server ───

const server = new McpServer({
  name: "credmesh",
  version: "0.1.0",
});

// ─── Tools ───

server.tool(
  "check_health",
  "Check CredMesh system status, chain connectivity, vault stats, and escrow balance",
  {},
  async () => {
    const health = await apiGet("/health");
    return { content: [{ type: "text", text: JSON.stringify(health, null, 2) }] };
  },
);

server.tool(
  "get_fee_model",
  "Get the current dynamic fee model — utilization rates, example costs for best-case and risky agents, protocol fee split",
  {},
  async () => {
    const fees = await apiGet("/fees");
    return { content: [{ type: "text", text: JSON.stringify(fees, null, 2) }] };
  },
);

server.tool(
  "get_bootstrap_guide",
  "Get the zero-capital bootstrap guide — step-by-step instructions for an agent to start borrowing with no tokens or gas",
  {},
  async () => {
    const guide = await apiGet("/bootstrap");
    return { content: [{ type: "text", text: JSON.stringify(guide, null, 2) }] };
  },
);

server.tool(
  "list_open_jobs",
  "List all open jobs available for bidding in the CredMesh marketplace",
  {},
  async () => {
    const jobs = await apiGet("/marketplace/open");
    return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
  },
);

server.tool(
  "get_vault_opportunity",
  "Get live yield data for liquidity providers — APY, risk metrics, pool stats, deposit instructions for the ERC-4626 vault",
  {},
  async () => {
    const data = await apiGet("/vault/opportunity");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_agent_info",
  "Get a registered agent's record — credit history, reputation, outstanding balance",
  { address: z.string().describe("Ethereum address of the agent (0x...)") },
  async ({ address }) => {
    try {
      const agent = await apiGet(`/agents/${address}`);
      return { content: [{ type: "text", text: JSON.stringify(agent, null, 2) }] };
    } catch {
      return { content: [{ type: "text", text: `Agent ${address} not found.` }], isError: true };
    }
  },
);

server.tool(
  "get_onchain_status",
  "Get an address's on-chain identity (ERC-8004), reputation score, and token balance on Sepolia",
  { address: z.string().describe("Ethereum address to check (0x...)") },
  async ({ address }) => {
    const data = await apiGet(`/onchain/${address}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "register_agent",
  "Register an agent with CredMesh. Requires EIP-191 wallet signature for authentication.",
  {
    address: z.string().describe("Agent's Ethereum address"),
    name: z.string().describe("Agent display name"),
    signature: z.string().describe("EIP-191 signature of 'credmesh:{address}:{timestamp}'"),
    timestamp: z.string().describe("Unix seconds when signature was created (must be within 5 minutes)"),
    trustScore: z.number().optional().describe("Self-reported trust score (0-100)"),
    successfulJobs: z.number().optional().describe("Number of successful jobs completed"),
  },
  async ({ address, name, signature, timestamp, trustScore, successfulJobs }) => {
    const result = await apiPost(
      "/agents/register",
      { address, name, trustScore: trustScore ?? 0, successfulJobs: successfulJobs ?? 0 },
      { address, signature, timestamp },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_credit_profile",
  "Get an agent's computed credit profile — credit score, credit limit, available credit, repayment rate. Requires authentication.",
  {
    agentAddress: z.string().describe("Agent's Ethereum address"),
    signature: z.string().describe("EIP-191 signature"),
    timestamp: z.string().describe("Unix seconds"),
  },
  async ({ agentAddress, signature, timestamp }) => {
    const profile = await apiPost(
      "/credit/profile",
      { agentAddress },
      { address: agentAddress, signature, timestamp },
    );
    return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
  },
);

server.tool(
  "request_credit_quote",
  "Get a fee quote for a credit advance without commitment. Shows decision (APPROVED/DECLINED), approved amount, fee breakdown, and constraints.",
  {
    agentAddress: z.string().describe("Agent's Ethereum address"),
    jobId: z.string().describe("Job receivable ID to borrow against"),
    requestedAmount: z.number().describe("Amount to borrow in USD"),
    purpose: z.string().describe("What the advance will be spent on (compute, gas, sub-agent, etc.)"),
    signature: z.string().describe("EIP-191 signature"),
    timestamp: z.string().describe("Unix seconds"),
  },
  async ({ agentAddress, jobId, requestedAmount, purpose, signature, timestamp }) => {
    const quote = await apiPost(
      "/credit/quote",
      { agentAddress, jobId, requestedAmount, purpose },
      { address: agentAddress, signature, timestamp },
    );
    return { content: [{ type: "text", text: JSON.stringify(quote, null, 2) }] };
  },
);

server.tool(
  "request_advance",
  "Request a credit advance — issues real USDC tokens to the agent via the escrow contract. Requires authentication.",
  {
    agentAddress: z.string().describe("Agent's Ethereum address"),
    jobId: z.string().describe("Job receivable ID"),
    requestedAmount: z.number().describe("Amount to borrow in USD"),
    purpose: z.string().describe("Spend purpose (compute, gas, sub-agent, etc.)"),
    signature: z.string().describe("EIP-191 signature"),
    timestamp: z.string().describe("Unix seconds"),
  },
  async ({ agentAddress, jobId, requestedAmount, purpose, signature, timestamp }) => {
    const result = await apiPost(
      "/credit/advance",
      { agentAddress, jobId, requestedAmount, purpose },
      { address: agentAddress, signature, timestamp },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "request_advance_onchain",
  "Get calldata and instructions for an on-chain trustless advance via TrustlessEscrow on Base Sepolia. The agent calls the contract directly — no operator approval possible. Contract enforces credit score, exposure limits, receivable verification.",
  {
    agentAddress: z.string().describe("Agent's Ethereum address"),
    jobId: z.string().describe("Job receivable ID"),
    requestedAmount: z.number().describe("Amount to borrow in USD"),
    purpose: z.string().describe("Spend purpose"),
    signature: z.string().describe("EIP-191 signature"),
    timestamp: z.string().describe("Unix seconds"),
  },
  async ({ agentAddress, jobId, requestedAmount, purpose, signature, timestamp }) => {
    const result = await apiPost(
      "/credit/advance-onchain",
      { agentAddress, jobId, requestedAmount, purpose },
      { address: agentAddress, signature, timestamp },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "create_job",
  "Create a job receivable in the marketplace — represents future income that can be borrowed against",
  {
    agentAddress: z.string().describe("Agent who will work the job"),
    payer: z.string().describe("Client address who will pay"),
    title: z.string().describe("Job title/description"),
    expectedPayout: z.number().describe("Expected payout in USD"),
    durationHours: z.number().describe("Expected duration in hours"),
    category: z.string().describe("Job category: code, compute, api, research, data, frontend, backend, other"),
    signature: z.string().describe("EIP-191 signature"),
    timestamp: z.string().describe("Unix seconds"),
  },
  async ({ agentAddress, payer, title, expectedPayout, durationHours, category, signature, timestamp }) => {
    const job = await apiPost(
      "/marketplace/jobs",
      { agentAddress, payer, title, expectedPayout, durationHours, category },
      { address: agentAddress, signature, timestamp },
    );
    return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
  },
);

server.tool(
  "submit_bid",
  "Submit a bid on an open marketplace job — includes proposed cost, estimated hours, and capabilities",
  {
    jobId: z.string().describe("Job ID to bid on"),
    agentAddress: z.string().describe("Bidding agent's address"),
    proposedCost: z.number().describe("Proposed cost in USD"),
    estimatedHours: z.number().describe("Estimated hours to complete"),
    capabilities: z.array(z.string()).describe("Agent capabilities relevant to the job"),
    pitch: z.string().describe("Why this agent should be selected"),
    signature: z.string().describe("EIP-191 signature"),
    timestamp: z.string().describe("Unix seconds"),
  },
  async ({ jobId, agentAddress, proposedCost, estimatedHours, capabilities, pitch, signature, timestamp }) => {
    const result = await apiPost(
      `/marketplace/jobs/${jobId}/bid`,
      { agentAddress, proposedCost, estimatedHours, capabilities, pitch },
      { address: agentAddress, signature, timestamp },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_trustless_info",
  "Get TrustlessEscrow contract info on Base Sepolia — addresses, on-chain parameters (advance ratio, min credit score, fee, hard cap), available liquidity, and ABI for direct contract calls",
  {},
  async () => {
    const info = await apiGet("/credit/trustless");
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  },
);

server.tool(
  "get_portfolio",
  "Get the portfolio dashboard — total agents, jobs, advances, exposure, repayment/default rates, top borrowers, exposure by category",
  {},
  async () => {
    const portfolio = await apiGet("/dashboard/portfolio");
    return { content: [{ type: "text", text: JSON.stringify(portfolio, null, 2) }] };
  },
);

server.tool(
  "get_risk_report",
  "Get the risk report — overall risk level, health score, concentration risk, utilization rate, weighted default rate, alerts and recommendations",
  {},
  async () => {
    const risk = await apiGet("/dashboard/risk");
    return { content: [{ type: "text", text: JSON.stringify(risk, null, 2) }] };
  },
);

server.tool(
  "get_treasury",
  "Get treasury state — total deposited, advanced, repaid, fees earned, default losses, available funds",
  {},
  async () => {
    const treasury = await apiGet("/treasury");
    return { content: [{ type: "text", text: JSON.stringify(treasury, null, 2) }] };
  },
);

server.tool(
  "get_chains",
  "List all active chains where CredMesh contracts are deployed, with escrow/vault availability",
  {},
  async () => {
    const chains = await apiGet("/chains");
    return { content: [{ type: "text", text: JSON.stringify(chains, null, 2) }] };
  },
);

// ─── Resources ───

server.resource(
  "skill-guide",
  "credmesh://skill.md",
  { description: "Complete API reference and integration guide for CredMesh", mimeType: "text/markdown" },
  async () => {
    const res = await fetch(`${BASE_URL}/skill.md`);
    const text = res.ok ? await res.text() : "Skill guide not available. See https://credmesh.xyz/bootstrap";
    return { contents: [{ uri: "credmesh://skill.md", text, mimeType: "text/markdown" }] };
  },
);

server.resource(
  "agent-card",
  "credmesh://agent.json",
  { description: "A2A agent card — capabilities, skills, authentication", mimeType: "application/json" },
  async () => {
    const card = await apiGet("/.well-known/agent.json");
    return { contents: [{ uri: "credmesh://agent.json", text: JSON.stringify(card, null, 2), mimeType: "application/json" }] };
  },
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("MCP server error:", e);
  process.exit(1);
});
