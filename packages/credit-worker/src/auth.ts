import { createMiddleware } from "hono/factory";
import { verifyMessage } from "viem";
import type { Env } from "./types";

/**
 * EIP-191 signature auth middleware.
 *
 * Headers:
 *   X-Agent-Address: 0x...
 *   X-Agent-Signature: 0x... (signature of "credmesh:{address}:{timestamp}")
 *   X-Agent-Timestamp: unix seconds
 *
 * Behavior:
 *   - GET requests pass through unauthenticated (read-only endpoints are public)
 *   - POST/PUT/DELETE require valid wallet signature
 *   - Verified address is set on context for downstream authorization checks
 */

const MAX_AGE_SECONDS = 300;

type Variables = { verifiedAddress: string };

export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const address = c.req.header("X-Agent-Address");
    const signature = c.req.header("X-Agent-Signature");
    const timestamp = c.req.header("X-Agent-Timestamp");

    // GET requests are public — read-only endpoints don't need auth
    if (c.req.method === "GET") {
      if (address && signature && timestamp) {
        // If auth headers are provided on GET, validate them (optional enrichment)
        const verified = await verifyHeaders(address, signature, timestamp);
        if (verified) c.set("verifiedAddress", verified);
      }
      await next();
      return;
    }

    // POST/PUT/DELETE require authentication
    if (!address || !signature || !timestamp) {
      return c.json({
        error: "Authentication required.",
        hint: "Send X-Agent-Address, X-Agent-Signature, X-Agent-Timestamp headers. Sign message: credmesh:{address}:{timestamp}",
      }, 401);
    }

    const verified = await verifyHeaders(address, signature, timestamp);
    if (!verified) {
      return c.json({ error: "Invalid or expired signature." }, 401);
    }

    c.set("verifiedAddress", verified);
    await next();
  },
);

/**
 * Assert the authenticated wallet matches the address being acted upon.
 * Throws 403 if the signer is trying to act for a different agent.
 */
export function assertAuthorized(verifiedAddress: string | undefined, targetAddress: string): void {
  if (!verifiedAddress) {
    throw new AuthorizationError("No verified address on context.");
  }
  if (verifiedAddress.toLowerCase() !== targetAddress.toLowerCase()) {
    throw new AuthorizationError(`Signer ${verifiedAddress} cannot act for ${targetAddress}.`);
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

async function verifyHeaders(
  address: string,
  signature: string,
  timestamp: string,
): Promise<string | null> {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return null;

  const now = Math.floor(Date.now() / 1000);
  const CLOCK_SKEW_GRACE = 30; // allow 30s of clock skew for future timestamps
  if (ts > now + CLOCK_SKEW_GRACE) return null; // reject future timestamps
  if (now - ts > MAX_AGE_SECONDS) return null; // reject expired timestamps

  const normalizedAddress = address.toLowerCase();
  const message = `credmesh:${normalizedAddress}:${timestamp}`;

  try {
    const valid = await verifyMessage({
      address: normalizedAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    return valid ? normalizedAddress : null;
  } catch {
    return null;
  }
}
