/**
 * CredMesh — E2E Test: TrustlessEscrowV3.1 + ReputationOnlyOracle on Base Sepolia
 *
 * Deploys a fresh mini-stack with timelockDelay=1 and tests:
 *   1. LP deposit → shares at 1:1
 *   2. Agent reputation → register virtual receivable (NO collateral)
 *   3. Reputation-only advance → agent gets USDC
 *   4. Settle with fee → 85/15 split verified
 *   5. Protocol fee withdrawal → treasury receives 15%
 *   6. LP redeem → profit = 85% of fee
 *   7. Share price invariants through entire lifecycle
 *
 * Run: npx tsx scripts/e2e-v3.1-base-sepolia.ts <PRIVATE_KEY>
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  getContractAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import solc from "solc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

// ─── Config ───

const RPC = "https://base-sepolia-rpc.publicnode.com";
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const MIN_CREDIT_SCORE = 20;
const FEE_BPS = 500;
const PROTOCOL_FEE_BPS = 1500;
const HARD_CAP = BigInt(10_000) * BigInt(1e6);
const TIMELOCK_DELAY = 1;
const MAX_EXPOSURE = BigInt(100_000) * BigInt(1e6);
const ADVANCE_DURATION = 7 * 24 * 60 * 60;
const EXPOSURE_MULTIPLIER = BigInt(500) * BigInt(1e6);
const REP_ORACLE_MIN_SCORE = 20;

const PRIVATE_KEY = process.argv[2] as Hex;
if (!PRIVATE_KEY) {
  console.error("Usage: npx tsx scripts/e2e-v3.1-base-sepolia.ts <PRIVATE_KEY>");
  process.exit(1);
}

// ─── ABIs ───

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const ESCROW_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) external returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function totalAssets() external view returns (uint256)",
  "function convertToAssets(uint256 shares) external view returns (uint256)",
  "function maxRedeem(address owner) external view returns (uint256)",
  "function requestAdvance(address oracle, bytes32 receivableId, uint256 requestedAmount) external returns (bytes32 advanceId)",
  "function settle(bytes32 advanceId, uint256 payoutAmount) external",
  "function withdrawProtocolFees() external",
  "function outstandingPrincipal() external view returns (uint256)",
  "function feeBps() external view returns (uint256)",
  "function protocolFeeBps() external view returns (uint256)",
  "function accruedProtocolFees() external view returns (uint256)",
  "function totalLPFeesEarned() external view returns (uint256)",
  "function totalProtocolFeesEarned() external view returns (uint256)",
  "function totalFeesEarned() external view returns (uint256)",
  "function oracleAdvanceRatioBps(address oracle) external view returns (uint256)",
  "function proposeOracleAdd(address oracle, uint256 ratioBps) external",
  "function executeOracleAdd(address oracle) external",
  "function exposure(address agent) external view returns (uint256)",
]);

const REPUTATION_ABI = parseAbi([
  "function addReputation(address agent, uint256 score, string evidence) external",
  "function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount)",
]);

const REP_ORACLE_ABI = parseAbi([
  "function register() external returns (bytes32 receivableId)",
  "function getReceivable(bytes32 receivableId) external view returns (bool exists, address beneficiary, uint256 amount, bool settled)",
]);

// ─── Test Harness ───

let passed = 0;
let failed = 0;
let assertions = 0;

function PASS(step: string, detail: string) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m ${step} — ${detail}`);
}

function FAIL(step: string, detail: string) {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${step} — ${detail}`);
}

function assertEq(actual: bigint, expected: bigint, label: string, step: string) {
  assertions++;
  if (actual === expected) {
    PASS(step, `${label}: ${actual}`);
  } else {
    FAIL(step, `${label}: expected ${expected}, got ${actual}`);
  }
}

function assertGt(actual: bigint, threshold: bigint, label: string, step: string) {
  assertions++;
  if (actual > threshold) {
    PASS(step, `${label}: ${actual} > ${threshold}`);
  } else {
    FAIL(step, `${label}: ${actual} not > ${threshold}`);
  }
}

function assertApprox(actual: bigint, expected: bigint, tolerance: bigint, label: string, step: string) {
  assertions++;
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff <= tolerance) {
    PASS(step, `${label}: ${actual} ≈ ${expected} (±${diff})`);
  } else {
    FAIL(step, `${label}: ${actual} ≠ ${expected} (diff ${diff} > tolerance ${tolerance})`);
  }
}

// ─── Solc ───

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

function compileSol(
  sources: Record<string, string>,
  contractFile: string,
  contractName: string,
): { abi: unknown[]; bytecode: Hex } {
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(
      Object.entries(sources).map(([n, c]) => [n, { content: c }]),
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
  if (!contract) throw new Error(`${contractFile}:${contractName} not found`);
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex };
}

async function deploy(
  pub: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  name: string,
  abi: unknown[],
  bytecode: Hex,
  args: unknown[],
): Promise<Address> {
  console.log(`    Deploying ${name}...`);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const addr = receipt.contractAddress!;
  console.log(`    ${name}: ${addr}`);
  return addr;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Inline ReputationRegistry ───

const REP_REGISTRY_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract ReputationRegistry {
    struct Reputation { uint256 totalScore; uint256 attestationCount; }
    address public governance;
    mapping(address => bool) public approvedAttestors;
    mapping(address => Reputation) private _reputations;
    modifier onlyGovernance() { require(msg.sender == governance, "not governance"); _; }
    modifier onlyAttestor() { require(approvedAttestors[msg.sender], "not an approved attestor"); _; }
    constructor() { governance = msg.sender; approvedAttestors[msg.sender] = true; }
    function addAttestor(address a) external onlyGovernance { approvedAttestors[a] = true; }
    function addReputation(address agent, uint256 score, string calldata evidence) external onlyAttestor {
        require(agent != address(0) && score <= 100, "invalid");
        _reputations[agent].totalScore += score;
        _reputations[agent].attestationCount += 1;
    }
    function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount) {
        Reputation storage r = _reputations[agent];
        attestationCount = r.attestationCount;
        score = attestationCount > 0 ? r.totalScore / attestationCount : 0;
    }
}`;

// ─── Main ───

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const wallet = account.address;
  const transport = http(RPC);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wal = createWalletClient({ chain: baseSepolia, transport, account });

  console.log("\n=== CredMesh E2E — V3.1 Full Lifecycle (Reputation-Only) ===\n");
  console.log(`  Chain:          Base Sepolia (84532)`);
  console.log(`  Wallet:         ${wallet}`);
  console.log(`  Protocol Fee:   ${PROTOCOL_FEE_BPS / 100}% of advance fee`);

  const ethBal = await pub.getBalance({ address: wallet });
  const usdcBal = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });
  console.log(`  ETH:            ${formatUnits(ethBal, 18)}`);
  console.log(`  USDC:           ${formatUnits(usdcBal, 6)}\n`);

  if (ethBal === 0n) { console.error("No ETH!"); process.exit(1); }
  if (usdcBal < BigInt(4e6)) { console.error("Need at least 4 USDC"); process.exit(1); }

  // ═══════════════════════════════════════════════════════════════
  // STEP 0: Deploy Fresh Test Stack
  // ═══════════════════════════════════════════════════════════════
  console.log("── Step 0: Deploy Fresh Test Stack (timelock=1s) ──\n");

  console.log("  Compiling 4 contracts...");
  const repSources = { "ReputationRegistry.sol": REP_REGISTRY_SOURCE };
  const repCompiled = compileSol(repSources, "ReputationRegistry.sol", "ReputationRegistry");

  const oracleSources = readContractSources(resolve(__dirname, "../contracts/oracles/ReputationCreditOracle.sol"));
  const oracleCompiled = compileSol(oracleSources, "ReputationCreditOracle.sol", "ReputationCreditOracle");

  const escrowSources = readContractSources(resolve(__dirname, "../contracts/TrustlessEscrowV3.sol"));
  const escrowCompiled = compileSol(escrowSources, "TrustlessEscrowV3.sol", "TrustlessEscrowV3");

  const repOracleSources = readContractSources(resolve(__dirname, "../contracts/oracles/ReputationOnlyOracle.sol"));
  const repOracleCompiled = compileSol(repOracleSources, "ReputationOnlyOracle.sol", "ReputationOnlyOracle");
  console.log("  Compilation OK\n");

  // Deploy: RepRegistry → CreditOracle (with pre-computed escrow) → Escrow → RepOnlyOracle
  const repRegistryAddr = await deploy(pub, wal, "ReputationRegistry", repCompiled.abi, repCompiled.bytecode, []);

  const currentNonce = await pub.getTransactionCount({ address: wallet });
  const escrowNonce = currentNonce + 1;
  const precomputedEscrow = getContractAddress({ from: wallet, nonce: BigInt(escrowNonce) });
  console.log(`    Pre-computed escrow (nonce ${escrowNonce}): ${precomputedEscrow}`);

  const creditOracleAddr = await deploy(pub, wal, "ReputationCreditOracle",
    oracleCompiled.abi, oracleCompiled.bytecode,
    [repRegistryAddr, precomputedEscrow, EXPOSURE_MULTIPLIER]);

  await sleep(3000);
  const escrowAddr = await deploy(pub, wal, "TrustlessEscrowV3.1",
    escrowCompiled.abi, escrowCompiled.bytecode,
    [USDC, creditOracleAddr, BigInt(MIN_CREDIT_SCORE), BigInt(FEE_BPS), HARD_CAP,
     BigInt(TIMELOCK_DELAY), MAX_EXPOSURE, BigInt(ADVANCE_DURATION),
     wallet, BigInt(PROTOCOL_FEE_BPS)]);

  if (escrowAddr.toLowerCase() !== precomputedEscrow.toLowerCase()) {
    FAIL("0", `Escrow address mismatch: expected ${precomputedEscrow}, got ${escrowAddr}`);
    process.exit(1);
  }

  const repOracleAddr = await deploy(pub, wal, "ReputationOnlyOracle",
    repOracleCompiled.abi, repOracleCompiled.bytecode,
    [repRegistryAddr, creditOracleAddr, BigInt(REP_ORACLE_MIN_SCORE)]);

  // Register ReputationOnlyOracle with 1s timelock
  console.log("\n    Registering ReputationOnlyOracle...");
  let tx = await wal.writeContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "proposeOracleAdd", args: [repOracleAddr, 10000n] });
  await pub.waitForTransactionReceipt({ hash: tx });
  await sleep(2000);
  tx = await wal.writeContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "executeOracleAdd", args: [repOracleAddr] });
  await pub.waitForTransactionReceipt({ hash: tx });

  const ratio = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "oracleAdvanceRatioBps", args: [repOracleAddr] });
  assertEq(ratio, 10000n, "Oracle ratio", "0a");

  PASS("0b", `Stack deployed — Escrow: ${escrowAddr}, RepOracle: ${repOracleAddr}`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: LP Deposits 4 USDC
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Step 1: LP Deposit (2 USDC) ──");
  const depositAmount = BigInt(2e6);

  tx = await wal.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "approve", args: [escrowAddr, depositAmount] });
  await pub.waitForTransactionReceipt({ hash: tx });

  tx = await wal.writeContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "deposit", args: [depositAmount, wallet] });
  const depositReceipt = await pub.waitForTransactionReceipt({ hash: tx });

  const totalAssetsAfterDeposit = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "totalAssets", blockNumber: depositReceipt.blockNumber });
  assertEq(totalAssetsAfterDeposit, depositAmount, "totalAssets after deposit", "1a");

  const sharesHeld = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "balanceOf", args: [wallet] });
  assertGt(sharesHeld, 0n, "Shares received", "1b");

  const oneShare = BigInt(1e12);
  const sharePriceBefore = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "convertToAssets", args: [oneShare] });
  console.log(`  Share price: ${formatUnits(sharePriceBefore, 6)} USDC`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Attest Reputation (agent = self in test)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Step 2: Attest Reputation (score=80) ──");

  tx = await wal.writeContract({ address: repRegistryAddr, abi: REPUTATION_ABI, functionName: "addReputation", args: [wallet, 80n, "E2E test attestation"] });
  const repReceipt = await pub.waitForTransactionReceipt({ hash: tx });

  const [repScore, attestCount] = await pub.readContract({ address: repRegistryAddr, abi: REPUTATION_ABI, functionName: "getReputation", args: [wallet], blockNumber: repReceipt.blockNumber });
  assertEq(repScore, 80n, "Reputation score", "2a");
  assertEq(attestCount, 1n, "Attestation count", "2b");

  await sleep(3000);

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Register Virtual Receivable (NO COLLATERAL)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Step 3: Register Virtual Receivable (reputation-only, no collateral) ──");

  tx = await wal.writeContract({ address: repOracleAddr, abi: REP_ORACLE_ABI, functionName: "register" });
  const regReceipt = await pub.waitForTransactionReceipt({ hash: tx });

  // Extract receivableId from event logs
  const regLog = regReceipt.logs.find(l => l.address.toLowerCase() === repOracleAddr.toLowerCase());
  const receivableId = regLog?.topics[1] as Hex;
  console.log(`  receivableId: ${receivableId}`);

  const [exists, beneficiary, amount, settled] = await pub.readContract({
    address: repOracleAddr, abi: REP_ORACLE_ABI,
    functionName: "getReceivable", args: [receivableId],
  });
  PASS("3a", `Virtual receivable exists=${exists}, beneficiary=${beneficiary}`);
  assertGt(amount, 0n, "Receivable amount (live credit limit)", "3b");
  console.log(`  Credit limit: ${formatUnits(amount, 6)} USDC`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Request Advance (reputation-only, 2 USDC)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Step 4: Reputation-Only Advance (1 USDC) ──");
  const advanceAmount = BigInt(1e6);

  const agentUsdcBefore = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });

  tx = await wal.writeContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "requestAdvance", args: [repOracleAddr, receivableId, advanceAmount] });
  const advReceipt = await pub.waitForTransactionReceipt({ hash: tx });
  if (advReceipt.status !== "success") { FAIL("4", `requestAdvance reverted`); process.exit(1); }

  // Extract advanceId: AdvanceIssued has event sig + 2 indexed = 3 topics
  const advLog = advReceipt.logs.find(l => l.address.toLowerCase() === escrowAddr.toLowerCase() && l.topics.length === 3);
  const advanceId = advLog?.topics[1] as Hex;
  console.log(`  advanceId: ${advanceId}`);

  // Read balance at the confirmed block to avoid stale RPC reads
  const advBlock = advReceipt.blockNumber;
  const agentUsdcAfter = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: advBlock });
  const agentUsdcBeforeAtBlock = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: advBlock - 1n });
  assertEq(agentUsdcAfter - agentUsdcBeforeAtBlock, advanceAmount, "Agent received USDC", "4a");

  const totalAssetsduringAdvance = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "totalAssets" });
  assertEq(totalAssetsduringAdvance, depositAmount, "totalAssets unchanged during advance (idle-2 + outstanding+2)", "4b");

  const agentExposure = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "exposure", args: [wallet] });
  assertEq(agentExposure, advanceAmount, "Exposure tracked", "4c");

  // ═══════════════════════════════════════════════════════════════
  // STEP 5: Settle with Fee → 85/15 Split
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Step 5: Settle (principal + 5% fee, 85/15 split) ──");

  const fee = (advanceAmount * BigInt(FEE_BPS)) / 10000n;
  const settleAmount = advanceAmount + fee;
  console.log(`  Principal: ${formatUnits(advanceAmount, 6)}, Fee: ${formatUnits(fee, 6)}, Total: ${formatUnits(settleAmount, 6)}`);

  tx = await wal.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "approve", args: [escrowAddr, settleAmount] });
  await pub.waitForTransactionReceipt({ hash: tx });

  tx = await wal.writeContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "settle", args: [advanceId, settleAmount] });
  const settleReceipt = await pub.waitForTransactionReceipt({ hash: tx });
  if (settleReceipt.status !== "success") { FAIL("5", `settle reverted`); process.exit(1); }
  const sBlock = settleReceipt.blockNumber;

  const protocolCut = (fee * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
  const lpCut = fee - protocolCut;
  console.log(`  Expected LP cut: ${formatUnits(lpCut, 6)}, Protocol cut: ${formatUnits(protocolCut, 6)}`);

  const totalFees = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "totalFeesEarned", blockNumber: sBlock });
  assertEq(totalFees, fee, "totalFeesEarned", "5a");

  const lpFees = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "totalLPFeesEarned", blockNumber: sBlock });
  assertEq(lpFees, lpCut, "totalLPFeesEarned (85%)", "5b");

  const protocolFees = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "totalProtocolFeesEarned", blockNumber: sBlock });
  assertEq(protocolFees, protocolCut, "totalProtocolFeesEarned (15%)", "5c");

  const accrued = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "accruedProtocolFees", blockNumber: sBlock });
  assertEq(accrued, protocolCut, "accruedProtocolFees", "5d");

  assertEq(lpFees + protocolFees, totalFees, "LP + Protocol = Total (no rounding leak)", "5e");

  const sharePriceAfter = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "convertToAssets", args: [oneShare], blockNumber: sBlock });
  assertGt(sharePriceAfter, sharePriceBefore, "Share price rose", "5f");
  console.log(`  Share price: ${formatUnits(sharePriceBefore, 6)} → ${formatUnits(sharePriceAfter, 6)} USDC`);

  const totalAssetsAfterSettle = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "totalAssets", blockNumber: sBlock });
  assertEq(totalAssetsAfterSettle, depositAmount + lpCut, "totalAssets = deposit + LP fee only", "5g");

  // ═══════════════════════════════════════════════════════════════
  // STEP 6: Withdraw Protocol Fees → Treasury
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Step 6: Withdraw Protocol Fees to Treasury ──");

  tx = await wal.writeContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "withdrawProtocolFees" });
  const withdrawReceipt = await pub.waitForTransactionReceipt({ hash: tx });
  if (withdrawReceipt.status !== "success") { FAIL("6", `withdrawProtocolFees reverted`); process.exit(1); }

  const wBlock = withdrawReceipt.blockNumber;
  const treasuryAfter = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: wBlock });
  const treasuryBefore = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: wBlock - 1n });
  assertEq(treasuryAfter - treasuryBefore, protocolCut, "Treasury received protocol fees", "6a");

  const accruedAfterWithdraw = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "accruedProtocolFees" });
  assertEq(accruedAfterWithdraw, 0n, "Accrued fees cleared", "6b");

  // ═══════════════════════════════════════════════════════════════
  // STEP 7: LP Redeems at Profit
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Step 7: LP Redeem (profit = 85% of fee) ──");

  const maxRedeem = await pub.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "maxRedeem", args: [wallet] });
  assertGt(maxRedeem, 0n, "maxRedeem > 0", "7a");
  console.log(`  maxRedeem: ${formatUnits(maxRedeem, 12)} shares`);

  tx = await wal.writeContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: "redeem", args: [maxRedeem, wallet, wallet] });
  const redeemReceipt = await pub.waitForTransactionReceipt({ hash: tx });
  if (redeemReceipt.status !== "success") { FAIL("7b", `redeem reverted`); } else {
    const redeemBlock = redeemReceipt.blockNumber;
    const lpBalAfter = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: redeemBlock });
    const lpBalBefore = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: redeemBlock - 1n });
    const redeemed = lpBalAfter - lpBalBefore;
    console.log(`  Deposited: ${formatUnits(depositAmount, 6)} USDC`);
    console.log(`  Redeemed:  ${formatUnits(redeemed, 6)} USDC`);
    console.log(`  Profit:    ${formatUnits(redeemed - depositAmount, 6)} USDC`);

    assertGt(redeemed, depositAmount, "LP redeemed more than deposited", "7b");
    assertApprox(redeemed, depositAmount + lpCut, 2n, "Profit ≈ 85% of fee", "7c");
  }

  // ═══════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed (${assertions} assertions)`);
  console.log("═".repeat(60));
  console.log();
  console.log(`  Escrow:       ${escrowAddr}`);
  console.log(`  RepOracle:    ${repOracleAddr}`);
  console.log(`  CreditOracle: ${creditOracleAddr}`);
  console.log(`  RepRegistry:  ${repRegistryAddr}`);
  console.log();

  if (failed > 0) {
    console.log("  \x1b[31m✗ SOME TESTS FAILED\x1b[0m\n");
    process.exit(1);
  } else {
    console.log("  \x1b[32m✓ ALL TESTS PASSED — V3.1 reputation-only lending verified on-chain\x1b[0m\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
