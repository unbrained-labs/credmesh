/**
 * Deploy full CredMesh stack to Base Sepolia testnet.
 *
 * Deploys (in order):
 *   1. ReputationRegistry
 *   2. ReputationCreditOracle
 *   3. TrustlessEscrow
 *   4. RegistryReceivableOracle
 *
 * Then proposes RegistryReceivableOracle as a trusted oracle on TrustlessEscrow
 * (starts the 48h timelock).
 *
 * Usage: npx tsx scripts/deploy-base-testnet.ts <PRIVATE_KEY>
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  getContractAddress,
  type Hex,
  type Address,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import solc from "solc";

// ─── Config ───

const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// TrustlessEscrow constructor params
const MAX_ADVANCE_RATIO_BPS = 8000; // 80% default (governance can raise to 100%)
const MIN_CREDIT_SCORE = 20;
const FEE_BPS = 500; // 5%
const HARD_CAP_PER_ADVANCE = BigInt(10_000) * BigInt(1e6); // 10,000 USDC (6 decimals)
const TIMELOCK_DELAY = 3600; // 1 hour for testnet (mainnet: 172800 = 48h)
const MAX_EXPOSURE_PER_AGENT = BigInt(100_000) * BigInt(1e6); // 100,000 USDC

// ReputationCreditOracle: 500 USDC exposure per score point
const EXPOSURE_MULTIPLIER = BigInt(500) * BigInt(1e6);

// ─── Args ───

const PRIVATE_KEY = process.argv[2] as Hex;
if (!PRIVATE_KEY) {
  console.error("Usage: npx tsx scripts/deploy-base-testnet.ts <PRIVATE_KEY>");
  process.exit(1);
}

// ─── Solc Import Resolution ───

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

// ─── Compilation ───

/**
 * Compile one or more Solidity files together and return a specific contract's
 * ABI + bytecode. `sources` is a map of { "FileName.sol": sourceCode }.
 */
function compile(
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

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImport }),
  );

  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    for (const err of output.errors) console.error(err.formattedMessage);
    throw new Error(`Compilation failed for ${contractName}`);
  }

  const contract = output.contracts[contractFile]?.[contractName];
  if (!contract) {
    // List available contracts for debugging
    const available = Object.entries(output.contracts || {}).flatMap(
      ([file, contracts]: [string, any]) =>
        Object.keys(contracts).map((c) => `${file}:${c}`),
    );
    throw new Error(
      `Contract ${contractFile}:${contractName} not found. Available: ${available.join(", ")}`,
    );
  }

  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as Hex,
  };
}

