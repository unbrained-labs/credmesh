// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IReceivableOracle.sol";

/**
 * @title HyperliquidReceivableOracle
 * @notice Receivable oracle that reads HyperEVM precompiles to verify
 *         trading agent balances on HyperCore.
 *
 * CHAIN-SPECIFIC: Enforces deployment on HyperEVM (chain 999 or 998).
 * Precompile addresses (0x0801, 0x0802) are HyperEVM system contracts.
 *
 * Security features:
 *   - Anti-flash: balance must age MIN_BALANCE_AGE blocks before valid
 *   - Anti-griefing: confirmBalance only resets clock on HIGHER balance
 *   - Nonce-based receivable IDs: agents can borrow multiple times
 *   - Chain ID guard: reverts on wrong chain
 *   - Precompile response validation: 32-byte minimum
 *   - Balance cap: prevents overflow from malformed precompile responses
 */
contract HyperliquidReceivableOracle is IReceivableOracle {

    // ─── Constants ───

    uint8   public constant ASSET_TYPE_SPOT  = 0;
    uint8   public constant ASSET_TYPE_VAULT = 1;
    uint256 public constant MIN_BALANCE_AGE  = 300; // ~600 seconds at 2s/block (~10 min)
    uint256 public constant MAX_BALANCE_CAP  = 1e12 * 1e6; // 1 trillion USDC (sanity cap, 6 decimals)

    address private constant SPOT_PRECOMPILE  = 0x0000000000000000000000000000000000000801;
    address private constant VAULT_PRECOMPILE = 0x0000000000000000000000000000000000000802;

    // ─── State ───

    struct AgentEntry {
        address agent;
        uint8   assetType;
        uint256 nonce;           // incremented each time agent takes a new advance
        uint256 confirmedAtBlock;
        uint256 confirmedAmount;
    }

    // agent address => assetType => AgentEntry
    mapping(address => mapping(uint8 => AgentEntry)) public entries;

    event AgentRegistered(bytes32 indexed receivableId, address indexed agent, uint8 assetType, uint256 nonce);
    event BalanceConfirmed(bytes32 indexed receivableId, address indexed agent, uint256 amount, uint256 blockNumber);
    event NonceIncremented(address indexed agent, uint8 assetType, uint256 newNonce);

    // ─── Constructor (chain ID guard) ───

    constructor() {
        require(block.chainid == 999 || block.chainid == 998, "HyperEVM only");
    }

    // ─── Registration ───

    /**
     * @notice Register yourself for borrowing. Only the agent can register their own address.
     */
    function register(uint8 assetType) external {
        require(assetType <= ASSET_TYPE_VAULT, "invalid asset type");

        AgentEntry storage entry = entries[msg.sender][assetType];
        if (entry.agent == address(0)) {
            entry.agent = msg.sender;
            entry.assetType = assetType;
            // nonce starts at 0, confirmedAtBlock = 0, confirmedAmount = 0
        }

        bytes32 id = encodeReceivableId(msg.sender, assetType, entry.nonce);
        emit AgentRegistered(id, msg.sender, assetType, entry.nonce);
    }

    /**
     * @notice Increment the nonce to create a fresh receivable ID.
     *         Called after an advance is settled/liquidated so the agent can borrow again.
     *         Only the agent can increment their own nonce.
     */
    function incrementNonce(uint8 assetType) external {
        AgentEntry storage entry = entries[msg.sender][assetType];
        require(entry.agent == msg.sender, "not registered");
        entry.nonce += 1;
        // Reset confirmation for the new nonce
        entry.confirmedAtBlock = 0;
        entry.confirmedAmount = 0;
        emit NonceIncremented(msg.sender, assetType, entry.nonce);
    }

    /**
     * @notice Confirm the agent's current balance. Anti-griefing: only resets
     *         the aging clock when the balance is HIGHER than previously confirmed.
     *         Only the registered agent can confirm their own balance.
     */
    function confirmBalance(uint8 assetType) external {
        AgentEntry storage entry = entries[msg.sender][assetType];
        require(entry.agent == msg.sender, "not registered");

        uint256 balance = _readPrecompile(msg.sender, assetType);
        require(balance > 0, "zero balance");

        // Cap to prevent overflow from malformed precompile responses
        if (balance > MAX_BALANCE_CAP) balance = MAX_BALANCE_CAP;

        if (balance > entry.confirmedAmount) {
            // Balance increased — reset the clock
            entry.confirmedAtBlock = block.number;
            entry.confirmedAmount = balance;
        } else if (entry.confirmedAtBlock == 0) {
            // First confirmation — start the clock
            entry.confirmedAtBlock = block.number;
            entry.confirmedAmount = balance;
        }
        // else: balance same or lower, clock keeps ticking (anti-griefing)

        bytes32 id = encodeReceivableId(msg.sender, assetType, entry.nonce);
        emit BalanceConfirmed(id, msg.sender, entry.confirmedAmount, block.number);
    }

    // ─── IReceivableOracle ───

    function getReceivable(bytes32 receivableId) external view override returns (
        bool    exists,
        address beneficiary,
        uint256 amount,
        bool    settled
    ) {
        // Decode the receivableId to find the agent entry
        // Since we can't reverse keccak256, callers must use the correct receivableId
        // which encodes (agent, assetType, nonce). The TrustlessEscrow passes it through
        // from the agent's requestAdvance call.
        //
        // We need a way to look up the entry from receivableId.
        // Solution: store a reverse mapping.
        // For gas efficiency, the caller (agent) provides agent+assetType as part of
        // the receivableId, and we verify it matches.
        //
        // Actually, the receivableId is computed by the agent and passed to requestAdvance.
        // The escrow calls getReceivable(receivableId). We need to resolve it.
        // Since we can't reverse a hash, we use a receivableId => entry mapping.

        // This is handled by the _receivables mapping below
        _ReceivableLookup storage lookup = _receivables[receivableId];
        if (lookup.agent == address(0)) {
            return (false, address(0), 0, false);
        }

        AgentEntry storage entry = entries[lookup.agent][lookup.assetType];

        // Check this receivableId matches the current nonce
        bytes32 expectedId = encodeReceivableId(entry.agent, entry.assetType, entry.nonce);
        if (receivableId != expectedId) {
            // Old nonce — this receivable is "settled" (consumed)
            return (false, entry.agent, 0, true);
        }

        // Read current balance from precompile
        uint256 currentBalance = _readPrecompile(entry.agent, entry.assetType);

        // Anti-flash: balance must have been confirmed at least MIN_BALANCE_AGE blocks ago
        bool balanceAged = entry.confirmedAtBlock > 0
            && block.number >= entry.confirmedAtBlock + MIN_BALANCE_AGE;

        // Use the minimum of confirmed and current balance
        uint256 safeAmount = currentBalance < entry.confirmedAmount
            ? currentBalance
            : entry.confirmedAmount;

        // Cap
        if (safeAmount > MAX_BALANCE_CAP) safeAmount = MAX_BALANCE_CAP;

        exists      = balanceAged && safeAmount > 0;
        beneficiary = entry.agent;
        amount      = safeAmount;
        settled     = false; // Balance-type oracle — never "settled" in the traditional sense
    }

    // ─── Receivable ID Lookup ───

    struct _ReceivableLookup {
        address agent;
        uint8 assetType;
    }
    mapping(bytes32 => _ReceivableLookup) private _receivables;

    /**
     * @notice Compute and register the receivable ID for the current nonce.
     *         Must be called before requestAdvance so getReceivable can resolve it.
     *         Only the agent can prepare their own receivable.
     */
    function prepareReceivable(uint8 assetType) external returns (bytes32 receivableId) {
        AgentEntry storage entry = entries[msg.sender][assetType];
        require(entry.agent == msg.sender, "not registered");

        receivableId = encodeReceivableId(msg.sender, assetType, entry.nonce);
        _receivables[receivableId] = _ReceivableLookup(msg.sender, assetType);
    }

    // ─── Helpers ───

    function encodeReceivableId(address agent, uint8 assetType, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(agent, assetType, nonce));
    }

    function currentReceivableId(address agent, uint8 assetType) external view returns (bytes32) {
        return encodeReceivableId(agent, assetType, entries[agent][assetType].nonce);
    }

    function blocksUntilValid(address agent, uint8 assetType) external view returns (bool valid, uint256 blocksRemaining) {
        AgentEntry storage entry = entries[agent][assetType];
        if (entry.agent == address(0) || entry.confirmedAtBlock == 0) {
            return (false, type(uint256).max);
        }
        uint256 validAt = entry.confirmedAtBlock + MIN_BALANCE_AGE;
        if (block.number >= validAt) {
            return (true, 0);
        }
        return (false, validAt - block.number);
    }

    // ─── Internal ───

    function _readPrecompile(address agent, uint8 assetType) internal view returns (uint256) {
        address target = assetType == ASSET_TYPE_SPOT
            ? SPOT_PRECOMPILE
            : VAULT_PRECOMPILE;

        (bool success, bytes memory data) = target.staticcall(abi.encode(agent));
        if (!success || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }
}
