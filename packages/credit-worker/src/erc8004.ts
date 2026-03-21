import type { Env } from "./types";

const GET_AGENT_SELECTOR = "0xfb3551ff";

export async function checkIdentityRegistration(env: Env, address: string): Promise<boolean> {
  if (!env.CHAIN_RPC_URL || !env.IDENTITY_REGISTRY) {
    return false;
  }

  try {
    const result = await jsonRpc(env.CHAIN_RPC_URL, "eth_call", [
      {
        to: env.IDENTITY_REGISTRY,
        data: GET_AGENT_SELECTOR + address.slice(2).padStart(64, "0"),
      },
      "latest",
    ]);
    return result !== "0x";
  } catch {
    return false;
  }
}

async function jsonRpc(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const payload = (await response.json()) as { result?: string; error?: { message: string } };
  if (payload.error) {
    throw new Error(payload.error.message);
  }

  return payload.result ?? "0x";
}

