# HyperEVM Research: Deploying a Credit Protocol

> Research compiled March 2026. Covers deploying TrustlessEscrow + ERC-4626 vault on HyperEVM.

---

## 1. Chain ID, RPC URLs, and Block Explorers

### Mainnet

| Property          | Value                                      |
| ----------------- | ------------------------------------------ |
| Chain ID          | **999**                                    |
| RPC URL           | `https://rpc.hyperliquid.xyz/evm`          |
| Currency Symbol   | HYPE                                       |
| Block Explorers   | https://hyperevmscan.io/ (Etherscan-style) |
|                   | https://www.hyperscan.com/ (Blockscout)    |
|                   | https://hypurrscan.io/ (HyperCore + EVM)   |
|                   | https://purrsec.com/                       |

### Testnet

| Property          | Value                                              |
| ----------------- | -------------------------------------------------- |
| Chain ID          | **998**                                            |
| RPC URL           | `https://rpc.hyperliquid-testnet.xyz/evm`          |
| Alt RPC           | `https://hyperliquid-testnet.drpc.org`             |
| Currency Symbol   | HYPE                                               |

### Hardhat / Foundry Config Snippet

```typescript
// hardhat.config.ts
networks: {
  hyperEvm: {
    url: "https://rpc.hyperliquid.xyz/evm",
    chainId: 999,
    accounts: [process.env.PRIVATE_KEY],
  },
  hyperEvmTestnet: {
    url: "https://rpc.hyperliquid-testnet.xyz/evm",
    chainId: 998,
    accounts: [process.env.PRIVATE_KEY],
  },
}
```

---

## 2. USDC Contract Addresses

### Mainnet (Verified)

