/**
 * Deploy TrustlessEscrowV3.1 + ReputationOnlyOracle to Base Sepolia.
 *
 * V3.1 adds:
 *   - 85/15 protocol fee split (protocolTreasury + protocolFeeBps)
 *   - ReputationOnlyOracle for uncollateralized reputation-based lending
 *
 * Reuses:
 *   - ReputationRegistry (0x4decd0a7c0431c76f3fd294f3602b55c04acb649)
 *   - RegistryReceivableOracle (0x3369d7167c9dffcb1bb931761f309501220ab6f4)
 *
 * Deploys (in order):
 *   1. ReputationCreditOracle (immutable escrow ref → pre-computed)
 *   2. TrustlessEscrowV3 (with protocolTreasury + protocolFeeBps)
 *   3. ReputationOnlyOracle (reads from registry + credit oracle)
 *   4. Proposes both oracles (RegistryReceivableOracle + ReputationOnlyOracle)
 *   5. Waits timelock, executes both
 *
 * Usage:
 *   npx tsx scripts/deploy-v3.1-base-sepolia.ts <PRIVATE_KEY>
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  getContractAddress,
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

// ─── Pre-deployed addresses (Base Sepolia) ───

const BASE_SEPOLIA_RPC = "https://base-sepolia-rpc.publicnode.com";
const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const REPUTATION_REGISTRY: Address = "0x4decd0a7c0431c76f3fd294f3602b55c04acb649";
const RECEIVABLE_ORACLE: Address = "0x3369d7167c9dffcb1bb931761f309501220ab6f4";

// ─── V3.1 Constructor Params ───

const MIN_CREDIT_SCORE = 20;
const FEE_BPS = 500; // 5%
const PROTOCOL_FEE_BPS = 1500; // 15% of advance fee → protocol treasury
const HARD_CAP = BigInt(10_000) * BigInt(1e6); // 10,000 USDC
const TIMELOCK_DELAY = 30; // 30 seconds for testnet (mainnet: 172800 = 48h)
const MAX_EXPOSURE = BigInt(100_000) * BigInt(1e6); // 100,000 USDC
const ADVANCE_DURATION = 7 * 24 * 60 * 60; // 7 days
const ORACLE_RATIO_BPS = 10000; // 100% advance ratio
const EXPOSURE_MULTIPLIER = BigInt(500) * BigInt(1e6); // 500 USDC per score point
const REP_ORACLE_MIN_SCORE = 20;

// ─── Args ───

const PRIVATE_KEY = process.argv[2] as Hex;
if (!PRIVATE_KEY) {
  console.error("Usage: npx tsx scripts/deploy-v3.1-base-sepolia.ts <PRIVATE_KEY>");
  process.exit(1);
}

// ─── Solc Helpers ───

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

// ─── Deploy helper ───

async function deploy(
  pub: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  name: string,
  abi: unknown[],
  bytecode: Hex,
  args: unknown[],
): Promise<Address> {
  console.log(`\nDeploying ${name}...`);
  console.log(`  Bytecode: ${bytecode.length / 2 - 1} bytes`);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  console.log(`  Tx: https://sepolia.basescan.org/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const addr = receipt.contractAddress!;
  console.log(`  Deployed: ${addr}`);
  return addr;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ───

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http(BASE_SEPOLIA_RPC);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ chain: baseSepolia, transport, account });

  console.log("=== TrustlessEscrowV3.1 — Base Sepolia Deploy ===\n");
  console.log(`Deployer / Treasury:  ${account.address}`);
  console.log(`Reusing RepRegistry:  ${REPUTATION_REGISTRY}`);
  console.log(`Reusing RecvOracle:   ${RECEIVABLE_ORACLE}`);
  console.log(`USDC:                 ${BASE_SEPOLIA_USDC}`);
  console.log(`Timelock:             ${TIMELOCK_DELAY}s`);
  console.log(`Protocol Fee:         ${PROTOCOL_FEE_BPS / 100}% of advance fee\n`);

  const balance = await pub.getBalance({ address: account.address });
  console.log(`Balance: ${Number(balance) / 1e18} ETH`);
  if (balance === 0n) {
    console.error("No ETH! Bridge from Eth Sepolia first.");
    process.exit(1);
  }

  // Pre-compute: oracle at nonce N, escrow at N+1, repOracle at N+2
  const currentNonce = await pub.getTransactionCount({ address: account.address });
  const escrowNonce = currentNonce + 1;
  const precomputedEscrow = getContractAddress({
    from: account.address,
    nonce: BigInt(escrowNonce),
  });
  console.log(`Pre-computed escrow (nonce ${escrowNonce}): ${precomputedEscrow}\n`);

  // ── 1. ReputationCreditOracle ──

  console.log("── Step 1: ReputationCreditOracle ──");
  const oracleSources = readContractSources(
    resolve(__dirname, "../contracts/oracles/ReputationCreditOracle.sol"),
  );
  const oracleCompiled = compileContract(oracleSources, "ReputationCreditOracle.sol", "ReputationCreditOracle");

  const creditOracleAddr = await deploy(pub, wallet, "ReputationCreditOracle",
    oracleCompiled.abi, oracleCompiled.bytecode,
    [REPUTATION_REGISTRY, precomputedEscrow, EXPOSURE_MULTIPLIER],
  );

  // ── 2. TrustlessEscrowV3.1 ──

  console.log("\n── Step 2: TrustlessEscrowV3.1 ──");
  const escrowSources = readContractSources(
    resolve(__dirname, "../contracts/TrustlessEscrowV3.sol"),
  );
  const escrowCompiled = compileContract(escrowSources, "TrustlessEscrowV3.sol", "TrustlessEscrowV3");

  const escrowAddr = await deploy(pub, wallet, "TrustlessEscrowV3 (v3.1)",
    escrowCompiled.abi, escrowCompiled.bytecode,
    [
      BASE_SEPOLIA_USDC, creditOracleAddr,
      BigInt(MIN_CREDIT_SCORE), BigInt(FEE_BPS), HARD_CAP,
      BigInt(TIMELOCK_DELAY), MAX_EXPOSURE,
      BigInt(ADVANCE_DURATION),
      account.address, // protocolTreasury = deployer (governance wallet)
      BigInt(PROTOCOL_FEE_BPS),
    ],
  );

  if (escrowAddr.toLowerCase() !== precomputedEscrow.toLowerCase()) {
    console.error(`\n*** ESCROW ADDRESS MISMATCH ***`);
    console.error(`  Expected: ${precomputedEscrow}`);
    console.error(`  Actual:   ${escrowAddr}`);
    console.error(`  CreditOracle will NOT work. Redeploy needed.`);
    process.exit(1);
  }
  console.log(`  Address matches pre-computed. Oracle wiring correct.`);

  // ── 3. ReputationOnlyOracle ──

  console.log("\n── Step 3: ReputationOnlyOracle ──");
  const repOracleSources = readContractSources(
    resolve(__dirname, "../contracts/oracles/ReputationOnlyOracle.sol"),
  );
  const repOracleCompiled = compileContract(repOracleSources, "ReputationOnlyOracle.sol", "ReputationOnlyOracle");

  const repOracleAddr = await deploy(pub, wallet, "ReputationOnlyOracle",
    repOracleCompiled.abi, repOracleCompiled.bytecode,
    [REPUTATION_REGISTRY, creditOracleAddr, BigInt(REP_ORACLE_MIN_SCORE)],
  );

  // ── 4. Propose both oracles ──

  console.log("\n── Step 4: Propose oracle adds ──");
  const GOV_ABI = parseAbi([
    "function proposeOracleAdd(address oracle, uint256 ratioBps) external",
    "function executeOracleAdd(address oracle) external",
  ]);

  const propose1Hash = await wallet.writeContract({
    address: escrowAddr, abi: GOV_ABI,
    functionName: "proposeOracleAdd",
    args: [RECEIVABLE_ORACLE, BigInt(ORACLE_RATIO_BPS)],
  });
  await pub.waitForTransactionReceipt({ hash: propose1Hash });
  console.log(`  Proposed RegistryReceivableOracle: ${RECEIVABLE_ORACLE} at ${ORACLE_RATIO_BPS} bps`);

  const propose2Hash = await wallet.writeContract({
    address: escrowAddr, abi: GOV_ABI,
    functionName: "proposeOracleAdd",
    args: [repOracleAddr, BigInt(ORACLE_RATIO_BPS)],
  });
  await pub.waitForTransactionReceipt({ hash: propose2Hash });
  console.log(`  Proposed ReputationOnlyOracle: ${repOracleAddr} at ${ORACLE_RATIO_BPS} bps`);

  // ── 5. Wait for timelock ──

  console.log(`\n── Step 5: Waiting ${TIMELOCK_DELAY}s for timelock... ──`);
  const waitTime = TIMELOCK_DELAY + 15; // buffer
  for (let elapsed = 0; elapsed < waitTime; elapsed += 10) {
    const remaining = Math.max(0, waitTime - elapsed);
    console.log(`  ${remaining}s remaining...`);
    await sleep(10_000);
  }

  // ── 6. Execute both oracle adds ──

  console.log("\n── Step 6: Execute oracle adds ──");
  const exec1Hash = await wallet.writeContract({
    address: escrowAddr, abi: GOV_ABI,
    functionName: "executeOracleAdd",
    args: [RECEIVABLE_ORACLE],
  });
  await pub.waitForTransactionReceipt({ hash: exec1Hash });
  console.log(`  RegistryReceivableOracle registered.`);

  const exec2Hash = await wallet.writeContract({
    address: escrowAddr, abi: GOV_ABI,
    functionName: "executeOracleAdd",
    args: [repOracleAddr],
  });
  await pub.waitForTransactionReceipt({ hash: exec2Hash });
  console.log(`  ReputationOnlyOracle registered. Reputation-only advances are now possible.`);

  // ── Summary ──

  console.log("\n" + "=".repeat(60));
  console.log("  DEPLOYMENT COMPLETE — TrustlessEscrowV3.1 on Base Sepolia");
  console.log("=".repeat(60));
  console.log();
  console.log(`  TrustlessEscrowV3.1:      ${escrowAddr}`);
  console.log(`  ReputationCreditOracle:   ${creditOracleAddr}`);
  console.log(`  ReputationOnlyOracle:     ${repOracleAddr}`);
  console.log(`  ReputationRegistry:       ${REPUTATION_REGISTRY} (reused)`);
  console.log(`  RegistryReceivableOracle: ${RECEIVABLE_ORACLE} (reused)`);
  console.log(`  USDC:                     ${BASE_SEPOLIA_USDC}`);
  console.log(`  Governance / Treasury:    ${account.address}`);
  console.log(`  Protocol Fee:             ${PROTOCOL_FEE_BPS / 100}% of advance fee`);
  console.log(`  Timelock:                 ${TIMELOCK_DELAY}s`);
  console.log();
  console.log("── Coolify Environment Variables ──");
  console.log();
  console.log(`  BASE_SEPOLIA_ESCROW=${escrowAddr}`);
  console.log(`  BASE_SEPOLIA_CREDIT_ORACLE=${creditOracleAddr}`);
  console.log(`  BASE_SEPOLIA_REP_ORACLE=${repOracleAddr}`);
  console.log(`  (others unchanged: BASE_SEPOLIA_RPC_URL, BASE_SEPOLIA_REPUTATION, BASE_SEPOLIA_ORACLE, BASE_SEPOLIA_USDC)`);
  console.log();
  console.log("── Next steps ──");
  console.log("  1. Update Coolify env vars with the addresses above");
  console.log("  2. Seed the pool: approve + deposit USDC into the escrow (ERC-4626 deposit)");
  console.log("  3. Update dashboard wallet.ts to target new escrow address");
  console.log("  4. Push to main → Coolify auto-deploys");
  console.log("  5. Run E2E test: npx tsx scripts/e2e-base-sepolia.ts <PRIVATE_KEY>");
}

main().catch((e) => { console.error(e); process.exit(1); });
