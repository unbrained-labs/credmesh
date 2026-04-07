/**
 * Compile and deploy TestUSDC to Sepolia, mint initial supply.
 * Usage: npx tsx scripts/deploy-token.ts <PRIVATE_KEY>
 */
import { createPublicClient, createWalletClient, http, type Hex, type Address, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readFileSync } from "fs";
import { resolve } from "path";
import solc from "solc";

const PRIVATE_KEY = process.argv[2] as Hex;
if (!PRIVATE_KEY) { console.error("Usage: npx tsx scripts/deploy-token.ts <PRIVATE_KEY>"); process.exit(1); }

function compile() {
  const source = readFileSync(resolve(__dirname, "../contracts/TestUSDC.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "TestUSDC.sol": { content: source } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    console.error("Compilation errors:", output.errors);
    process.exit(1);
  }
  const contract = output.contracts["TestUSDC.sol"]["TestUSDC"];
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as Hex,
  };
}

async function main() {
  console.log("Compiling TestUSDC...");
  const { abi, bytecode } = compile();
  console.log(`Bytecode size: ${bytecode.length / 2 - 1} bytes`);

  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http("https://ethereum-sepolia-rpc.publicnode.com");
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ chain: sepolia, transport, account });

  console.log(`Deployer: ${account.address}`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${Number(balance) / 1e18} ETH`);

  console.log("\nDeploying...");
  const hash = await walletClient.deployContract({ abi, bytecode, args: [] });
  console.log(`Tx: https://sepolia.etherscan.io/tx/${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const addr = receipt.contractAddress!;
  console.log(`Deployed: ${addr}`);

  // Mint 100,000 tUSDC
  console.log("\nMinting 100,000 tUSDC...");
  const mintHash = await walletClient.writeContract({
    address: addr,
    abi,
    functionName: "mint",
    args: [account.address, parseUnits("100000", 6)],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  console.log(`Mint tx: https://sepolia.etherscan.io/tx/${mintHash}`);

  const bal = await publicClient.readContract({ address: addr, abi, functionName: "balanceOf", args: [account.address] });
  console.log(`Balance: ${Number(bal as bigint) / 1e6} tUSDC`);

  console.log(`\n=== DONE ===\nToken: ${addr}`);
  console.log(`\nSet secret:\n  echo "${addr}" | npx wrangler secret put TEST_USDC --name credmesh`);
}

main().catch((e) => { console.error(e); process.exit(1); });
