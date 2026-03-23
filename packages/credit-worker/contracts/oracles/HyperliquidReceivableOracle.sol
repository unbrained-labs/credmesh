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
 * Precompile addresses:
 *   0x0801 — Spot balance (returns a user's spot token balance on HyperCore)
 *   0x0802 — Vault equity  (returns total equity of a HyperCore vault)
 *
 * Gas cost per precompile read: 2000 + 65 * (input_len + output_len)
 *
 * receivableId encoding: keccak256(abi.encode(agentAddress, assetType))
 *   assetType 0 = spot balance
 *   assetType 1 = vault equity
 *
 * Positions are ongoing (not one-shot), so settled is always false.
 */
contract HyperliquidReceivableOracle is IReceivableOracle {

    // ─── Asset type constants ───

    uint8 public constant ASSET_TYPE_SPOT  = 0;
    uint8 public constant ASSET_TYPE_VAULT = 1;

    // ─── HyperEVM read precompile addresses ───

    address private constant SPOT_PRECOMPILE  = 0x0000000000000000000000000000000000000801;
    address private constant VAULT_PRECOMPILE = 0x0000000000000000000000000000000000000802;

    // ─── Reverse lookup: receivableId -> encoded params ───

    /// @notice Maps a receivableId to the (agent, assetType) that produced it.
    ///         Must be populated via `register` before `getReceivable` returns exists=true.
    mapping(bytes32 => RegisteredAgent) public agents;

    struct RegisteredAgent {
        address agent;
        uint8   assetType;
        bool    registered;
    }

    event AgentRegistered(bytes32 indexed receivableId, address indexed agent, uint8 assetType);

    // ─── Registration ───

    /**
     * @notice Register an (agent, assetType) pair so the oracle can look it up
     *         by receivableId. Anyone can register; this is purely informational.
     */
    function register(address agent, uint8 assetType) external {
        require(agent != address(0), "zero agent");
        require(assetType <= ASSET_TYPE_VAULT, "invalid asset type");

        bytes32 id = encodeReceivableId(agent, assetType);
        if (!agents[id].registered) {
            agents[id] = RegisteredAgent({
                agent: agent,
                assetType: assetType,
                registered: true
            });
            emit AgentRegistered(id, agent, assetType);
        }
    }

    // ─── IReceivableOracle ───

    function getReceivable(bytes32 receivableId) external view override returns (
        bool   exists,
        address beneficiary,
        uint256 amount,
        bool   settled
    ) {
        RegisteredAgent storage entry = agents[receivableId];
        if (!entry.registered) {
            return (false, address(0), 0, false);
        }

        uint256 balance = _readPrecompile(entry.agent, entry.assetType);

        // exists = true only when the agent actually holds a balance
        exists      = balance > 0;
        beneficiary = entry.agent;
        amount      = balance;
        settled     = false; // positions are ongoing, never "settled"
    }

    // ─── Helper: encode receivableId ───

    /**
     * @notice Deterministically encode (agent, assetType) into a receivableId.
     * @param agent     The trading agent address on HyperCore.
     * @param assetType 0 = spot balance, 1 = vault equity.
     * @return id       The keccak256 hash used as receivableId.
     */
    function encodeReceivableId(address agent, uint8 assetType) public pure returns (bytes32 id) {
        id = keccak256(abi.encode(agent, assetType));
    }

    // ─── Internal: precompile reads ───

    /**
     * @dev Calls the appropriate HyperEVM precompile to read the agent's
     *      balance (spot) or equity (vault).
     *
     * NOTE: These staticcalls will revert on non-HyperEVM chains because
     *       the precompile addresses do not exist elsewhere.
     */
    function _readPrecompile(address agent, uint8 assetType) internal view returns (uint256) {
        address target = assetType == ASSET_TYPE_SPOT
            ? SPOT_PRECOMPILE
            : VAULT_PRECOMPILE;

        (bool success, bytes memory data) = target.staticcall(
            abi.encode(agent)
        );

        if (!success || data.length == 0) {
            return 0;
        }

        return abi.decode(data, (uint256));
    }
}
