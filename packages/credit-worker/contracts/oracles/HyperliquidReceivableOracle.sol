// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IReceivableOracle.sol";

/**
 * @title HyperliquidReceivableOracle
 * @notice Receivable oracle that reads HyperEVM precompiles to verify
 *         trading agent balances on HyperCore.
 *
 * CHAIN-SPECIFIC: This contract only works on HyperEVM (chain ID 999/998).
 * The precompile addresses (0x0801, 0x0802) are HyperEVM system contracts
 * and do not exist on other EVM chains.
 *
 * Anti-flash protection: agents must confirm their balance at least
 * MIN_BALANCE_AGE blocks before getReceivable reports exists=true.
 * This prevents flash-loan manipulation of the oracle.
 */
contract HyperliquidReceivableOracle is IReceivableOracle {

    // ─── Constants ───

    uint8   public constant ASSET_TYPE_SPOT  = 0;
    uint8   public constant ASSET_TYPE_VAULT = 1;
    uint256 public constant MIN_BALANCE_AGE  = 100; // ~200 seconds at 2s/block

    address private constant SPOT_PRECOMPILE  = 0x0000000000000000000000000000000000000801;
    address private constant VAULT_PRECOMPILE = 0x0000000000000000000000000000000000000802;

    // ─── State ───

    struct RegisteredAgent {
        address agent;
        uint8   assetType;
        bool    registered;
        uint256 confirmedAtBlock; // block when balance was first confirmed > 0
        uint256 confirmedAmount;  // balance at confirmation time
    }

    mapping(bytes32 => RegisteredAgent) public agents;

    event AgentRegistered(bytes32 indexed receivableId, address indexed agent, uint8 assetType);
    event BalanceConfirmed(bytes32 indexed receivableId, address indexed agent, uint256 amount, uint256 blockNumber);

    // ─── Registration ───

    /**
     * @notice Register an (agent, assetType) pair. Permissionless and idempotent.
     */
    function register(address agent, uint8 assetType) external {
        require(agent != address(0), "zero agent");
        require(assetType <= ASSET_TYPE_VAULT, "invalid asset type");

        bytes32 id = encodeReceivableId(agent, assetType);
        if (!agents[id].registered) {
            agents[id] = RegisteredAgent({
                agent: agent,
                assetType: assetType,
                registered: true,
                confirmedAtBlock: 0,
                confirmedAmount: 0
            });
            emit AgentRegistered(id, agent, assetType);
        }
    }

    /**
     * @notice Confirm the agent's current balance. Must be called at least
     *         MIN_BALANCE_AGE blocks before requestAdvance for the balance
     *         to be considered valid. Prevents flash-loan manipulation.
     *
     *         Anyone can call this (the balance is read from the precompile,
     *         not from the caller).
     */
    function confirmBalance(bytes32 receivableId) external {
        RegisteredAgent storage entry = agents[receivableId];
        require(entry.registered, "not registered");

        uint256 balance = _readPrecompile(entry.agent, entry.assetType);
        require(balance > 0, "zero balance");

        entry.confirmedAtBlock = block.number;
        entry.confirmedAmount = balance;
        emit BalanceConfirmed(receivableId, entry.agent, balance, block.number);
    }

    // ─── IReceivableOracle ───

    function getReceivable(bytes32 receivableId) external view override returns (
        bool    exists,
        address beneficiary,
        uint256 amount,
        bool    settled
    ) {
        RegisteredAgent storage entry = agents[receivableId];
        if (!entry.registered) {
            return (false, address(0), 0, false);
        }

        // Read current balance from precompile
        uint256 currentBalance = _readPrecompile(entry.agent, entry.assetType);

        // Anti-flash: balance must have been confirmed at least MIN_BALANCE_AGE blocks ago
        bool balanceAged = entry.confirmedAtBlock > 0
            && block.number >= entry.confirmedAtBlock + MIN_BALANCE_AGE;

        // Use the minimum of confirmed and current balance (prevents inflate-after-confirm)
        uint256 safeAmount = currentBalance < entry.confirmedAmount
            ? currentBalance
            : entry.confirmedAmount;

        exists      = balanceAged && safeAmount > 0;
        beneficiary = entry.agent;
        amount      = safeAmount;
        settled     = false;
    }

    // ─── Helper ───

    function encodeReceivableId(address agent, uint8 assetType) public pure returns (bytes32) {
        return keccak256(abi.encode(agent, assetType));
    }

    /**
     * @notice Check how many blocks until a confirmed balance becomes valid.
     * @return 0 if already valid, otherwise blocks remaining.
     */
    function blocksUntilValid(bytes32 receivableId) external view returns (uint256) {
        RegisteredAgent storage entry = agents[receivableId];
        if (!entry.registered || entry.confirmedAtBlock == 0) return type(uint256).max;
        uint256 validAt = entry.confirmedAtBlock + MIN_BALANCE_AGE;
        if (block.number >= validAt) return 0;
        return validAt - block.number;
    }

    // ─── Internal ───

    function _readPrecompile(address agent, uint8 assetType) internal view returns (uint256) {
        address target = assetType == ASSET_TYPE_SPOT
            ? SPOT_PRECOMPILE
            : VAULT_PRECOMPILE;

        (bool success, bytes memory data) = target.staticcall(abi.encode(agent));
        if (!success || data.length == 0) return 0;
        return abi.decode(data, (uint256));
    }
}
