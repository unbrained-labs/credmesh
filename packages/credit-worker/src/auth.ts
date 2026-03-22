import { createMiddleware } from "hono/factory";
import { verifyMessage } from "viem";
import type { Env } from "./types";

/**
 * EIP-191 signature auth middleware.
 *
 * Headers:
 *   X-Agent-Address: 0x...
 *   X-Agent-Signature: 0x... (signature of "trustvault-credit:{address}:{timestamp}")
 *   X-Agent-Timestamp: unix seconds
 *
 * If headers are absent, request passes through (graceful degradation for demo/testing).
 */

const MAX_AGE_SECONDS = 300;

type Variables = { verifiedAddress: string };

export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const address = c.req.header("X-Agent-Address");
    const signature = c.req.header("X-Agent-Signature");
    const timestamp = c.req.header("X-Agent-Timestamp");

    // No auth headers = unauthenticated request (read-only endpoints still work)
    if (!address || !signature || !timestamp) {
      await next();
      return;
    }

    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      return c.json({ error: "Invalid timestamp." }, 401);
    }

    const now = Math.floor(Date.now() / 1000);

    if (Math.abs(now - ts) > MAX_AGE_SECONDS) {
      return c.json({ error: "Signature expired. Timestamp must be within 5 minutes." }, 401);
    }

    const message = `trustvault-credit:${address.toLowerCase()}:${timestamp}`;

    try {
      const valid = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });

      if (!valid) {
        return c.json({ error: "Invalid signature." }, 401);
      }
    } catch {
      return c.json({ error: "Signature verification failed." }, 401);
    }

    c.set("verifiedAddress", address.toLowerCase());
    await next();
  },
);
