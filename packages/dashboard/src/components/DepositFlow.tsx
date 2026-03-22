import { useState } from 'react';
import { Card } from './Card';
import { connectWallet, depositToVault, withdrawFromVault, disconnectWallet, type WalletState } from '../lib/wallet';
import type { HealthResponse } from '../api';

export function DepositFlow({ vault }: { vault: HealthResponse['vault'] | null }) {
  const [wallet, setWallet] = useState<WalletState>({ connected: false, address: null, chainId: null, tokenBalance: null, vaultShares: null, shareValue: null });
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [vaultAddress, setVaultAddress] = useState('');

  const connect = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const state = await connectWallet();
      setWallet(state);
      if (state.chainId !== 11155111) {
        setStatus({ type: 'err', text: 'Switch to Sepolia network in your wallet.' });
      }
    } catch (e) {
      setStatus({ type: 'err', text: e instanceof Error ? e.message : 'Connection failed' });
    } finally {
      setLoading(false);
    }
  };

  const disconnect = () => {
    setWallet(disconnectWallet());
    setStatus(null);
  };

  const execute = async () => {
    if (!amount || !vaultAddress) return;
    setLoading(true);
    setStatus(null);
    try {
      const txHash = mode === 'deposit'
        ? await depositToVault(amount, vaultAddress)
        : await withdrawFromVault(amount, vaultAddress);
      setStatus({ type: 'ok', text: `${mode === 'deposit' ? 'Deposited' : 'Withdrawn'}! Tx: ${txHash.slice(0, 14)}...` });
      setAmount('');
      // Refresh wallet state
      const state = await connectWallet();
      setWallet(state);
    } catch (e) {
      setStatus({ type: 'err', text: e instanceof Error ? e.message : 'Transaction failed' });
    } finally {
      setLoading(false);
    }
  };

  const sharePrice = vault ? parseFloat(vault.sharePrice) : 1;
  const totalAssets = vault ? parseFloat(vault.totalAssets) : 0;
  const feesEarned = vault ? parseFloat(vault.feesEarned) : 0;

  return (
    <Card title="Vault — Deposit & Earn">
      {/* Vault stats summary */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-bg border border-border p-2 text-center">
          <p className="text-[9px] uppercase tracking-widest text-text-muted">Share Price</p>
          <p className={`text-lg font-bold ${sharePrice > 1 ? 'text-green' : 'text-white'}`}>${vault?.sharePrice ?? '—'}</p>
        </div>
        <div className="bg-bg border border-border p-2 text-center">
          <p className="text-[9px] uppercase tracking-widest text-text-muted">TVL</p>
          <p className="text-lg font-bold text-white">${totalAssets.toLocaleString()}</p>
        </div>
        <div className="bg-bg border border-border p-2 text-center">
          <p className="text-[9px] uppercase tracking-widest text-text-muted">Fees Earned</p>
          <p className="text-lg font-bold text-green">${feesEarned.toFixed(2)}</p>
        </div>
      </div>

      {/* Wallet connection */}
      {!wallet.connected ? (
        <button
          onClick={connect}
          disabled={loading}
          className="w-full py-3 text-xs font-bold uppercase tracking-widest border border-green text-green hover:bg-green/10 transition-colors disabled:opacity-50"
        >
          {loading ? 'Connecting...' : 'Connect Wallet to Deposit'}
        </button>
      ) : (
        <div className="space-y-3">
          {/* Connected status */}
          <div className="flex justify-between items-center text-[10px]">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-green rounded-full" />
              <span className="text-text-muted">{wallet.address?.slice(0, 8)}...{wallet.address?.slice(-6)}</span>
              <span className="text-text-muted">|</span>
              <span className="text-white">{wallet.tokenBalance ?? '?'} tUSDC</span>
            </div>
            <button onClick={disconnect} className="text-red hover:underline">disconnect</button>
          </div>

          {/* Vault address input (needed because it's in secrets) */}
          {!vaultAddress && (
            <div>
              <p className="text-[10px] text-text-muted mb-1">Vault contract address (from /health endpoint):</p>
              <input
                value={vaultAddress}
                onChange={e => setVaultAddress(e.target.value)}
                placeholder="0x..."
                className="w-full bg-bg border border-border px-2 py-1.5 text-xs text-white outline-none focus:border-green placeholder:text-text-muted/40"
              />
            </div>
          )}

          {/* Mode toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => setMode('deposit')}
              className={`flex-1 py-1.5 text-[10px] font-bold uppercase border transition-colors ${
                mode === 'deposit' ? 'border-green text-green bg-green/10' : 'border-border text-text-muted'
              }`}
            >
              Deposit tUSDC
            </button>
            <button
              onClick={() => setMode('withdraw')}
              className={`flex-1 py-1.5 text-[10px] font-bold uppercase border transition-colors ${
                mode === 'withdraw' ? 'border-amber text-amber bg-amber/10' : 'border-border text-text-muted'
              }`}
            >
              Withdraw
            </button>
          </div>

          {/* Amount input + execute */}
          <div className="flex gap-2">
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder={mode === 'deposit' ? 'tUSDC amount' : 'tvCREDIT shares'}
              className="flex-1 bg-bg border border-border px-2 py-1.5 text-xs text-white outline-none focus:border-green placeholder:text-text-muted/40"
            />
            <button
              onClick={execute}
              disabled={loading || !amount || !vaultAddress}
              className={`px-4 py-1.5 text-[10px] font-bold uppercase border transition-colors disabled:opacity-30 ${
                mode === 'deposit'
                  ? 'border-green text-green hover:bg-green/10'
                  : 'border-amber text-amber hover:bg-amber/10'
              }`}
            >
              {loading ? '...' : mode === 'deposit' ? 'Deposit' : 'Withdraw'}
            </button>
          </div>

          {mode === 'deposit' && amount && (
            <p className="text-[10px] text-text-muted">
              You'll receive ~{(parseFloat(amount || '0') / sharePrice).toFixed(2)} tvCREDIT shares
            </p>
          )}
          {mode === 'withdraw' && amount && (
            <p className="text-[10px] text-text-muted">
              You'll receive ~{(parseFloat(amount || '0') * sharePrice).toFixed(2)} tUSDC
            </p>
          )}
        </div>
      )}

      {/* Status messages */}
      {status && (
        <p className={`text-[10px] mt-2 ${status.type === 'ok' ? 'text-green' : 'text-red'}`}>
          {status.text}
        </p>
      )}

      <p className="text-[9px] text-text-muted mt-3 border-t border-border pt-2">
        Deposit tUSDC into the ERC-4626 vault. Earn yield from agent credit fees (85% of protocol fees go to depositors). Share price increases as fees accumulate. Withdraw anytime.
      </p>
    </Card>
  );
}
