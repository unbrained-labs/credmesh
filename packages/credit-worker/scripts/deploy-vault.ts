/**
 * Compile and deploy CreditVault + reconfigure escrow.
 * Usage: npx tsx scripts/deploy-vault.ts <PRIVATE_KEY> <TOKEN_ADDRESS> <ESCROW_ADDRESS>
 */
import { createPublicClient, createWalletClient, http, type Hex, type Address, parseUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import solc from "solc";

const PRIVATE_KEY = process.argv[2] as Hex;
const TOKEN = process.argv[3] as Address;
const ESCROW = process.argv[4] as Address;
if (!PRIVATE_KEY || !TOKEN || !ESCROW) {
  console.error("Usage: npx tsx scripts/deploy-vault.ts <PRIVATE_KEY> <TOKEN_ADDRESS> <ESCROW_ADDRESS>");
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

function compile() {
  const source = readFileSync(resolve(__dirname, "../contracts/CreditVault.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "CreditVault.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    for (const err of output.errors) console.error(err.formattedMessage);
    process.exit(1);
  }
  const contract = output.contracts["CreditVault.sol"]["CreditVault"];
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex };
}

async function main() {
  console.log("Compiling CreditVault...");
  const { abi, bytecode } = compile();
  console.log(`Bytecode: ${bytecode.length / 2 - 1} bytes`);

  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http("https://ethereum-sepolia-rpc.publicnode.com");
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ chain: sepolia, transport, account });

  console.log(`Deployer: ${account.address}`);
  const bal = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${Number(bal) / 1e18} ETH`);

  // Deploy vault: constructor(IERC20 _asset, string _name, string _symbol)
  console.log(`\nDeploying CreditVault(token=${TOKEN})...`);
  const hash = await walletClient.deployContract({
    abi, bytecode,
    args: [TOKEN, "CredMesh Shares", "cmCREDIT"],
  });
  console.log(`Tx: https://sepolia.etherscan.io/tx/${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const vaultAddr = receipt.contractAddress!;
  console.log(`Vault deployed: ${vaultAddr}`);

  // Set escrow on vault
  console.log("\nSetting escrow on vault...");
  const setEscrowHash = await walletClient.writeContract({
    address: vaultAddr, abi,
    functionName: "setEscrow",
    args: [ESCROW],
  });
  await publicClient.waitForTransactionReceipt({ hash: setEscrowHash });

  // Deposit 30,000 tUSDC into vault
  const TOKEN_ABI = parseAbi([
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const depositAmount = parseUnits("30000", 6);

  console.log("Approving 30,000 tUSDC to vault...");
  const approveHash = await walletClient.writeContract({
    address: TOKEN, abi: TOKEN_ABI,
    functionName: "approve",
    args: [vaultAddr, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  console.log("Depositing 30,000 tUSDC into vault...");
  const VAULT_ABI = parseAbi([
    "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
    "function totalAssets() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const depositHash = await walletClient.writeContract({
    address: vaultAddr, abi: VAULT_ABI,
    functionName: "deposit",
    args: [depositAmount, account.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  console.log(`Deposit tx: https://sepolia.etherscan.io/tx/${depositHash}`);

  // Check vault stats
  const totalAssets = await publicClient.readContract({
    address: vaultAddr, abi: VAULT_ABI,
    functionName: "totalAssets",
  });
  const shares = await publicClient.readContract({
    address: vaultAddr, abi: VAULT_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  console.log(`\nVault total assets: ${Number(totalAssets) / 1e6} tUSDC`);
  console.log(`Depositor shares: ${Number(shares) / 1e6} cmCREDIT`);

  console.log(`\n=== DONE ===`);
  console.log(`Vault: ${vaultAddr}`);
  console.log(`\nSet secret:`);
  console.log(`  echo "${vaultAddr}" | npx wrangler secret put CREDIT_VAULT --name credmesh`);
}

main().catch((e) => { console.error(e); process.exit(1); });
