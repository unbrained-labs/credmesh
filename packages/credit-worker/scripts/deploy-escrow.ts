/**
 * Compile and deploy CreditEscrow to Sepolia.
 * Usage: npx tsx scripts/deploy-escrow.ts <PRIVATE_KEY> <TOKEN_ADDRESS>
 */
import { createPublicClient, createWalletClient, http, type Hex, type Address, parseUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import solc from "solc";

const PRIVATE_KEY = process.argv[2] as Hex;
const TOKEN_ADDRESS = process.argv[3] as Address;
if (!PRIVATE_KEY || !TOKEN_ADDRESS) {
  console.error("Usage: npx tsx scripts/deploy-escrow.ts <PRIVATE_KEY> <TOKEN_ADDRESS>");
  process.exit(1);
}

function findImport(importPath: string) {
  // Resolve OpenZeppelin imports from node_modules
  const candidates = [
    resolve(__dirname, "../../../node_modules", importPath),
    resolve(__dirname, "../../node_modules", importPath),
    resolve(__dirname, "../node_modules", importPath),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { contents: readFileSync(candidate, "utf8") };
    }
  }

  return { error: `File not found: ${importPath}` };
}

function compile() {
  const escrowSource = readFileSync(resolve(__dirname, "../contracts/CreditEscrow.sol"), "utf8");

  const input = {
    language: "Solidity",
    sources: { "CreditEscrow.sol": { content: escrowSource } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    console.error("Compilation errors:");
    for (const err of output.errors) {
      console.error(err.formattedMessage);
    }
    process.exit(1);
  }

  const contract = output.contracts["CreditEscrow.sol"]["CreditEscrow"];
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as Hex,
  };
}

async function main() {
  console.log("Compiling CreditEscrow...");
  const { abi, bytecode } = compile();
  console.log(`Bytecode: ${bytecode.length / 2 - 1} bytes`);

  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http("https://ethereum-sepolia-rpc.publicnode.com");
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ chain: sepolia, transport, account });

  console.log(`Deployer: ${account.address}`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${Number(balance) / 1e18} ETH`);

  // Deploy
  console.log(`\nDeploying CreditEscrow(token=${TOKEN_ADDRESS})...`);
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [TOKEN_ADDRESS],
  });
  console.log(`Tx: https://sepolia.etherscan.io/tx/${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const escrowAddress = receipt.contractAddress!;
  console.log(`Escrow deployed: ${escrowAddress}`);

  // Fund the escrow: approve + deposit 50,000 tUSDC
  const TOKEN_ABI = parseAbi([
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address account) view returns (uint256)",
  ]);

  const depositAmount = parseUnits("50000", 6);

  console.log("\nApproving 50,000 tUSDC to escrow...");
  const approveHash = await walletClient.writeContract({
    address: TOKEN_ADDRESS,
    abi: TOKEN_ABI,
    functionName: "approve",
    args: [escrowAddress, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  console.log("Depositing 50,000 tUSDC into escrow...");
  const ESCROW_ABI = parseAbi([
    "function deposit(uint256 amount) external",
    "function availableFunds() external view returns (uint256)",
  ]);

  const depositHash = await walletClient.writeContract({
    address: escrowAddress,
    abi: ESCROW_ABI,
    functionName: "deposit",
    args: [depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  console.log(`Deposit tx: https://sepolia.etherscan.io/tx/${depositHash}`);

  const avail = await publicClient.readContract({
    address: escrowAddress,
    abi: ESCROW_ABI,
    functionName: "availableFunds",
  });
  console.log(`Escrow balance: ${Number(avail) / 1e6} tUSDC`);

  console.log(`\n=== DONE ===`);
  console.log(`Escrow: ${escrowAddress}`);
  console.log(`\nSet secret:`);
  console.log(`  echo "${escrowAddress}" | npx wrangler secret put CREDIT_ESCROW --name trustvault-credit`);
}

main().catch((e) => { console.error(e); process.exit(1); });
