/**
 * x402 Payment Protocol integration.
 *
 * x402 (by Coinbase) enables gasless payments via HTTP 402.
 * - Payers sign USDC transfer authorizations (EIP-3009)
 * - A facilitator settles on-chain and pays gas
 * - Resource server (us) receives USDC without the payer needing gas
 *
 * This module configures x402 for the job funding and treasury deposit paths.
 * When X402_FACILITATOR_URL is set, x402 middleware activates on payment endpoints.
 * When not set, endpoints fall through to standard (direct deposit) flow.
 *
 * Production: Base mainnet with USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
 * Testnet:    Base Sepolia with USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
 */

/** x402 CAIP-2 chain identifiers. */
const X402_NETWORKS = {
  baseSepolia: "eip155:84532" as const,
  baseMainnet: "eip155:8453" as const,
  sepolia: "eip155:11155111" as const,
};

/** USDC contract addresses for x402 (must support EIP-3009). */
const USDC_ADDRESSES = {
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  baseMainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export interface X402Config {
  facilitatorUrl: string;
  network: string;
  payToAddress: string;
}

/**
 * Build x402 config from environment variables.
 * Returns null if x402 is not configured.
 */
export function getX402Config(env: { X402_FACILITATOR_URL?: string; X402_PAY_TO?: string; X402_NETWORK?: string }): X402Config | null {
  const facilitatorUrl = env.X402_FACILITATOR_URL;
  const payTo = env.X402_PAY_TO;

  if (!facilitatorUrl || !payTo) return null;

  return {
    facilitatorUrl,
    network: env.X402_NETWORK ?? X402_NETWORKS.baseSepolia,
    payToAddress: payTo,
  };
}

/**
 * Generate x402 payment instructions for a client.
 * Clients use these instructions to sign a payment authorization.
 */
export function paymentInstructions(config: X402Config, amount: number, description: string): Record<string, unknown> {
  return {
    x402Version: 2,
    scheme: "exact",
    network: config.network,
    facilitatorUrl: config.facilitatorUrl,
    payTo: config.payToAddress,
    maxAmountRequired: String(Math.ceil(amount * 1e6)), // USDC has 6 decimals
    asset: config.network === X402_NETWORKS.baseMainnet ? USDC_ADDRESSES.baseMainnet : USDC_ADDRESSES.baseSepolia,
    description,
    mimeType: "application/json",
    extra: {
      name: "TrustVault Credit",
      description,
    },
  };
}
