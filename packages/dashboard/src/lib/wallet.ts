import { BrowserProvider, Contract, parseUnits, type Signer } from 'ethers';

// Contract addresses (Sepolia)
const TOKEN_ADDRESS = '0x60f6420c4575bd2777bbd031c2b5b960dfbfc5d8'; // TestUSDC

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const VAULT_ABI = [
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function convertToShares(uint256 assets) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function asset() view returns (address)',
  'function vaultStats() view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)',
];

export interface WalletState {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  tokenBalance: string | null;
  vaultShares: string | null;
  shareValue: string | null;
}

const EMPTY_STATE: WalletState = {
  connected: false,
  address: null,
  chainId: null,
  tokenBalance: null,
  vaultShares: null,
  shareValue: null,
};

let provider: BrowserProvider | null = null;
let signer: Signer | null = null;

export async function connectWallet(): Promise<WalletState> {
  const ethereum = (window as unknown as Record<string, unknown>).ethereum as {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  } | undefined;

  if (!ethereum) {
    throw new Error('No wallet found. Install MetaMask or another Web3 wallet.');
  }

  provider = new BrowserProvider(ethereum as never);
  await ethereum.request({ method: 'eth_requestAccounts' });
  signer = await provider.getSigner();
  const address = await signer.getAddress();
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  // Must be on Sepolia
  if (chainId !== 11155111) {
    return {
      connected: true,
      address,
      chainId,
      tokenBalance: null,
      vaultShares: null,
      shareValue: null,
    };
  }

  // Read balances from our API (avoids direct RPC issues)
  let tokenBalance = '0';
  let vaultShares: string | null = null;
  let shareValue: string | null = null;
  try {
    const BASE = import.meta.env.PROD ? 'https://credit.unbrained.club' : '/api';
    const res = await fetch(`${BASE}/vault/position/${address}`);
    const data = await res.json();
    tokenBalance = data.wallet?.tUSDC ?? '0';
    vaultShares = data.position?.shares ?? null;
    shareValue = data.position?.currentValue ?? null;
  } catch (e) {
    console.error('Failed to read position:', e);
  }

  return {
    connected: true,
    address,
    chainId,
    tokenBalance,
    vaultShares,
    shareValue,
  };
}

export async function depositToVault(amount: string, vaultAddress: string): Promise<string> {
  if (!signer) throw new Error('Wallet not connected');

  const token = new Contract(TOKEN_ADDRESS, ERC20_ABI, signer);
  const vault = new Contract(vaultAddress, VAULT_ABI, signer);
  const decimals = await token.decimals();
  const parsedAmount = parseUnits(amount, decimals);
  const address = await signer.getAddress();

  // Check allowance
  const allowance = await token.allowance(address, vaultAddress);
  if (allowance < parsedAmount) {
    const approveTx = await token.approve(vaultAddress, parsedAmount);
    await approveTx.wait();
  }

  // Deposit
  const depositTx = await vault.deposit(parsedAmount, address);
  const receipt = await depositTx.wait();
  return receipt.hash;
}

export async function withdrawFromVault(shares: string, vaultAddress: string): Promise<string> {
  if (!signer) throw new Error('Wallet not connected');

  const vault = new Contract(vaultAddress, VAULT_ABI, signer);
  const parsedShares = parseUnits(shares, 6); // cmCREDIT has 6 decimals (same as underlying)
  const address = await signer.getAddress();

  const redeemTx = await vault.redeem(parsedShares, address, address);
  const receipt = await redeemTx.wait();
  return receipt.hash;
}

export function disconnectWallet(): WalletState {
  provider = null;
  signer = null;
  return { ...EMPTY_STATE };
}
