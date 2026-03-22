/**
 * MPP (Machine Payments Protocol) server-side integration.
 *
 * Static imports — no dynamic import() which breaks on CF Workers bundling.
 * Creates Hono middleware that gates routes behind MPP payment.
 */

import type { MiddlewareHandler } from "hono";
import { Mppx, tempo, stripe } from "mppx/hono";
import type { Env } from "./types";

/** The subset of Mppx we use — avoids fighting mppx's deep generics */
interface MppCharger {
  charge(opts: { amount: string }): MiddlewareHandler;
}

let mppInstance: MppCharger | null = null;
let mppInitEnv: string | null = null;

function initMpp(env: Env): MppCharger | null {
  if (!env.TEMPO_ACCOUNT && !env.STRIPE_SECRET_KEY) return null;

  const envKey = `${env.TEMPO_ACCOUNT ?? ""}:${env.STRIPE_SECRET_KEY ?? ""}`;
  if (mppInstance && mppInitEnv === envKey) return mppInstance;

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
}

/**
 * Hono middleware that gates a route behind MPP payment.
 * If MPP is not configured, returns 501 (not a silent pass-through).
 */
export function mppGate(amount: string): MiddlewareHandler {
  return async (c, next) => {
    const mpp = initMpp(c.env as Env);
    if (!mpp) {
      return c.json({
        error: "MPP payment not configured.",
        configure: "Set TEMPO_ACCOUNT or STRIPE_SECRET_KEY environment variables.",
        alternative: "POST /marketplace/jobs/:jobId/complete with paymentTxHash",
      }, 501);
    }
    const middleware = mpp.charge({ amount });
    return middleware(c, next);
  };
}

export function isMppEnabled(env: Env): boolean {
  return !!(env.TEMPO_ACCOUNT || env.STRIPE_SECRET_KEY);
}
