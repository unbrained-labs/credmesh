/**
 * Payment rails integration — modular payment methods for TrustVault Credit.
 *
 * Supports:
 * 1. Direct transfer + on-chain tx verification (works now, any EVM chain)
 * 2. MPP (Machine Payments Protocol) via mppx — Stripe + Tempo (crypto + fiat)
 * 3. x402 (Coinbase) — gasless USDC via HTTP 402 (Base only)
 *
 * MPP is the primary rail. It supports both crypto (USDC on Tempo) and
 * fiat (cards/wallets via Stripe SPTs), has Hono middleware, and works
 * on Cloudflare Workers.
 */

/**
 * Supported payment methods for discovery.
 */
export function getPaymentMethods(env: {
  CREDIT_ESCROW?: string;
  TEST_USDC?: string;
  CREDIT_VAULT?: string;
  STRIPE_SECRET_KEY?: string;
  TEMPO_ACCOUNT?: string;
  X402_FACILITATOR_URL?: string;
  X402_PAY_TO?: string;
}) {
  const methods = [];

  // Direct transfer — always available when escrow exists
  if (env.CREDIT_ESCROW) {
    methods.push({
      id: "direct-transfer",
      name: "Direct Token Transfer",
      status: "active",
      description: "Transfer tUSDC to escrow contract, provide paymentTxHash for on-chain verification.",
      networks: ["eip155:11155111"],
      endpoint: "POST /marketplace/jobs/:jobId/complete",
    });
  }

  // MPP (Tempo crypto) — available when Tempo account is configured
  methods.push({
    id: "mpp-tempo",
    name: "MPP — Tempo (Crypto)",
    status: env.TEMPO_ACCOUNT ? "active" : "configurable",
    description: "Machine Payments Protocol via Tempo. Pay with USDC on Tempo chain. Agent-native, gasless.",
    networks: ["tempo:mainnet"],
    configure: "Set TEMPO_ACCOUNT environment variable",
    sdk: "npm i mppx — use mppx.fetch() client-side",
  });

  // MPP (Stripe fiat) — available when Stripe key is configured
  methods.push({
    id: "mpp-stripe",
    name: "MPP — Stripe (Fiat)",
    status: env.STRIPE_SECRET_KEY ? "active" : "configurable",
    description: "Machine Payments Protocol via Stripe. Pay with cards, wallets, stablecoins. Shared Payment Tokens (SPTs).",
    networks: ["stripe"],
    configure: "Set STRIPE_SECRET_KEY environment variable",
    sdk: "npm i mppx — use mppx.fetch() client-side",
  });

  // x402 — Base only
  methods.push({
    id: "x402",
    name: "x402 (Coinbase)",
    status: env.X402_FACILITATOR_URL && env.X402_PAY_TO ? "active" : "available-on-base",
    description: "Gasless USDC payments via HTTP 402. Coinbase facilitator settles on-chain.",
    networks: ["eip155:84532", "eip155:8453"],
  });

  return {
    description: "TrustVault Credit accepts multiple payment rails. Use /payment/methods to discover available options. MPP (mppx) is the recommended agent-native protocol.",
    methods,
    agentIntegration: {
      recommended: "mppx",
      install: "npm i mppx",
      usage: 'import { Mppx } from "mppx/client"; const client = Mppx.create({ methods: [tempo()] }); const res = await client.fetch(url);',
      docs: "https://mpp.dev/sdk/typescript",
    },
    lpIntegration: {
      dashboard: "https://trustvault-dashboard.pages.dev (connect wallet, deposit)",
      api: "GET /vault/opportunity (assess yield, risk, deposit instructions)",
      vault: env.CREDIT_VAULT ?? "not configured",
    },
  };
}