- **Address:** `0xb88339CB7199b77E23DB6E890353E22632Ba630f`
- **Issuer:** Circle (native USDC, not bridged)
- **Verified on:** [HyperEVMScan](https://hyperevmscan.io/address/0xb88339cb7199b77e23db6e890353e22632ba630f)
- **Circle page:** https://www.circle.com/multi-chain-usdc/hyperevm

This is native Circle-minted USDC, not a bridged wrapper. Circle has officially launched USDC on HyperEVM as a supported chain.

### Testnet

- **Address:** `0xd9CBEC81df392A88AEff575E962d149d57F4d6bc`
- **Note:** The user-provided testnet address `0xd9CBEC81df392A88AEff575E962d57F4d6bc` appears to be **truncated** (only 38 hex chars after `0x`). The full, correct address is `0xd9CBEC81df392A88AEff575E962d149d57F4d6bc` (40 hex chars). The missing segment is `149d`.

### USDC System Address (for HyperCore bridging)

USDC has token index 0 on HyperCore, so its system address is:

```
0x2000000000000000000000000000000000000000
```

---

## 3. EVM Compatibility

### Solidity Version Support

HyperEVM is EVM-compatible and supports Solidity compilation up to the latest versions. Standard Ethereum tooling works: **Hardhat, Foundry, Remix, ethers.js, viem**.

### PUSH0 Opcode / EVM Target

**Recommendation: compile with `evmVersion: "paris"` to be safe.**

HyperEVM documentation does not explicitly confirm Shanghai-level opcode support (which includes `PUSH0` at `0x5f`). Since Solidity >= 0.8.20 defaults to the Shanghai EVM target and emits `PUSH0`, contracts compiled without specifying an EVM version may fail to deploy if HyperEVM does not support it.

```javascript
// hardhat.config.ts — safe setting
solidity: {
  version: "0.8.20",
  settings: {
    evmVersion: "paris",   // avoids PUSH0
    optimizer: { enabled: true, runs: 200 },
  },
}
```

```toml
# foundry.toml
[profile.default]
solc_version = "0.8.20"
evm_version = "paris"
optimizer = true
optimizer_runs = 200
```

### OpenZeppelin Compatibility

OpenZeppelin Contracts (v4.x and v5.x) work on HyperEVM. Multiple projects (Lazy Summer, Basis Protocol, various ERC-20 deployments) use OpenZeppelin on HyperEVM. The standard `@openzeppelin/contracts` package, including `ERC4626`, `ERC20`, `ReentrancyGuard`, `Ownable`, etc., deploys without modification when targeting `paris`.

### Known Opcode Differences

No documented opcode removals or custom opcodes beyond the standard EVM set. HyperEVM implements EIP-1559 gas fee model. The chain adds **custom precompiles** at `0x0800+` and a **system contract** at `0x3333...` (CoreWriter) -- these are additions, not replacements.

---

## 4. Gas Token and Deployment Costs

### Gas Token

- **HYPE** is the native gas token on HyperEVM (like ETH on Ethereum).
- Both base fees and priority fees are **burned** (priority fees go to the zero address because HyperBFT consensus has no miners/validators to tip).

### Current Gas Prices

- Typical gas price: **~0.185 Gwei** (per HyperEVMScan gas tracker).
- Real-time tracker: https://hyperevmscan.io/gastracker or https://hypergas.io/

### Dual-Block Architecture

HyperEVM uses a dual-block system that affects contract deployment:

| Block Type | Block Time | Gas Limit |
| ---------- | ---------- | --------- |
| Fast Block | ~1-2 sec   | 2M gas    |
| Slow Block | ~60 sec    | 30M gas   |

**Contract deployment typically requires slow-block mode** because deploying a moderately complex contract (ERC-4626 vault + escrow) will exceed the 2M gas limit of fast blocks. Wallets may need to be configured for slow-block submission.

### Estimated Deployment Costs

At 0.185 Gwei gas price:

| Contract               | Est. Gas   | Est. Cost (HYPE)  |
| ---------------------- | ---------- | ----------------- |
| Simple ERC-20          | ~1.5M      | ~0.000278         |
| ERC-4626 Vault         | ~3-5M      | ~0.0006-0.001     |
| TrustlessEscrow        | ~2-4M      | ~0.0004-0.0007    |
| Full protocol suite    | ~8-12M     | ~0.0015-0.0022    |

Gas costs on HyperEVM are **extremely cheap** -- full protocol deployment should cost well under $0.01 at current HYPE prices.

---

## 5. Builder Code Mechanics

Builder codes let frontends/aggregators earn fees on trades they facilitate on HyperCore.

### How It Works

1. **Builder** sets up a builder code tied to their address.
2. **User** signs an `ApproveBuilderFee` action (must be signed by user's main wallet, NOT an agent/API wallet).
3. On each trade routed through the builder, the builder fee is deducted **per-fill** (not per-order).

### Fee Limits

| Market Type | Max Builder Fee |
| ----------- | --------------- |
| Perps       | 0.10% (10 bps)  |
| Spot        | 1.00% (100 bps) |

### Registration Requirements

- Builder must have **>= 100 USDC** in perps account value.
- Each user can have a maximum of **10 active builder code approvals**.
- Builder fees are collected in the **quote/collateral asset** (USDC for perps).
- On spot trades, builder codes only apply to the **selling side**, not the buying side.

### ApproveBuilderFee Action

```json
{
  "type": "approveBuilderFee",
  "hyperliquidChain": "Mainnet",
  "signatureChainId": "0xa4b1",
  "maxFeeRate": "0.001%",
  "builder": "0x<builder_address>",
  "nonce": 1711234567890
}
```

### Relevance to Credit Protocol

Builder codes are a **HyperCore (L1)** mechanism, not an EVM contract mechanism. A credit protocol on HyperEVM would not directly use builder codes unless it also routes orders through HyperCore's order book via CoreWriter. If the vault strategy involves placing perp trades, builder codes could be used to capture fees on those trades.

---

## 6. CoreWriter (0x3333...)

### Address

```
0x3333333333333333333333333333333333333333
```

### What It Does

CoreWriter is a **system contract** (not a standard precompile) that allows HyperEVM smart contracts to **write transactions to HyperCore**. It is the bridge for EVM -> L1 actions.

### Supported Actions

- Place/cancel limit orders on perp and spot markets
- Transfer spot assets between accounts
- Manage HyperCore vaults (deposit/withdraw)
- Stake/unstake HYPE
- Any action that can be submitted to HyperCore's API

### Solidity Interface

```solidity
interface CoreWriter {
    function sendRawAction(bytes calldata data) external;
}

// Usage
CoreWriter constant CORE_WRITER = CoreWriter(0x3333333333333333333333333333333333333333);

function placeOrder(bytes memory encodedAction) external {
    CORE_WRITER.sendRawAction(encodedAction);
}
```

### Action Encoding Format

Actions sent to `sendRawAction` must be encoded as:

```
[1 byte: encoding version (currently 0x01)]
[1 byte: action ID]
[remaining bytes: ABI-encoded action parameters]
```

### Timing and Security

- **Delay:** CoreWriter actions are intentionally **delayed** -- they execute in the Core block *after* the EVM block that contains them. This prevents frontrunning from mempool monitoring.
- **Processing order within a block:**
  1. All queued `Transfer` events are applied (EVM -> Core balance updates)
  2. All pending CoreWriter actions are executed
- CoreWriter is **permissionless** -- any contract can call it.
- Gas cost: ~20k gas per `sendRawAction` call.

### Official Library

The `hyper-evm-lib` repository provides Solidity wrappers, encoding helpers, and a **local Foundry testing framework** for CoreWriter:

```
https://github.com/hyperliquid-dev/hyper-evm-lib
```

### Relevance to Credit Protocol

A vault contract could use CoreWriter to:
- Place delta-neutral hedging trades on HyperCore perps
- Transfer USDC between the vault's EVM balance and its HyperCore balance
- Manage a HyperCore vault position as part of a yield strategy

---

## 7. Read Precompiles (0x0800...)

Read precompiles allow HyperEVM contracts to **read HyperCore state atomically** within a transaction. Values are guaranteed to match the latest HyperCore state at the time the EVM block was constructed.

### Precompile Address Map

| Address  | Name                    | Returns                                      |
| -------- | ----------------------- | -------------------------------------------- |
| `0x0800` | Perps Position          | User's perpetual position for a given market |
| `0x0801` | Spot Balance            | User's spot token balance on HyperCore       |
| `0x0802` | Vault Equity            | Total equity of a HyperCore vault            |
| `0x0803` | Staking Delegations     | Staking delegation info                      |
| `0x0804` | Oracle Prices           | HyperCore oracle price for a given asset     |
| `0x0805` | L1 Block Number         | Current HyperCore (L1) block number          |

### Gas Cost Formula

```
gas = 2000 + 65 * (input_length + output_length)
```

This makes precompile reads very cheap (typically 3,000-5,000 gas).

### Usage in Solidity

```solidity
// Using the L1Read contract from hyper-evm-lib
import {L1Read} from "hyper-evm-lib/L1Read.sol";

contract CreditOracle {
    // Read oracle price for an asset
    function getOraclePrice(uint32 assetIndex) external view returns (uint256) {
        // staticcall to precompile at 0x0804
        (bool success, bytes memory data) = address(0x0804).staticcall(
            abi.encode(assetIndex)
        );
        require(success, "Oracle read failed");
        return abi.decode(data, (uint256));
    }

    // Read a user's perp position
    function getPerpsPosition(address user, uint32 assetIndex) external view returns (int256) {
        (bool success, bytes memory data) = address(0x0800).staticcall(
            abi.encode(user, assetIndex)
        );
        require(success, "Position read failed");
        return abi.decode(data, (int256));
    }
}
```

### Relevance to Credit Protocol

- **Risk assessment:** Read a borrower's HyperCore positions (0x0800) and balances (0x0801) to assess creditworthiness before approving a loan.
- **Vault NAV:** Read vault equity (0x0802) for accurate share pricing in an ERC-4626 vault.
- **Oracle prices:** Use HyperCore oracle prices (0x0804) for collateral valuation without needing Chainlink or other external oracles.
- **Liquidation triggers:** Monitor position health using precompile reads.

---

## 8. USDC Movement Between HyperCore and HyperEVM

### Architecture

HyperCore and HyperEVM share the same L1 but have separate balance sheets. Tokens must be explicitly transferred between them via **system addresses**.

### System Address Formula

Every HyperCore token has a system address on the EVM side:
- First byte: `0x20`
- Remaining 19 bytes: all zeros except for the token index in big-endian

**Examples:**

| Token  | Index | System Address                                     |
| ------ | ----- | -------------------------------------------------- |
| USDC   | 0     | `0x2000000000000000000000000000000000000000`        |
| HYPE   | -     | `0x2222222222222222222222222222222222222222` (special) |

### HyperCore -> HyperEVM (Deposit to EVM)

Use `sendAsset` action on HyperCore with the system address as destination:

```
Action: sendAsset
Destination: 0x2000000000000000000000000000000000000000  (for USDC)
Amount: <amount>
```

The system then calls `transfer(recipient, amount)` on the linked ERC-20 contract, crediting the sender's EVM address.

### HyperEVM -> HyperCore (Withdraw from EVM)

Send an ERC-20 `transfer` to the system address on the EVM side:

```solidity
IERC20(USDC_ADDRESS).transfer(
    0x2000000000000000000000000000000000000000,
    amount
);
```

The Transfer event is detected by the system, and the amount is credited to the sender's HyperCore balance.

### Via CoreWriter (Programmatic)

A smart contract can also use CoreWriter to send a `sendAsset` action:

```solidity
// Transfer USDC from contract's Core balance to its EVM balance
bytes memory action = encodeSpotTransfer(
    0x2000000000000000000000000000000000000000,
    usdcAmount
);
CoreWriter(0x3333333333333333333333333333333333333333).sendRawAction(action);
```

### Timing

- **EVM -> Core:** Applied when the EVM block finalizes, before CoreWriter actions.
- **Core -> EVM:** Applied in the next EVM block after the Core action.

### Relevance to Credit Protocol

The vault needs to move USDC between HyperEVM (where the ERC-4626 vault lives and users deposit) and HyperCore (where trading/yield strategies execute). Understanding system addresses and transfer timing is critical for:
- Depositing user USDC from the vault into HyperCore for trading
- Withdrawing profits back to the EVM vault for share redemption
- Ensuring no race conditions between deposits and CoreWriter trade actions

---

## 9. Existing ERC-4626 Vaults on HyperEVM

### Lazy Summer Protocol (by Summer.fi)

- **Status:** Live on HyperEVM mainnet
- **Vault types:** USDC, USDT, USDH
- **Architecture:** ERC-4626 curated vaults that aggregate across multiple yield sources
- **Yield sources:** Felix Protocol, HyperLend, HypurrFi, Hyperbeat, Morphobeat
- **Governance:** RFC passed via Summer.fi community governance
- **TVL:** Reported ~8.9M USDT in HyperLend vault alone (varies)
- **Website:** https://blog.summer.fi/say-hello-to-hyperliquid/

### Basis Protocol

- **Status:** Built for Hyperliquid Community Hackathon
- **Architecture:** ERC-4626 vault -- users deposit USDC, receive shares
- **Strategy:** Ethena-style delta-neutral funding rate capture
  - Takes spot long + perp short positions
  - Harvests perpetual funding fees as yield
  - Fully on-chain execution via CoreWriter
- **Significance:** First Ethena-style funding fee vault built natively on Hyperliquid
- **Hackathon page:** https://taikai.network/en/hl-hackathon-organizers/hackathons/hl-hackathon/projects/cmefjcf5t00nbh6qisw749ku6/idea

### Key Takeaways for TrustVault

1. **ERC-4626 works on HyperEVM** -- both OpenZeppelin v4 and v5 implementations have been deployed successfully.
2. **CoreWriter integration is proven** -- Basis Protocol demonstrates that EVM vaults can execute HyperCore trades programmatically.
3. **Yield strategies exist** -- lending (Lazy Summer) and funding rate capture (Basis) are both viable.
4. **Our differentiation:** TrustVault is a *credit* protocol (escrow + reputation-based underwriting), not a yield aggregator. The vault holds collateral for credit lines, not for passive yield.

---

## 10. Testnet Faucet Availability

### Official Hyperliquid Testnet Faucet

- **URL:** https://app.hyperliquid-testnet.xyz/drip
- **Requirement:** Must have deposited on mainnet with the same address
- **Provides:** 1,000 mock USDC (HyperCore testnet balance)
- **Note:** This gives HyperCore testnet USDC. You must then bridge to HyperEVM via the system address.

### Community / Third-Party Faucets (for HyperEVM testnet HYPE gas)

| Faucet               | Amount         | Cooldown  | URL                                          |
| -------------------- | -------------- | --------- | -------------------------------------------- |
| Gas.zip              | 0.0025 HYPE    | 12 hours  | https://www.gas.zip/faucet/hyperevm          |
| QuickNode            | Small HYPE     | 12 hours  | https://faucet.quicknode.com/hyperliquid/testnet |
| Chainstack           | 1 HYPE         | 24 hours  | https://faucet.chainstack.com/hyperliquid-faucet |

### Getting USDC on Testnet HyperEVM

1. Claim mock USDC from the official testnet faucet (requires prior mainnet deposit).
2. Bridge USDC from HyperCore testnet to HyperEVM testnet via `sendAsset` to the USDC system address.
3. Import the testnet USDC token address in your wallet: `0xd9CBEC81df392A88AEff575E962d149d57F4d6bc`

### Limitation

The official faucet may be **suspended** periodically. If unable to get testnet tokens, fork mainnet state locally using Foundry's `--fork-url` for development.

---

## Appendix: Quick Reference

### Key Addresses

```
# Mainnet
USDC (EVM):              0xb88339CB7199b77E23DB6E890353E22632Ba630f
USDC System (Core<>EVM): 0x2000000000000000000000000000000000000000
HYPE System:             0x2222222222222222222222222222222222222222
CoreWriter:              0x3333333333333333333333333333333333333333
Perps Precompile:        0x0000000000000000000000000000000000000800
Spot Precompile:         0x0000000000000000000000000000000000000801
Vault Equity Precompile: 0x0000000000000000000000000000000000000802
Oracle Precompile:       0x0000000000000000000000000000000000000804

# Testnet
USDC (EVM):              0xd9CBEC81df392A88AEff575E962d149d57F4d6bc
```

### Recommended Dev Stack

```
Solidity:         0.8.20 with evmVersion: "paris"
Framework:        Hardhat or Foundry
OpenZeppelin:     v5.x (@openzeppelin/contracts)
HyperEVM lib:     https://github.com/hyperliquid-dev/hyper-evm-lib
Testing:          hyper-evm-lib local simulation (Foundry)
RPC (mainnet):    https://rpc.hyperliquid.xyz/evm
RPC (testnet):    https://rpc.hyperliquid-testnet.xyz/evm
Explorer:         https://hyperevmscan.io/
```

### Deployment Checklist

- [ ] Compile with `evmVersion: "paris"` to avoid PUSH0 issues
- [ ] Use slow-block mode in wallet for contract deployment (>2M gas)
- [ ] Verify USDC address matches `0xb88339CB...630f` on mainnet
- [ ] Test CoreWriter interactions with hyper-evm-lib simulation before testnet
- [ ] Ensure deployer has HYPE for gas (tiny amount needed)
- [ ] Verify contracts on HyperEVMScan after deployment
