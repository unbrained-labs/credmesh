/**
 * Standalone server entry point.
 *
 * Runs the CredMesh Hono app with SQLite persistence on Node.js.
 * Used for: Hetzner, Coolify, Fly.io, Railway, Docker, any Node.js host.
 *
 * Environment variables:
 *   PORT              — HTTP port (default: 3000)
 *   DATA_DIR          — SQLite database directory (default: ./data)
 *   AGENT_NAME        — Display name (default: CredMesh)
 *   ADMIN_SECRET      — Required for demo/reset and testnet-setup endpoints
 *   AGENT_PRIVATE_KEY — Wallet private key for signing chain txs
 *   + all chain config vars (CHAIN_RPC_URL, BASE_SEPOLIA_*, etc.)
 */

import { serve } from "@hono/node-server";
import { SqliteStore } from "./store";
import { CreditAgent } from "./engine";
import type { Env } from "./types";
import { join } from "path";

// ─── Load env ───

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const DATA_DIR = process.env.DATA_DIR ?? "./data";

const env: Env = {
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

// ─── Start server ───

async function main() {
  const { mkdirSync } = await import("fs");
  mkdirSync(DATA_DIR, { recursive: true });

  const Database = (await import("better-sqlite3")).default;
  const dbPath = join(DATA_DIR, "credmesh.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const store = new SqliteStore(db);
  console.log(`SQLite store initialized at ${dbPath}`);

  const agent = new CreditAgent(env, store);

  const { default: app, setAgent } = await import("./index");
  setAgent(agent);

  const wrappedFetch = (req: Request) => app.fetch(req, env);

  const server = serve({ fetch: wrappedFetch, port: PORT }, (info) => {
    console.log(`CredMesh API running on http://localhost:${info.port}`);
    console.log(`Health: http://localhost:${info.port}/health`);
  });

  // Graceful shutdown — Coolify sends SIGTERM then SIGKILL after ~10s. Drain
  // in-flight HTTP requests, checkpoint the WAL, and close the DB handle so
  // prepared statements finalize cleanly.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down…`);
    server.close(() => {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
      } catch (e) {
        console.error("DB shutdown error:", e);
      }
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
