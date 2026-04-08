/**
 * Standalone server entry point (non-Cloudflare).
 *
 * Runs the CredMesh Hono app with SQLite persistence instead of Durable Objects.
 * Used for: Coolify, Fly.io, Railway, Docker, any Node.js host.
 *
 * Environment variables (same as wrangler.toml [vars] + secrets):
 *   PORT              — HTTP port (default: 3000)
 *   DATA_DIR          — SQLite database directory (default: ./data)
 *   AGENT_NAME        — Display name (default: CredMesh)
 *   ADMIN_SECRET      — Required for demo/reset and testnet-setup endpoints
 *   AGENT_PRIVATE_KEY — Wallet private key for signing chain txs
 *   + all chain config vars (CHAIN_RPC_URL, BASE_SEPOLIA_*, etc.)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { SqliteStore } from "./store";
import { CreditAgent } from "./engine";
import type { Env } from "./types";
import { join } from "path";

// ─── Load env ───

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const DATA_DIR = process.env.DATA_DIR ?? "./data";

// Build Env from process.env (same shape as CF bindings)
const env: Env = {
  CREDIT_AGENT: null as never, // Not used in standalone mode
  AGENT_NAME: process.env.AGENT_NAME ?? "CredMesh",
  CHAIN_RPC_URL: process.env.CHAIN_RPC_URL,
  IDENTITY_REGISTRY: process.env.IDENTITY_REGISTRY,
  REPUTATION_REGISTRY: process.env.REPUTATION_REGISTRY,
  CHAIN_ID: process.env.CHAIN_ID,
  AGENT_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY,
  TEST_USDC: process.env.TEST_USDC,
  CREDIT_ESCROW: process.env.CREDIT_ESCROW,
  CREDIT_VAULT: process.env.CREDIT_VAULT,
  BASE_SEPOLIA_RPC_URL: process.env.BASE_SEPOLIA_RPC_URL,
  BASE_SEPOLIA_PRIVATE_KEY: process.env.BASE_SEPOLIA_PRIVATE_KEY,
  BASE_SEPOLIA_USDC: process.env.BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_ESCROW: process.env.BASE_SEPOLIA_ESCROW,
  BASE_SEPOLIA_VAULT: process.env.BASE_SEPOLIA_VAULT,
  BASE_SEPOLIA_REPUTATION: process.env.BASE_SEPOLIA_REPUTATION,
  BASE_SEPOLIA_IDENTITY: process.env.BASE_SEPOLIA_IDENTITY,
  BASE_SEPOLIA_ORACLE: process.env.BASE_SEPOLIA_ORACLE,
  BASE_SEPOLIA_CREDIT_ORACLE: process.env.BASE_SEPOLIA_CREDIT_ORACLE,
  BASE_RPC_URL: process.env.BASE_RPC_URL,
  BASE_PRIVATE_KEY: process.env.BASE_PRIVATE_KEY,
  BASE_USDC: process.env.BASE_USDC,
  BASE_ESCROW: process.env.BASE_ESCROW,
  BASE_VAULT: process.env.BASE_VAULT,
  BASE_REPUTATION: process.env.BASE_REPUTATION,
  BASE_IDENTITY: process.env.BASE_IDENTITY,
  TEMPO_ACCOUNT: process.env.TEMPO_ACCOUNT,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL,
  X402_PAY_TO: process.env.X402_PAY_TO,
  X402_NETWORK: process.env.X402_NETWORK,
  ADMIN_SECRET: process.env.ADMIN_SECRET,
};

// ─── Initialize SQLite store + engine ───

let store: SqliteStore;
let agent: CreditAgent;

async function initStore() {
  // Dynamic import for better-sqlite3 (not available at compile time)
  const Database = (await import("better-sqlite3")).default;
  const dbPath = join(DATA_DIR, "credmesh.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // Better concurrent read performance
  store = new SqliteStore(db);
  agent = CreditAgent.createStandalone(env, store);
  console.log(`SQLite store initialized at ${dbPath}`);
}

// ─── Monkey-patch the Hono app to use standalone agent ───
// The existing index.ts exports a Hono app that calls getAgent(env)
// which creates a DO stub. We need to intercept that.
// Simplest approach: re-export the app but override the getAgent binding.

// Import the app (it's the default export from index.ts)
// We can't easily re-use it because getAgent is internal.
// Instead, we'll serve the app as-is but inject the env with a special
// CREDIT_AGENT namespace that returns our standalone agent.

// Create a proxy that mimics the DurableObjectNamespace interface
const agentProxy = {
  idFromName: () => "standalone",
  get: () => {
    // Return a proxy that forwards all method calls to our standalone agent
    return new Proxy(agent, {
      get(target, prop) {
        const val = (target as Record<string | symbol, unknown>)[prop];
        if (typeof val === "function") {
          return val.bind(target);
        }
        return val;
      },
    });
  },
};

// ─── Start server ───

async function main() {
  const { mkdirSync } = await import("fs");
  mkdirSync(DATA_DIR, { recursive: true });

  await initStore();

  // Inject the agent proxy into env
  (env as Record<string, unknown>).CREDIT_AGENT = agentProxy;

  // Import the Hono app
  const { default: app } = await import("./index");

  // Wrap to inject env bindings on every request (Hono on Node.js
  // doesn't have CF's env injection, so we do it manually)
  const wrappedFetch = (req: Request) => {
    return app.fetch(req, env);
  };

  serve({ fetch: wrappedFetch, port: PORT }, (info) => {
    console.log(`CredMesh API running on http://localhost:${info.port}`);
    console.log(`Health: http://localhost:${info.port}/health`);
  });
}

main().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
