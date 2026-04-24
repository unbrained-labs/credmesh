/**
 * Deploys IdentityRegistry + ReputationCreditOracle + ReputationOnlyOracle
 * and swaps them in via escrow governance. Keeps TrustlessEscrowV3.1.
 *
 * Usage: npx tsx scripts/deploy-identity-v3.1-base-sepolia.ts <PRIVATE_KEY>
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import solc from "solc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_SEPOLIA_RPC = "https://base-sepolia-rpc.publicnode.com";
const ESCROW_V31: Address = "0x664db50751c9aa1325111d202a13d10af3a9ff2d";
const OLD_CREDIT_ORACLE: Address = "0x13744c408feb8bf228a10c2e7685c1fa63e2aa1b";
const OLD_REP_ONLY_ORACLE: Address = "0xda4ac1135ce19fd4aa65396a32be7bdf63f998ef";
const REPUTATION_REGISTRY: Address = "0x4decd0a7c0431c76f3fd294f3602b55c04acb649";

const EXPOSURE_MULTIPLIER = BigInt(500) * BigInt(1e6);
const IDENTITY_BONUS_BPS = 2000;
const REP_ORACLE_MIN_SCORE = 20;
const ORACLE_RATIO_BPS = 10000;
const TIMELOCK_WAIT_SECONDS = 45;

const PRIVATE_KEY = process.argv[2] as Hex;
if (!PRIVATE_KEY) {
  console.error("Usage: npx tsx scripts/deploy-identity-v3.1-base-sepolia.ts <PRIVATE_KEY>");
  process.exit(1);
}

function findImport(importPath: string) {
  const candidates = [
    resolve(__dirname, "../../../node_modules", importPath),
    resolve(__dirname, "../../node_modules", importPath),
    resolve(__dirname, "../node_modules", importPath),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { contents: readFileSync(c, "utf8") };
  }
  return { error: `Not found: ${importPath}` };
}

function compileContract(
  sources: Record<string, string>,
  contractFile: string,
  contractName: string,
): { abi: unknown[]; bytecode: Hex } {
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(
      Object.entries(sources).map(([name, content]) => [name, { content }]),
    ),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    for (const err of output.errors) console.error(err.formattedMessage);
    throw new Error(`Compilation failed for ${contractName}`);
  }
  const contract = output.contracts[contractFile]?.[contractName];
  if (!contract) throw new Error(`Contract ${contractFile}:${contractName} not found`);
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readContractSources(
  entryPath: string,
  sources: Record<string, string> = {},
  nameOverride?: string,
): Record<string, string> {
  const absPath = resolve(entryPath);
  const name = nameOverride || absPath.split(/[\\/]/).pop()!;
  if (sources[name]) return sources;
  const content = readFileSync(absPath, "utf8");
  sources[name] = content;
  const importRegex = /import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath.startsWith(".")) {
      const dir = absPath.replace(/[\\/][^\\/]+$/, "");
      const importAbs = resolve(dir, importPath);
      const solcName = importPath.startsWith("../")
        ? importPath.replace(/^\.\.\//, "")
        : importPath.replace(/^\.\//, "");
      readContractSources(importAbs, sources, solcName);
      sources[name] = sources[name].replace(
        new RegExp(`import\\s+(?:\\{[^}]*\\}\\s+from\\s+)?["']${escapeRegex(importPath)}["']`, "g"),
        (m) => m.replace(importPath, solcName),
      );
    }
  }
  return sources;
}

async function deploy(
  pub: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  name: string,
  abi: unknown[],
  bytecode: Hex,
  args: unknown[],
): Promise<Address> {
  console.log(`\nDeploying ${name}...`);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  console.log(`  Tx: https://sepolia.basescan.org/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const addr = receipt.contractAddress!;
  console.log(`  Deployed: ${addr}`);
  return addr;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitTimelock(label: string) {
  console.log(`\n  Waiting ${TIMELOCK_WAIT_SECONDS}s for ${label} timelock...`);
  for (let elapsed = 0; elapsed < TIMELOCK_WAIT_SECONDS; elapsed += 15) {
    const remaining = Math.max(0, TIMELOCK_WAIT_SECONDS - elapsed);
    console.log(`    ${remaining}s remaining...`);
    await sleep(15_000);
  }
}

const ESCROW_GOV_ABI = parseAbi([
  "function proposeCreditOracle(address newOracle) external",
  "function executeCreditOracle(address newOracle) external",
  "function proposeOracleAdd(address oracle, uint256 ratioBps) external",
  "function executeOracleAdd(address oracle) external",
  "function proposeOracleRemove(address oracle) external",
  "function executeOracleRemove(address oracle) external",
  "function creditOracle() view returns (address)",
  "function oracleAdvanceRatioBps(address) view returns (uint256)",
  "function governance() view returns (address)",
]);

async function sendGov(
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
  fn: string,
  args: unknown[],
  label: string,
) {
  const hash = await wallet.writeContract({
    address: ESCROW_V31,
    abi: ESCROW_GOV_ABI,
    functionName: fn,
    args,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${hash}`);
}

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http(BASE_SEPOLIA_RPC);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ chain: baseSepolia, transport, account });

  console.log("=== V3.1 Completion: ERC-8004 Identity + Oracle Redeploy ===\n");
  console.log(`Deployer / Governance: ${account.address}`);
  console.log(`Escrow V3.1 (kept):    ${ESCROW_V31}`);
  console.log(`Old credit oracle:     ${OLD_CREDIT_ORACLE} (will be replaced)`);
  console.log(`Old rep-only oracle:   ${OLD_REP_ONLY_ORACLE} (will be removed)`);
  console.log(`ReputationRegistry:    ${REPUTATION_REGISTRY} (reused)`);
  console.log(`Identity bonus:        ${IDENTITY_BONUS_BPS} bps (+${IDENTITY_BONUS_BPS / 100}%)\n`);

  // Sanity: we are governance
  const gov = await pub.readContract({
    address: ESCROW_V31, abi: ESCROW_GOV_ABI, functionName: "governance",
  });
  if (gov.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`*** Governance mismatch: escrow governance is ${gov}, deployer is ${account.address}`);
    process.exit(1);
  }
  console.log("Governance check passed.");

  const balance = await pub.getBalance({ address: account.address });
  console.log(`Balance: ${Number(balance) / 1e18} ETH`);
  if (balance < 10n ** 16n) {
    console.error("Balance < 0.01 ETH — may be insufficient.");
  }

  // ── Step 1: IdentityRegistry ──
  console.log("\n── Step 1: Deploy IdentityRegistry ──");
  const regSources = readContractSources(
    resolve(__dirname, "../contracts/IdentityRegistry.sol"),
  );
  const regCompiled = compileContract(regSources, "IdentityRegistry.sol", "IdentityRegistry");
  const identityRegAddr = await deploy(pub, wallet, "IdentityRegistry",
    regCompiled.abi, regCompiled.bytecode, []);

  // ── Step 2: ReputationCreditOracle (new, with 5-arg constructor) ──
  console.log("\n── Step 2: Deploy ReputationCreditOracle (with identity wiring) ──");
  const oracleSources = readContractSources(
    resolve(__dirname, "../contracts/oracles/ReputationCreditOracle.sol"),
  );
  const oracleCompiled = compileContract(oracleSources, "ReputationCreditOracle.sol", "ReputationCreditOracle");
  const newCreditOracleAddr = await deploy(pub, wallet, "ReputationCreditOracle",
    oracleCompiled.abi, oracleCompiled.bytecode,
    [REPUTATION_REGISTRY, ESCROW_V31, EXPOSURE_MULTIPLIER, identityRegAddr, BigInt(IDENTITY_BONUS_BPS)],
  );

  // ── Step 3: ReputationOnlyOracle (new, points at new credit oracle) ──
  console.log("\n── Step 3: Deploy ReputationOnlyOracle (re-pointed at new credit oracle) ──");
  const repOnlySources = readContractSources(
    resolve(__dirname, "../contracts/oracles/ReputationOnlyOracle.sol"),
  );
  const repOnlyCompiled = compileContract(repOnlySources, "ReputationOnlyOracle.sol", "ReputationOnlyOracle");
  const newRepOnlyOracleAddr = await deploy(pub, wallet, "ReputationOnlyOracle",
    repOnlyCompiled.abi, repOnlyCompiled.bytecode,
    [REPUTATION_REGISTRY, newCreditOracleAddr, BigInt(REP_ORACLE_MIN_SCORE)],
  );

  // ── Step 4: Swap escrow.creditOracle ──
  console.log("\n── Step 4: Governance swap of escrow.creditOracle ──");
  await sendGov(wallet, pub, "proposeCreditOracle", [newCreditOracleAddr], "proposed");
  await waitTimelock("creditOracle swap");
  await sendGov(wallet, pub, "executeCreditOracle", [newCreditOracleAddr], "executed");
  const currentOracle = await pub.readContract({
    address: ESCROW_V31, abi: ESCROW_GOV_ABI, functionName: "creditOracle",
  });
  if (currentOracle.toLowerCase() !== newCreditOracleAddr.toLowerCase()) {
    console.error(`*** creditOracle swap did not stick: ${currentOracle}`);
    process.exit(1);
  }
  console.log(`  escrow.creditOracle confirmed: ${currentOracle}`);

  // ── Step 5: Register new ReputationOnlyOracle ──
  console.log("\n── Step 5: Register new ReputationOnlyOracle ──");
  await sendGov(wallet, pub, "proposeOracleAdd",
    [newRepOnlyOracleAddr, BigInt(ORACLE_RATIO_BPS)], "proposed");
  await waitTimelock("oracle add");
  await sendGov(wallet, pub, "executeOracleAdd", [newRepOnlyOracleAddr], "executed");
  const addedRatio = await pub.readContract({
    address: ESCROW_V31, abi: ESCROW_GOV_ABI, functionName: "oracleAdvanceRatioBps",
    args: [newRepOnlyOracleAddr],
  });
  if (addedRatio !== BigInt(ORACLE_RATIO_BPS)) {
    console.error(`*** New rep-only oracle not registered correctly: ratio=${addedRatio}`);
    process.exit(1);
  }
  console.log(`  new rep-only oracle registered at ${addedRatio} bps`);

  // ── Step 6: Remove old ReputationOnlyOracle ──
  console.log("\n── Step 6: Remove old ReputationOnlyOracle ──");
  await sendGov(wallet, pub, "proposeOracleRemove", [OLD_REP_ONLY_ORACLE], "proposed");
  await waitTimelock("oracle remove");
  await sendGov(wallet, pub, "executeOracleRemove", [OLD_REP_ONLY_ORACLE], "executed");
  const oldRatio = await pub.readContract({
    address: ESCROW_V31, abi: ESCROW_GOV_ABI, functionName: "oracleAdvanceRatioBps",
    args: [OLD_REP_ONLY_ORACLE],
  });
  if (oldRatio !== 0n) {
    console.error(`*** Old rep-only oracle still registered: ratio=${oldRatio}`);
    process.exit(1);
  }
  console.log(`  old rep-only oracle removed`);

  // ── Summary ──
  console.log("\n" + "=".repeat(60));
  console.log("  V3.1 COMPLETION — ERC-8004 identity wiring live on Base Sepolia");
  console.log("=".repeat(60));
  console.log();
  console.log(`  IdentityRegistry:         ${identityRegAddr}  (new)`);
  console.log(`  ReputationCreditOracle:   ${newCreditOracleAddr}  (new)`);
  console.log(`  ReputationOnlyOracle:     ${newRepOnlyOracleAddr}  (new)`);
  console.log(`  TrustlessEscrowV3.1:      ${ESCROW_V31}  (unchanged)`);
  console.log(`  ReputationRegistry:       ${REPUTATION_REGISTRY}  (reused)`);
  console.log();
  console.log(`  Replaced & deregistered:`);
  console.log(`  - ReputationCreditOracle: ${OLD_CREDIT_ORACLE}`);
  console.log(`  - ReputationOnlyOracle:   ${OLD_REP_ONLY_ORACLE}`);
  console.log();
  console.log("── Coolify Environment Variables ──");
  console.log(`  BASE_SEPOLIA_IDENTITY=${identityRegAddr}`);
  console.log(`  BASE_SEPOLIA_CREDIT_ORACLE=${newCreditOracleAddr}`);
  console.log(`  BASE_SEPOLIA_REP_ORACLE=${newRepOnlyOracleAddr}`);
  console.log(`  (unchanged: BASE_SEPOLIA_ESCROW, BASE_SEPOLIA_USDC, BASE_SEPOLIA_REPUTATION, etc.)`);
  console.log();
  console.log("── Next steps ──");
  console.log("  1. Update Coolify env vars above; push to main to redeploy worker.");
  console.log("  2. Register a test agent on IdentityRegistry and confirm bonus applies.");
}

main().catch((e) => { console.error(e); process.exit(1); });
