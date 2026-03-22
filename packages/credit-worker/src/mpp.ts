/**
 * MPP (Machine Payments Protocol) server-side integration.
 *
 * Creates Hono middleware that gates routes behind MPP payment.
 * When a client without a valid credential hits a gated route,
 * it gets a 402 with payment challenge. Clients using mppx.fetch()
 * handle this automatically.
 *
 * Supports:
 * - tempo.charge() — crypto (USDC on Tempo chain)
 * - stripe.charge() — fiat (cards, wallets, stablecoins via Stripe SPTs)
 */

import type { MiddlewareHandler } from "hono";
import type { Env } from "./types";

/** The subset of Mppx we use — avoids fighting mppx's deep generics */
interface MppCharger {
  charge(opts: { amount: string }): MiddlewareHandler;
}

let mppInstance: MppCharger | null = null;
let mppInitEnv: string | null = null;

async function getMpp(env: Env): Promise<MppCharger | null> {
  if (!env.TEMPO_ACCOUNT && !env.STRIPE_SECRET_KEY) return null;

  // Cache per isolate — only recreate if env changes
  const envKey = `${env.TEMPO_ACCOUNT ?? ""}:${env.STRIPE_SECRET_KEY ?? ""}`;
  if (mppInstance && mppInitEnv === envKey) return mppInstance;

  try {
    const { Mppx, tempo, stripe } = await import("mppx/hono");
    const methods: unknown[] = [];

    if (env.TEMPO_ACCOUNT) {
      methods.push(tempo({ account: env.TEMPO_ACCOUNT as `0x${string}` }));
    }
    if (env.STRIPE_SECRET_KEY) {
      methods.push(stripe({ secretKey: env.STRIPE_SECRET_KEY }));
    }

    mppInstance = Mppx.create({ methods } as never) as unknown as MppCharger;
    mppInitEnv = envKey;
    return mppInstance;
  } catch (e) {
    console.error("MPP init failed:", e);
    return null;
  }
}

/**
 * Hono middleware that gates a route behind MPP payment.
 * If MPP is not configured, passes through to the next handler.
 *
 * Usage:
 *   app.post("/paid-route", mppGate("10"), handler)
 *   // amount is in USD (e.g., "10" = $10)
 */
export function mppGate(amount: string): MiddlewareHandler {
  return async (c, next) => {
    const mpp = await getMpp(c.env as Env);
    if (!mpp) {
      await next();
      return;
    }
    // Delegate to mppx Hono middleware — handles 402/credential/receipt
    const middleware = mpp.charge({ amount });
    return middleware(c, next);
  };
}

/**
 * Check if MPP is available for this environment.
 */
export function isMppEnabled(env: Env): boolean {
  return !!(env.TEMPO_ACCOUNT || env.STRIPE_SECRET_KEY);
}
