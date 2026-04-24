// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IdentityRegistry
/// @notice ERC-8004-aligned agent identity registry. Permissionless, self-sovereign.
/// @dev Each agent publishes an agent card URI (e.g., HTTPS URL to /.well-known/agent.json)
///      and the sha256 hash of the canonical card. The hash makes off-chain tampering
///      detectable: a verifier fetches the URI, canonicalizes, hashes, and compares.
contract IdentityRegistry {
    struct Agent {
        string agentCardUri;
        bytes32 agentCardHash;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    mapping(address => Agent) private _agents;

    event AgentRegistered(address indexed agent, string agentCardUri, bytes32 agentCardHash);
    event AgentUpdated(address indexed agent, string agentCardUri, bytes32 agentCardHash);
    event AgentDeregistered(address indexed agent);

    function register(string calldata agentCardUri, bytes32 agentCardHash) external {
        require(bytes(agentCardUri).length > 0, "empty uri");
        require(agentCardHash != bytes32(0), "empty hash");
        require(_agents[msg.sender].registeredAt == 0, "already registered");
        _agents[msg.sender] = Agent({
            agentCardUri: agentCardUri,
            agentCardHash: agentCardHash,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        emit AgentRegistered(msg.sender, agentCardUri, agentCardHash);
    }

    function update(string calldata agentCardUri, bytes32 agentCardHash) external {
        require(bytes(agentCardUri).length > 0, "empty uri");
        require(agentCardHash != bytes32(0), "empty hash");
        Agent storage a = _agents[msg.sender];
        require(a.registeredAt != 0, "not registered");
        a.agentCardUri = agentCardUri;
        a.agentCardHash = agentCardHash;
        a.updatedAt = uint64(block.timestamp);
        emit AgentUpdated(msg.sender, agentCardUri, agentCardHash);
    }

    function deregister() external {
        require(_agents[msg.sender].registeredAt != 0, "not registered");
        delete _agents[msg.sender];
        emit AgentDeregistered(msg.sender);
    }

    /// @notice ERC-8004 compatible reader. Empty bytes = not registered.
    /// @dev Fields encoded positionally so off-chain consumers can decode as
    ///      `(string, bytes32, uint64, uint64)` without wrapping in a tuple.
    function getAgent(address agent) external view returns (bytes memory) {
        Agent memory a = _agents[agent];
        if (a.registeredAt == 0) return bytes("");
        return abi.encode(a.agentCardUri, a.agentCardHash, a.registeredAt, a.updatedAt);
    }

    function isRegistered(address agent) external view returns (bool) {
        return _agents[agent].registeredAt != 0;
    }

    function agentInfo(address agent) external view returns (
        string memory agentCardUri,
        bytes32 agentCardHash,
        uint64 registeredAt,
        uint64 updatedAt
    ) {
        Agent memory a = _agents[agent];
        return (a.agentCardUri, a.agentCardHash, a.registeredAt, a.updatedAt);
    }
}
