/**
 * Generic chain registry — adding a new chain is just env vars, not code.
 *
 * For each chain, the worker needs:
 *   {PREFIX}_RPC_URL     — JSON-RPC endpoint
 *   {PREFIX}_PRIVATE_KEY — signing key (or falls back to AGENT_PRIVATE_KEY)
 *   {PREFIX}_USDC        — USDC/stablecoin contract address
 *   {PREFIX}_ESCROW      — TrustlessEscrow or CreditEscrow address
 *   {PREFIX}_VAULT       — CreditVault address (optional)
 *   {PREFIX}_REPUTATION   — ReputationRegistry address (optional)
 *   {PREFIX}_IDENTITY     — IdentityRegistry address (optional)
 *
 * Pre-configured chain metadata (name, explorer, chain object) is defined
 * here. But any chain works if the env vars are set — the metadata just
 * provides display info.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Hex,
  type Address,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, base, baseSepolia } from "viem/chains";
import type { Env } from "./types";

// ─── Chain Metadata ───

export interface ChainMeta {
  id: string;
  name: string;
  chainId: number;
  explorer: string;
  viemChain: Chain;
  envPrefix: string; // e.g., "BASE_SEPOLIA" → reads BASE_SEPOLIA_RPC_URL etc.
}

const KNOWN_CHAINS: ChainMeta[] = [
  {
    id: "sepolia",
    name: "Sepolia (Ethereum L1)",
    chainId: 11155111,
    explorer: "https://sepolia.etherscan.io",
    viemChain: sepolia,
    envPrefix: "", // Legacy — uses CHAIN_RPC_URL, TEST_USDC, etc. (no prefix)
  },
  {
    id: "base-sepolia",
    name: "Base Sepolia (Testnet)",
    chainId: 84532,
    explorer: "https://sepolia.basescan.org",
    viemChain: baseSepolia,
    envPrefix: "BASE_SEPOLIA",
  },
  {
    id: "base",
    name: "Base (Coinbase L2)",
    chainId: 8453,
    explorer: "https://basescan.org",
    viemChain: base,
    envPrefix: "BASE",
  },
  // HyperEVM, Tempo, etc. can be added here or configured purely via env vars
];

// ─── Chain Config (resolved from env) ───

export interface ChainConfig {
  meta: ChainMeta;
  rpcUrl: string;
  privateKey: Hex;
  token: Address;        // USDC / stablecoin
  escrow?: Address;      // TrustlessEscrow or CreditEscrow
  vault?: Address;       // ERC-4626 vault
  reputation?: Address;  // ReputationRegistry
  identity?: Address;    // IdentityRegistry
}

export interface ChainClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain>;
  account: ReturnType<typeof privateKeyToAccount>;
}

// ─── Env Helpers ───

function envGet(env: Record<string, unknown>, prefix: string, key: string): string | undefined {
  if (prefix) {
    return (env[`${prefix}_${key}`] as string) ?? undefined;
  }
  // Legacy (Sepolia) — uses unprefixed names
  const legacyMap: Record<string, string> = {
    RPC_URL: "CHAIN_RPC_URL",
    PRIVATE_KEY: "AGENT_PRIVATE_KEY",
    USDC: "TEST_USDC",
    ESCROW: "CREDIT_ESCROW",
    VAULT: "CREDIT_VAULT",
    REPUTATION: "REPUTATION_REGISTRY",
    IDENTITY: "IDENTITY_REGISTRY",
  };
  return (env[legacyMap[key] ?? key] as string) ?? undefined;
}

// ─── Public API ───

/**
 * Resolve chain config from environment variables.
 * Returns null if the chain's RPC_URL or USDC is not set.
 */
export function getChainConfig(env: Env, chainId: string): ChainConfig | null {
  const meta = KNOWN_CHAINS.find((c) => c.id === chainId);
  if (!meta) return null;

  const rpcUrl = envGet(env as unknown as Record<string, unknown>, meta.envPrefix, "RPC_URL");
  const privateKey = envGet(env as unknown as Record<string, unknown>, meta.envPrefix, "PRIVATE_KEY")
    ?? (env.AGENT_PRIVATE_KEY as string); // fallback to global key
  const token = envGet(env as unknown as Record<string, unknown>, meta.envPrefix, "USDC");

  if (!rpcUrl || !privateKey || !token) return null;

  return {
    meta,
    rpcUrl,
    privateKey: privateKey as Hex,
    token: token as Address,
    escrow: envGet(env as unknown as Record<string, unknown>, meta.envPrefix, "ESCROW") as Address | undefined,
    vault: envGet(env as unknown as Record<string, unknown>, meta.envPrefix, "VAULT") as Address | undefined,
    reputation: envGet(env as unknown as Record<string, unknown>, meta.envPrefix, "REPUTATION") as Address | undefined,
    identity: envGet(env as unknown as Record<string, unknown>, meta.envPrefix, "IDENTITY") as Address | undefined,
  };
}

/**
 * Create viem clients for a chain config.
 */
export function getChainClients(config: ChainConfig): ChainClients {
  const transport = http(config.rpcUrl);
  const account = privateKeyToAccount(config.privateKey);
  return {
    publicClient: createPublicClient({ chain: config.meta.viemChain, transport }),
    walletClient: createWalletClient({ chain: config.meta.viemChain, transport, account }),
    account,
  };
}

/**
 * List all chains that are configured (have RPC + token set).
 */
export function getActiveChains(env: Env): Array<{ id: string; name: string; chainId: number; hasEscrow: boolean; hasVault: boolean }> {
  const active = [];
  for (const meta of KNOWN_CHAINS) {
    const config = getChainConfig(env, meta.id);
    if (config) {
      active.push({
        id: meta.id,
        name: meta.name,
        chainId: meta.chainId,
        hasEscrow: !!config.escrow,
        hasVault: !!config.vault,
      });
    }
  }
  return active;
}

/**
 * Get explorer URL for an address or transaction on a chain.
 */
export function explorerUrl(chainId: string, type: "address" | "tx", hash: string): string | null {
  const meta = KNOWN_CHAINS.find((c) => c.id === chainId);
  if (!meta) return null;
  return `${meta.explorer}/${type}/${hash}`;
}
