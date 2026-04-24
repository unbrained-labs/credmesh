import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const ESCROW_V31 = "0x664db50751c9aa1325111d202a13d10af3a9ff2d" as const;
const REP_CREDIT_ORACLE = "0xfe2411fa2db4efae6e8fd3794a48aff3bc0edfb9" as const;
const IDENTITY_REGISTRY = "0xabbe70645529cc9297a9de220cb7ccf3a18518e0" as const;
const REP_ONLY_ORACLE = "0x018f119d14dcdc5d7c41d528aa065310c46f0576" as const;
const OLD_REP_ONLY_ORACLE = "0xda4ac1135ce19fd4aa65396a32be7bdf63f998ef" as const;
const GOVERNANCE = "0x2cc0DCA875Ad714B6bb23b06c8c4D96265BB3F4F" as const;

type Call = { label: string; fn: string; sig: string; args?: unknown[] };

const ESCROW_CALLS: Call[] = [
  { label: "totalAssets", fn: "totalAssets", sig: "function totalAssets() view returns (uint256)" },
  { label: "totalSupply", fn: "totalSupply", sig: "function totalSupply() view returns (uint256)" },
  { label: "convertToAssets", fn: "convertToAssets", sig: "function convertToAssets(uint256) view returns (uint256)", args: [1_000_000_000_000n] },
  { label: "totalLPFeesEarned", fn: "totalLPFeesEarned", sig: "function totalLPFeesEarned() view returns (uint256)" },
  { label: "totalLiquidated", fn: "totalLiquidated", sig: "function totalLiquidated() view returns (uint256)" },
  { label: "outstandingPrincipal", fn: "outstandingPrincipal", sig: "function outstandingPrincipal() view returns (uint256)" },
  { label: "availableLiquidity", fn: "availableLiquidity", sig: "function availableLiquidity() view returns (uint256)" },
  { label: "protocolFeeBps", fn: "protocolFeeBps", sig: "function protocolFeeBps() view returns (uint256)" },
  { label: "protocolTreasury", fn: "protocolTreasury", sig: "function protocolTreasury() view returns (address)" },
];

const ORACLE_CALLS: Call[] = [
  { label: "identityRegistry", fn: "identityRegistry", sig: "function identityRegistry() view returns (address)" },
  { label: "identityBonusMultiplier", fn: "identityBonusMultiplier", sig: "function identityBonusMultiplier() view returns (uint256)" },
  { label: "governance", fn: "governance", sig: "function governance() view returns (address)" },
  { label: "exposureMultiplier", fn: "exposureMultiplier", sig: "function exposureMultiplier() view returns (uint256)" },
  { label: "reputationRegistry", fn: "reputationRegistry", sig: "function reputationRegistry() view returns (address)" },
  { label: "escrow", fn: "escrow", sig: "function escrow() view returns (address)" },
];

const ESCROW_ORACLE_CALLS: Call[] = [
  { label: "creditOracle", fn: "creditOracle", sig: "function creditOracle() view returns (address)" },
  { label: "oracleAdvanceRatioBps(new rep-only)", fn: "oracleAdvanceRatioBps", sig: "function oracleAdvanceRatioBps(address) view returns (uint256)", args: [REP_ONLY_ORACLE] },
  { label: "oracleAdvanceRatioBps(old rep-only)", fn: "oracleAdvanceRatioBps", sig: "function oracleAdvanceRatioBps(address) view returns (uint256)", args: [OLD_REP_ONLY_ORACLE] },
];

const IDENTITY_CALLS: Call[] = [
  { label: "isRegistered(governance)", fn: "isRegistered", sig: "function isRegistered(address) view returns (bool)", args: [GOVERNANCE] },
];

async function runSection(
  client: ReturnType<typeof createPublicClient>,
  title: string,
  address: `0x${string}`,
  calls: Call[],
) {
  console.log(`\n=== ${title} @ ${address} ===`);
  for (const c of calls) {
    try {
      const res = await client.readContract({
        address,
        abi: parseAbi([c.sig]),
        functionName: c.fn,
        args: c.args,
      });
      console.log(`  ok  ${c.label} -> ${Array.isArray(res) ? res.map(String).join(",") : String(res)}`);
    } catch (e) {
      const msg = e instanceof Error ? (e.message.split("\n")[0]) : String(e);
      console.log(`  err ${c.label} -> ${msg}`);
    }
  }
}

async function main() {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });
  await runSection(client, "TrustlessEscrowV3.1", ESCROW_V31, ESCROW_CALLS);
  await runSection(client, "ReputationCreditOracle (new)", REP_CREDIT_ORACLE, ORACLE_CALLS);
  await runSection(client, "Escrow oracle registrations", ESCROW_V31, ESCROW_ORACLE_CALLS);
  await runSection(client, "IdentityRegistry", IDENTITY_REGISTRY, IDENTITY_CALLS);
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
