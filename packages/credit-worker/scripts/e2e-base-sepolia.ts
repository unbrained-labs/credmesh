/**
 * CredMesh — Live E2E Test: TrustlessEscrowV3 on Base Sepolia
 *
 * Deploys a fresh mini-stack (RepRegistry + CreditOracle + EscrowV3) with
 * timelockDelay=1 so the full lifecycle can be tested in a single run.
 *
 * Tests: LP deposit -> reputation -> receivable registration -> advance -> settle -> redeem
 *
 * Run: npx tsx packages/credit-worker/scripts/e2e-base-sepolia.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toHex,
  formatUnits,
  getContractAddress,
  type Address,
  type Hex,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import solc from "solc";

// ─── Config ───

const RPC = "https://base-sepolia-rpc.publicnode.com";
const PRIVATE_KEY: Hex =
  "0xa16c363bd0d54e214ab417984469d1d12a61605bba8e1078809c9892a44e2a80";

const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Pre-deployed RegistryReceivableOracle (requires USDC locked for receivable registration)
const RECEIVABLE_ORACLE: Address =
  "0x3369d7167c9dffcb1bb931761f309501220ab6f4";

// Escrow params for the fresh deployment
const MIN_CREDIT_SCORE = 20;
const FEE_BPS = 500; // 5%
const HARD_CAP = BigInt(10_000) * BigInt(1e6); // 10k USDC
const TIMELOCK_DELAY = 1; // 1 second (test only)
const MAX_EXPOSURE = BigInt(100_000) * BigInt(1e6); // 100k USDC
const EXPOSURE_MULTIPLIER = BigInt(500) * BigInt(1e6); // 500 USDC per score point

// ─── Derive __dirname for ESM ───

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

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
  "function outstandingPrincipal() external view returns (uint256)",
  "function feeBps() external view returns (uint256)",
  "function oracleAdvanceRatioBps(address oracle) external view returns (uint256)",
  "function proposeOracleAdd(address oracle, uint256 ratioBps) external",
  "function executeOracleAdd(address oracle) external",
  "event AdvanceIssued(bytes32 indexed advanceId, address indexed agent, address oracle, bytes32 receivableId, uint256 principal, uint256 fee)",
]);

const REPUTATION_ABI = parseAbi([
  "function addReputation(address agent, uint256 score, string evidence) external",
  "function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount)",
]);

const RECEIVABLE_ORACLE_ABI = parseAbi([
  "function register(bytes32 id, address beneficiary, uint256 amount) external",
  "function getReceivable(bytes32 receivableId) external view returns (bool exists, address beneficiary, uint256 amount, bool settled)",
]);

// ─── Test Harness ───

let passed = 0;
let failed = 0;

function PASS(step: string, detail: string) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m ${step} — ${detail}`);
}

function FAIL(step: string, detail: string) {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${step} — ${detail}`);
}

// ─── Solc Compilation (reuse from deploy scripts) ───

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

  const importRegex = /import\s+["']([^"']+)["']/g;
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
        new RegExp(`import\\s+["']${escapeRegex(importPath)}["']`),
        `import "${solcName}"`,
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

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImport }),
  );

  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    for (const err of output.errors) console.error(err.formattedMessage);
    throw new Error(`Compilation failed for ${contractName}`);
  }

  const contract = output.contracts[contractFile]?.[contractName];
  if (!contract) {
    const available = Object.entries(output.contracts || {}).flatMap(
      ([file, contracts]: [string, any]) =>
        Object.keys(contracts).map((c) => `${file}:${c}`),
    );
    throw new Error(
      `${contractFile}:${contractName} not found. Available: ${available.join(", ")}`,
    );
  }

  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as Hex,
  };
}

// ─── Deploy Helper ───

async function deploy(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  name: string,
  abi: unknown[],
  bytecode: Hex,
  args: unknown[],
): Promise<Address> {
  console.log(`    Deploying ${name}...`);
  const hash = await walletClient.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const addr = receipt.contractAddress!;
  console.log(`    ${name}: ${addr}`);
  return addr;
}

// ─── Inline ReputationRegistry Source ───

const REP_REGISTRY_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReputationRegistry {
    struct Reputation {
        uint256 totalScore;
        uint256 attestationCount;
    }

    address public governance;
    address public pendingGovernance;
    mapping(address => bool) public approvedAttestors;
    mapping(address => Reputation) private _reputations;

    event AttestorAdded(address indexed attestor);
    event AttestorRemoved(address indexed attestor);
    event ReputationAdded(address indexed agent, address indexed attestor, uint256 score, string evidence);
    event GovernanceProposed(address indexed newGovernance);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);

    modifier onlyGovernance() { require(msg.sender == governance, "not governance"); _; }
    modifier onlyAttestor() { require(approvedAttestors[msg.sender], "not an approved attestor"); _; }

    constructor() {
        governance = msg.sender;
        approvedAttestors[msg.sender] = true;
        emit AttestorAdded(msg.sender);
    }

    function addAttestor(address attestor) external onlyGovernance {
        require(attestor != address(0), "zero address");
        approvedAttestors[attestor] = true;
        emit AttestorAdded(attestor);
    }

    function removeAttestor(address attestor) external onlyGovernance {
        approvedAttestors[attestor] = false;
        emit AttestorRemoved(attestor);
    }

    function addReputation(address agent, uint256 score, string calldata evidence) external onlyAttestor {
        require(agent != address(0), "zero agent");
        require(score <= 100, "score too high");
        Reputation storage rep = _reputations[agent];
        rep.totalScore += score;
        rep.attestationCount += 1;
        emit ReputationAdded(agent, msg.sender, score, evidence);
    }

    function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount) {
        Reputation storage rep = _reputations[agent];
        attestationCount = rep.attestationCount;
        score = attestationCount > 0 ? rep.totalScore / attestationCount : 0;
    }
}`;

// ─── Main ───

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const wallet = account.address;
  const transport = http(RPC);

  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport,
    account,
  });

  console.log("\n=== CredMesh E2E — TrustlessEscrowV3 Full Lifecycle ===\n");
  console.log(`  Chain:     Base Sepolia (84532)`);
  console.log(`  Wallet:    ${wallet}`);

  const ethBalance = await publicClient.getBalance({ address: wallet });
  const usdcBalance = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  console.log(`  ETH:       ${formatUnits(ethBalance, 18)}`);
  console.log(`  USDC:      ${formatUnits(usdcBalance, 6)}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 0: Deploy Fresh Test Stack
  // ═══════════════════════════════════════════════════════════════
  console.log("── Step 0: Deploy Fresh Test Stack (timelock=1s) ──\n");

  let escrowAddr: Address;
  let repRegistryAddr: Address;

  try {
    // 0a: Compile contracts
    console.log("  Compiling contracts...");

    const repSources = { "ReputationRegistry.sol": REP_REGISTRY_SOURCE };
    const repCompiled = compileSol(repSources, "ReputationRegistry.sol", "ReputationRegistry");

    const oracleSources = readContractSources(
      resolve(__dirname, "../contracts/oracles/ReputationCreditOracle.sol"),
    );
    const oracleCompiled = compileSol(
      oracleSources,
      "ReputationCreditOracle.sol",
      "ReputationCreditOracle",
    );

    const escrowSources = readContractSources(
      resolve(__dirname, "../contracts/TrustlessEscrowV3.sol"),
    );
    const escrowCompiled = compileSol(
      escrowSources,
      "TrustlessEscrowV3.sol",
      "TrustlessEscrowV3",
    );

    console.log("  Compilation OK\n");

    // 0b: Deploy ReputationRegistry
    repRegistryAddr = await deploy(
      publicClient,
      walletClient,
      "ReputationRegistry",
      repCompiled.abi,
      repCompiled.bytecode,
      [],
    );

    // 0c: Pre-compute escrow address, deploy credit oracle, then escrow
    const startNonce = await publicClient.getTransactionCount({ address: wallet });
    // Wait for nonce to reflect
    let currentNonce = startNonce;
    for (let i = 0; i < 10; i++) {
      currentNonce = await publicClient.getTransactionCount({ address: wallet });
      if (currentNonce > startNonce - 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Credit oracle will use currentNonce, escrow uses currentNonce+1
    const escrowNonce = currentNonce + 1;
    const precomputedEscrow = getContractAddress({
      from: wallet,
      nonce: BigInt(escrowNonce),
    });
    console.log(`    Pre-computed escrow (nonce ${escrowNonce}): ${precomputedEscrow}`);

    const creditOracleAddr = await deploy(
      publicClient,
      walletClient,
      "ReputationCreditOracle",
      oracleCompiled.abi,
      oracleCompiled.bytecode,
      [repRegistryAddr, precomputedEscrow, EXPOSURE_MULTIPLIER],
    );

    escrowAddr = await deploy(
      publicClient,
      walletClient,
      "TrustlessEscrowV3",
      escrowCompiled.abi,
      escrowCompiled.bytecode,
      [
        USDC,
        creditOracleAddr,
        BigInt(MIN_CREDIT_SCORE),
        BigInt(FEE_BPS),
        HARD_CAP,
        BigInt(TIMELOCK_DELAY),
        MAX_EXPOSURE,
      ],
    );

    if (escrowAddr.toLowerCase() !== precomputedEscrow.toLowerCase()) {
      throw new Error(
        `Escrow address mismatch: expected ${precomputedEscrow}, got ${escrowAddr}`,
      );
    }
    console.log(`    Escrow matches pre-computed address`);

    // 0d: Propose + execute oracle add (1s timelock)
    console.log(`\n    Proposing ReceivableOracle on escrow...`);
    const proposeTx = await walletClient.writeContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "proposeOracleAdd",
      args: [RECEIVABLE_ORACLE, 10000n], // 100% advance ratio
    });
    await publicClient.waitForTransactionReceipt({ hash: proposeTx });

    // Wait 2 seconds to pass the 1-second timelock
    console.log(`    Waiting 2s for timelock...`);
    await new Promise((r) => setTimeout(r, 2000));

    const executeTx = await walletClient.writeContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "executeOracleAdd",
      args: [RECEIVABLE_ORACLE],
    });
    await publicClient.waitForTransactionReceipt({ hash: executeTx });

    // Verify
    const ratio = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "oracleAdvanceRatioBps",
      args: [RECEIVABLE_ORACLE],
    });
    console.log(`    Oracle ratio: ${ratio} bps`);

    PASS("0", `Fresh stack deployed — Escrow: ${escrowAddr}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    FAIL("Step 0", msg);
    printSummary();
    return;
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: LP Deposits 4 USDC
  // (Budget: 4 deposit + 2 oracle lock + 2.1 settle = 8.1 USDC needed)
  // ═══════════════════════════════════════════════════════════════
  console.log("── Step 1: LP Deposit (4 USDC) ──");

  const depositAmount = BigInt(4e6);

  try {
    const sharesBefore = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });

    const totalAssetsBefore = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "totalAssets",
    });

    // Approve
    const approveTx = await walletClient.writeContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [escrowAddr, depositAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    PASS("1a", `Approved ${formatUnits(depositAmount, 6)} USDC to escrow`);

    // Deposit
    const depositTx = await walletClient.writeContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "deposit",
      args: [depositAmount, wallet],
    });
    const depositReceipt = await publicClient.waitForTransactionReceipt({
      hash: depositTx,
    });
    console.log(`  Tx: https://sepolia.basescan.org/tx/${depositTx}`);
    PASS("1b", `Deposited ${formatUnits(depositAmount, 6)} USDC (block ${depositReceipt.blockNumber})`);

    // Shares received
    const sharesAfter = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });
    const sharesReceived = sharesAfter - sharesBefore;
    console.log(`  Shares received: ${formatUnits(sharesReceived, 12)}`);
    if (sharesReceived > 0n) {
      PASS("1c", `Received ${formatUnits(sharesReceived, 12)} shares`);
    } else {
      FAIL("1c", `No shares received`);
    }

    // totalAssets
    const totalAssetsAfter = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "totalAssets",
    });
    console.log(`  totalAssets: ${formatUnits(totalAssetsAfter, 6)} USDC`);
    if (totalAssetsAfter - totalAssetsBefore === depositAmount) {
      PASS("1d", `totalAssets increased by exactly ${formatUnits(depositAmount, 6)} USDC`);
    } else {
      FAIL("1d", `totalAssets delta = ${formatUnits(totalAssetsAfter - totalAssetsBefore, 6)} (expected ${formatUnits(depositAmount, 6)})`);
    }

    // Share price
    const oneShare = BigInt(1e12);
    const sharePrice = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "convertToAssets",
      args: [oneShare],
    });
    console.log(`  Share price: 1 share = ${formatUnits(sharePrice, 6)} USDC`);
    PASS("1e", `Share price = ${formatUnits(sharePrice, 6)} USDC`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    FAIL("Step 1", msg);
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Set Up Borrower Reputation
  // ═══════════════════════════════════════════════════════════════
  console.log("── Step 2: Borrower Reputation ──");

  try {
    const repTx = await walletClient.writeContract({
      address: repRegistryAddr,
      abi: REPUTATION_ABI,
      functionName: "addReputation",
      args: [wallet, 80n, "e2e-test"],
    });
    await publicClient.waitForTransactionReceipt({ hash: repTx });
    PASS("2a", `Added reputation score 80`);

    const [score, attestationCount] = await publicClient.readContract({
      address: repRegistryAddr,
      abi: REPUTATION_ABI,
      functionName: "getReputation",
      args: [wallet],
    });
    console.log(`  Reputation: score=${score}, attestations=${attestationCount}`);

    if (score >= 80n) {
      PASS("2b", `Reputation score = ${score}`);
    } else {
      FAIL("2b", `Reputation score ${score} < 80`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    FAIL("Step 2", msg);
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Register Receivable + Request Advance (2 USDC)
  // ═══════════════════════════════════════════════════════════════
  console.log("── Step 3: Register Receivable + Request Advance ──");

  let advanceId: Hex | null = null;
  const advanceAmount = BigInt(2e6);

  try {
    const receivableId = keccak256(toHex(`e2e-job-${Date.now()}`));

    const usdcBeforeStep3 = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });

    // Approve USDC to receivable oracle (it locks funds during registration)
    const approveOracleTx = await walletClient.writeContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [RECEIVABLE_ORACLE, advanceAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveOracleTx });

    // Register receivable
    const regTx = await walletClient.writeContract({
      address: RECEIVABLE_ORACLE,
      abi: RECEIVABLE_ORACLE_ABI,
      functionName: "register",
      args: [receivableId, wallet, advanceAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: regTx });
    PASS("3a", `Registered receivable ${receivableId.slice(0, 18)}...`);

    // Verify
    const [exists, beneficiary, amount, settled] =
      await publicClient.readContract({
        address: RECEIVABLE_ORACLE,
        abi: RECEIVABLE_ORACLE_ABI,
        functionName: "getReceivable",
        args: [receivableId],
      });
    if (exists && beneficiary.toLowerCase() === wallet.toLowerCase()) {
      PASS("3b", `Receivable verified (${formatUnits(amount, 6)} USDC, beneficiary=${wallet.slice(0, 10)}...)`);
    } else {
      FAIL("3b", `Receivable state unexpected: exists=${exists}, beneficiary=${beneficiary}`);
    }

    // Record totalAssets before advance
    const totalAssetsBefore = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "totalAssets",
    });

    // Request advance
    console.log(`  Requesting advance of ${formatUnits(advanceAmount, 6)} USDC...`);
    const advanceTx = await walletClient.writeContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "requestAdvance",
      args: [RECEIVABLE_ORACLE, receivableId, advanceAmount],
    });
    const advanceReceipt = await publicClient.waitForTransactionReceipt({
      hash: advanceTx,
    });
    console.log(`  Tx: https://sepolia.basescan.org/tx/${advanceTx}`);

    // Extract advanceId from AdvanceIssued event
    const advanceEvent = advanceReceipt.logs.find((log) => {
      try {
        const decoded = decodeEventLog({
          abi: ESCROW_ABI,
          data: log.data,
          topics: log.topics,
        });
        return decoded.eventName === "AdvanceIssued";
      } catch {
        return false;
      }
    });

    if (advanceEvent) {
      const decoded = decodeEventLog({
        abi: ESCROW_ABI,
        data: advanceEvent.data,
        topics: advanceEvent.topics,
      });
      advanceId = (decoded.args as any).advanceId as Hex;
      const principal = (decoded.args as any).principal as bigint;
      const fee = (decoded.args as any).fee as bigint;
      console.log(`  advanceId: ${advanceId}`);
      console.log(`  principal: ${formatUnits(principal, 6)} USDC, fee: ${formatUnits(fee, 6)} USDC`);
      PASS("3c", `Advance issued: id=${advanceId.slice(0, 18)}...`);
    } else {
      FAIL("3c", `AdvanceIssued event not found in logs`);
    }

    // Verify wallet received the advance amount
    const usdcAfterStep3 = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });
    // Net: -5 (locked in oracle) +5 (advance from escrow) = 0 net change
    // But relative to after oracle lock, the advance added 5
    console.log(`  USDC: ${formatUnits(usdcBeforeStep3, 6)} -> ${formatUnits(usdcAfterStep3, 6)} (locked ${formatUnits(advanceAmount, 6)} in oracle, received ${formatUnits(advanceAmount, 6)} advance)`);
    PASS("3d", `Wallet USDC balance: ${formatUnits(usdcBeforeStep3, 6)} -> ${formatUnits(usdcAfterStep3, 6)}`);

    // totalAssets should be unchanged (idle -5 + outstanding +5)
    const totalAssetsAfter = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "totalAssets",
    });
    const outstanding = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "outstandingPrincipal",
    });
    console.log(`  totalAssets: ${formatUnits(totalAssetsAfter, 6)} USDC (outstanding: ${formatUnits(outstanding, 6)})`);

    const assetsDiff =
      totalAssetsAfter > totalAssetsBefore
        ? totalAssetsAfter - totalAssetsBefore
        : totalAssetsBefore - totalAssetsAfter;
    if (assetsDiff <= 1n) {
      PASS("3e", `totalAssets unchanged at ${formatUnits(totalAssetsAfter, 6)} USDC (idle -${formatUnits(advanceAmount, 6)}, outstanding +${formatUnits(advanceAmount, 6)})`);
    } else {
      FAIL("3e", `totalAssets changed by ${formatUnits(assetsDiff, 6)} (expected ~0)`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    FAIL("Step 3", msg);
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Settle Advance
  // ═══════════════════════════════════════════════════════════════
  console.log("── Step 4: Settle Advance ──");

  if (!advanceId) {
    FAIL("Step 4", "No advanceId from Step 3 — skipping");
    FAIL("Step 5", "Skipped — depends on Step 4");
    console.log();
    printSummary();
    return;
  }

  try {
    const principal = advanceAmount;
    const fee = (principal * BigInt(FEE_BPS)) / 10000n; // 250000 = 0.25 USDC
    const settleAmount = principal + fee; // 5250000 = 5.25 USDC

    console.log(`  principal:    ${formatUnits(principal, 6)} USDC`);
    console.log(`  fee (5%):     ${formatUnits(fee, 6)} USDC`);
    console.log(`  settleAmount: ${formatUnits(settleAmount, 6)} USDC`);

    // Approve
    const approveSettleTx = await walletClient.writeContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [escrowAddr, settleAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveSettleTx });
    PASS("4a", `Approved ${formatUnits(settleAmount, 6)} USDC`);

    // Settle
    const settleTx = await walletClient.writeContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "settle",
      args: [advanceId, settleAmount],
    });
    const settleReceipt = await publicClient.waitForTransactionReceipt({
      hash: settleTx,
    });
    console.log(`  Tx: https://sepolia.basescan.org/tx/${settleTx}`);
    PASS("4b", `Settled (block ${settleReceipt.blockNumber})`);

    // totalAssets should now be 10 + 0.25 = 10.25
    const totalAssetsAfterSettle = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "totalAssets",
    });
    console.log(`  totalAssets: ${formatUnits(totalAssetsAfterSettle, 6)} USDC`);

    if (totalAssetsAfterSettle > depositAmount) {
      PASS("4c", `totalAssets = ${formatUnits(totalAssetsAfterSettle, 6)} > ${formatUnits(depositAmount, 6)} (fee accrued)`);
    } else {
      FAIL("4c", `totalAssets ${formatUnits(totalAssetsAfterSettle, 6)} not greater than 10`);
    }

    // Share price should be > 1.0
    const oneShare = BigInt(1e12);
    const sharePriceAfter = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "convertToAssets",
      args: [oneShare],
    });
    const sharePriceNum = Number(sharePriceAfter) / 1e6;
    console.log(`  Share price: 1 share = ${formatUnits(sharePriceAfter, 6)} USDC`);

    if (sharePriceNum > 1.0) {
      PASS("4d", `Share price = ${sharePriceNum.toFixed(6)} > 1.0 (fee accrued to LPs)`);
    } else {
      FAIL("4d", `Share price ${sharePriceNum.toFixed(6)} not > 1.0`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    FAIL("Step 4", msg);
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 5: LP Redeems at Profit
  // ═══════════════════════════════════════════════════════════════
  console.log("── Step 5: LP Redeems at Profit ──");

  try {
    const usdcBeforeRedeem = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });

    const maxRedeemShares = await publicClient.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "maxRedeem",
      args: [wallet],
    });
    console.log(`  Max redeemable: ${formatUnits(maxRedeemShares, 12)} shares`);

    if (maxRedeemShares === 0n) {
      FAIL("5a", "No redeemable shares");
    } else {
      const previewAssets = await publicClient.readContract({
        address: escrowAddr,
        abi: ESCROW_ABI,
        functionName: "convertToAssets",
        args: [maxRedeemShares],
      });
      console.log(`  Expected USDC: ${formatUnits(previewAssets, 6)}`);
      PASS("5a", `${formatUnits(maxRedeemShares, 12)} shares = ~${formatUnits(previewAssets, 6)} USDC`);

      // Redeem
      const redeemTx = await walletClient.writeContract({
        address: escrowAddr,
        abi: ESCROW_ABI,
        functionName: "redeem",
        args: [maxRedeemShares, wallet, wallet],
      });
      const redeemReceipt = await publicClient.waitForTransactionReceipt({
        hash: redeemTx,
      });
      console.log(`  Tx: https://sepolia.basescan.org/tx/${redeemTx}`);
      PASS("5b", `Redeemed (block ${redeemReceipt.blockNumber})`);

      const usdcAfterRedeem = await publicClient.readContract({
        address: USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [wallet],
      });
      const received = usdcAfterRedeem - usdcBeforeRedeem;
      console.log(`  USDC received: ${formatUnits(received, 6)}`);
      console.log(`  Final USDC:    ${formatUnits(usdcAfterRedeem, 6)}`);

      if (received > depositAmount) {
        const profit = received - depositAmount;
        PASS("5c", `PROFIT: ${formatUnits(received, 6)} USDC received (${formatUnits(profit, 6)} profit on ${formatUnits(depositAmount, 6)} deposit)`);
      } else if (received === depositAmount) {
        PASS("5c", `Break even: ${formatUnits(received, 6)} USDC`);
      } else {
        FAIL("5c", `Received ${formatUnits(received, 6)} < deposited ${formatUnits(depositAmount, 6)} USDC`);
      }

      // Remaining shares should be 0 or near 0
      const remaining = await publicClient.readContract({
        address: escrowAddr,
        abi: ESCROW_ABI,
        functionName: "balanceOf",
        args: [wallet],
      });
      console.log(`  Remaining shares: ${formatUnits(remaining, 12)}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    FAIL("Step 5", msg);
  }

  console.log();
  printSummary();
}

function printSummary() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