/**
 * Read a contract file and all its local imports (transitive) into a sources map.
 * Handles relative imports (./foo, ../foo) but leaves @openzeppelin to findImport.
 */
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

  // Find local imports (not @openzeppelin etc.)
  const importRegex = /import\s+["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath.startsWith(".")) {
      const dir = absPath.replace(/[\\/][^\\/]+$/, "");
      const importAbs = resolve(dir, importPath);
      const importName = importPath.replace(/^\.\.?\//, "").replace(/^.*[\\/]/, "");

      // For nested paths like ../interfaces/ICreditOracle.sol, use the relative-looking name
      // so Solidity can resolve it
      const solcName = importPath.startsWith("../")
        ? importPath.replace(/^\.\.\//, "")
        : importPath.replace(/^\.\//, "");

      readContractSources(importAbs, sources, solcName);

      // Also rewrite the source to use the flattened name
      sources[name] = sources[name].replace(
        new RegExp(`import\\s+["']${escapeRegex(importPath)}["']`),
        `import "${solcName}"`,
      );
    }
  }

  return sources;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── ReputationRegistry (hardened with attestor whitelist) ───
// Source: contracts/ReputationRegistry.sol

const REPUTATION_REGISTRY_SOURCE = `// SPDX-License-Identifier: MIT
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

    function proposeGovernance(address newGovernance) external onlyGovernance {
        require(newGovernance != address(0), "zero address");
        pendingGovernance = newGovernance;
        emit GovernanceProposed(newGovernance);
    }

    function acceptGovernance() external {
        require(msg.sender == pendingGovernance, "not pending");
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
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
}
`;

// ─── Deploy Helpers ───

async function deployContract(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  name: string,
  abi: unknown[],
  bytecode: Hex,
  args: unknown[],
): Promise<Address> {
  console.log(`\nDeploying ${name}...`);
  console.log(`  Bytecode size: ${bytecode.length / 2 - 1} bytes`);

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args,
  });
  console.log(`  Tx: https://sepolia.basescan.org/tx/${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const addr = receipt.contractAddress!;
  console.log(`  Deployed at: ${addr}`);
  return addr;
}

// ─── Main ───

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http(BASE_SEPOLIA_RPC);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ chain: baseSepolia, transport, account });

  console.log("=== CredMesh — Base Sepolia Deployment ===\n");
  console.log(`Chain:    Base Sepolia (${baseSepolia.id})`);
  console.log(`RPC:      ${BASE_SEPOLIA_RPC}`);
  console.log(`USDC:     ${BASE_SEPOLIA_USDC}`);
  console.log(`Deployer: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance:  ${Number(balance) / 1e18} ETH`);

  if (balance === 0n) {
    console.error("\nNo ETH balance! Fund your deployer on Base Sepolia first.");
    console.error("Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet");
    process.exit(1);
  }

  const startNonce = await publicClient.getTransactionCount({ address: account.address });

  // ──────────────────────────────────────────────────────
  // 1. ReputationRegistry
  // ──────────────────────────────────────────────────────
  console.log("\n── Step 1: ReputationRegistry ──");

  // Accept pre-deployed address as second CLI arg
  const preDeployedRepRegistry = process.argv[3] as string | undefined;
  let reputationRegistryAddr: string;

  if (preDeployedRepRegistry) {
    reputationRegistryAddr = preDeployedRepRegistry;
    console.log(`  Using pre-deployed: ${reputationRegistryAddr}`);
  } else {
    const repSources = { "ReputationRegistry.sol": REPUTATION_REGISTRY_SOURCE };
    const repCompiled = compile(repSources, "ReputationRegistry.sol", "ReputationRegistry");

    reputationRegistryAddr = await deployContract(
      publicClient,
      walletClient,
      "ReputationRegistry",
      repCompiled.abi,
      repCompiled.bytecode,
    [],
  );
  }

  // ──────────────────────────────────────────────────────
  // 2. ReputationCreditOracle
  //    constructor(address _reputationRegistry, address _escrow, uint256 _exposureMultiplier)
  //    NOTE: We need escrow address, but escrow needs creditOracle address.
  //    Solution: Deploy oracle with a placeholder escrow, then deploy escrow,
  //    then the oracle's escrow is immutable — so we must deploy escrow first
  //    to get its address... but escrow needs oracle address.
  //
  //    Actually looking at the code: the oracle reads escrow.exposure() which
  //    is only called when getCredit() is invoked (at advance time), not at
  //    construction. So we can:
  //    a) Pre-compute the escrow address with CREATE nonce
  //    b) Or deploy oracle with a temporary escrow, but it's immutable...
  //
  //    Best approach: pre-compute the escrow address.
  // ──────────────────────────────────────────────────────
  console.log("\n── Step 2: ReputationCreditOracle ──");

  // Wait for RPC nonce to reflect the ReputationRegistry deployment
  let currentNonce: number;
  for (let attempt = 0; attempt < 20; attempt++) {
    currentNonce = await publicClient.getTransactionCount({ address: account.address });
    if (currentNonce > startNonce) break;
    console.log(`  Waiting for nonce update (current: ${currentNonce}, need > ${startNonce})...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  currentNonce = await publicClient.getTransactionCount({ address: account.address });
  // currentNonce is the NEXT nonce to use. We're about to deploy the oracle (uses currentNonce),
  // then escrow (uses currentNonce+1).
  const escrowNonce = currentNonce + 1;

  // Pre-compute CREATE address: keccak256(rlp([sender, nonce]))[12:]
  const precomputedEscrowAddr = getContractAddress({
    from: account.address,
    nonce: BigInt(escrowNonce),
  });
  console.log(`  Pre-computed escrow address (nonce ${escrowNonce}): ${precomputedEscrowAddr}`);

  const oracleSources = readContractSources(
    resolve(__dirname, "../contracts/oracles/ReputationCreditOracle.sol"),
  );
  const oracleCompiled = compile(
    oracleSources,
    "ReputationCreditOracle.sol",
    "ReputationCreditOracle",
  );

  const creditOracleAddr = await deployContract(
    publicClient,
    walletClient,
    "ReputationCreditOracle",
    oracleCompiled.abi,
    oracleCompiled.bytecode,
    [reputationRegistryAddr, precomputedEscrowAddr, EXPOSURE_MULTIPLIER],
  );

  // ──────────────────────────────────────────────────────
  // 3. TrustlessEscrow
  //    constructor(address _token, address _creditOracle, uint256 _maxAdvanceRatioBps,
  //                uint256 _minCreditScore, uint256 _feeBps, uint256 _hardCapPerAdvance)
  // ──────────────────────────────────────────────────────
  console.log("\n── Step 3: TrustlessEscrow ──");

  const escrowSources = readContractSources(
    resolve(__dirname, "../contracts/TrustlessEscrow.sol"),
  );
  const escrowCompiled = compile(
    escrowSources,
    "TrustlessEscrow.sol",
    "TrustlessEscrow",
  );

  const escrowAddr = await deployContract(
    publicClient,
    walletClient,
    "TrustlessEscrow",
    escrowCompiled.abi,
    escrowCompiled.bytecode,
    [
      BASE_SEPOLIA_USDC,
      creditOracleAddr,
      BigInt(MAX_ADVANCE_RATIO_BPS),
      BigInt(MIN_CREDIT_SCORE),
      BigInt(FEE_BPS),
      HARD_CAP_PER_ADVANCE,
      BigInt(TIMELOCK_DELAY),
      MAX_EXPOSURE_PER_AGENT,
    ],
  );

  // Verify pre-computed address matches
  if (escrowAddr.toLowerCase() !== precomputedEscrowAddr.toLowerCase()) {
    console.error(`\n*** WARNING: Pre-computed escrow address mismatch! ***`);
    console.error(`  Expected: ${precomputedEscrowAddr}`);
    console.error(`  Actual:   ${escrowAddr}`);
    console.error(`  The ReputationCreditOracle will NOT work correctly.`);
    console.error(`  You may need to redeploy.`);
  } else {
    console.log(`  Escrow address matches pre-computed address.`);
  }

  // ──────────────────────────────────────────────────────
  // 4. RegistryReceivableOracle
  //    constructor(address _token)
  // ──────────────────────────────────────────────────────
  console.log("\n── Step 4: RegistryReceivableOracle ──");

  const receivableSources = readContractSources(
    resolve(__dirname, "../contracts/oracles/RegistryReceivableOracle.sol"),
  );
  const receivableCompiled = compile(
    receivableSources,
    "RegistryReceivableOracle.sol",
    "RegistryReceivableOracle",
  );

  const receivableOracleAddr = await deployContract(
    publicClient,
    walletClient,
    "RegistryReceivableOracle",
    receivableCompiled.abi,
    receivableCompiled.bytecode,
    [BASE_SEPOLIA_USDC],
  );

  // ──────────────────────────────────────────────────────
  // 5. Propose RegistryReceivableOracle as trusted oracle on TrustlessEscrow
  //    (starts 48h timelock)
  // ──────────────────────────────────────────────────────
  console.log("\n── Step 5: Propose RegistryReceivableOracle as trusted oracle ──");

  const ESCROW_GOV_ABI = parseAbi([
    "function proposeOracleAdd(address oracle) external",
  ]);

  const proposeHash = await walletClient.writeContract({
    address: escrowAddr,
    abi: ESCROW_GOV_ABI,
    functionName: "proposeOracleAdd",
    args: [receivableOracleAddr],
  });
  console.log(`  Tx: https://sepolia.basescan.org/tx/${proposeHash}`);
  const proposeReceipt = await publicClient.waitForTransactionReceipt({ hash: proposeHash });
  console.log(`  Oracle add proposed (48h timelock started). Block: ${proposeReceipt.blockNumber}`);

  // ──────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("  DEPLOYMENT COMPLETE — Base Sepolia");
  console.log("=".repeat(60));
  console.log();
  console.log(`  Chain:                    Base Sepolia (${baseSepolia.id})`);
  console.log(`  USDC:                     ${BASE_SEPOLIA_USDC}`);
  console.log(`  ReputationRegistry:       ${reputationRegistryAddr}`);
  console.log(`  ReputationCreditOracle:   ${creditOracleAddr}`);
  console.log(`  TrustlessEscrow:          ${escrowAddr}`);
  console.log(`  RegistryReceivableOracle: ${receivableOracleAddr}`);
  console.log();
  console.log("  Governance:               " + account.address);
  console.log("  Escrow params:");
  console.log(`    maxAdvanceRatioBps:      ${MAX_ADVANCE_RATIO_BPS} (${MAX_ADVANCE_RATIO_BPS / 100}%)`);
  console.log(`    minCreditScore:          ${MIN_CREDIT_SCORE}`);
  console.log(`    feeBps:                  ${FEE_BPS} (${FEE_BPS / 100}%)`);
  console.log(`    hardCapPerAdvance:       ${Number(HARD_CAP_PER_ADVANCE) / 1e6} USDC`);
  console.log(`    timelockDelay:           ${TIMELOCK_DELAY}s (${TIMELOCK_DELAY / 3600}h)`);
  console.log(`    maxExposurePerAgent:     ${Number(MAX_EXPOSURE_PER_AGENT) / 1e6} USDC`);
  console.log(`    exposureMultiplier:      ${Number(EXPOSURE_MULTIPLIER) / 1e6} USDC/point`);
  console.log();
  console.log("  Oracle timelock:");
  console.log(`    RegistryReceivableOracle proposed — execute after ${TIMELOCK_DELAY / 3600}h`);
  console.log();

  console.log("── Server Environment Variables ──");
  console.log();
  console.log("Set these on your server (Coolify / Hetzner):");
  const secrets: Record<string, string> = {
    CHAIN_RPC_URL: BASE_SEPOLIA_RPC,
    CHAIN_ID: String(baseSepolia.id),
    TEST_USDC: BASE_SEPOLIA_USDC,
    REPUTATION_REGISTRY: reputationRegistryAddr,
    CREDIT_ESCROW: escrowAddr,
  };
  for (const [key, val] of Object.entries(secrets)) {
    console.log(`  ${key}=${val}`);
  }

  console.log();
  console.log("── Post-deployment (after 48h timelock) ──");
  console.log();
  console.log("  Execute the oracle add with:");
  console.log(`  cast send ${escrowAddr} "executeOracleAdd(address)" ${receivableOracleAddr} --rpc-url ${BASE_SEPOLIA_RPC} --private-key <KEY>`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
