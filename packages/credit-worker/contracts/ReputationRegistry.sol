// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReputationRegistry
 * @notice On-chain reputation for autonomous agents. Attestors are whitelisted
 *         by governance — prevents sybil attacks on credit scoring.
 *
 * Compatible with ERC-8004 identity verification and ReputationCreditOracle.
 */
contract ReputationRegistry {
    struct Reputation {
        uint256 totalScore;
        uint256 attestationCount;
    }

    address public governance;
    address public pendingGovernance;

    mapping(address => bool) public approvedAttestors;
    mapping(address => Reputation) private _reputations;

    event AttestorAdded(address indexed attestor);
    event AttestorRemoved(address indexed attestor);
    event ReputationAdded(
        address indexed agent,
        address indexed attestor,
        uint256 score,
        string evidence
    );
    event GovernanceProposed(address indexed newGovernance);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    modifier onlyAttestor() {
        require(approvedAttestors[msg.sender], "not an approved attestor");
        _;
    }

    constructor() {
        governance = msg.sender;
        // Deployer is the first approved attestor
        approvedAttestors[msg.sender] = true;
        emit AttestorAdded(msg.sender);
    }

    // ─── Governance ───

    function addAttestor(address attestor) external onlyGovernance {
        require(attestor != address(0), "zero address");
        approvedAttestors[attestor] = true;
        emit AttestorAdded(attestor);
    }

    function removeAttestor(address attestor) external onlyGovernance {
        approvedAttestors[attestor] = false;
        emit AttestorRemoved(attestor);
    }

    function proposeGovernance(address newGovernance) external onlyGovernance {
        require(newGovernance != address(0), "zero address");
        pendingGovernance = newGovernance;
        emit GovernanceProposed(newGovernance);
    }

    function acceptGovernance() external {
        require(msg.sender == pendingGovernance, "not pending");
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
    }

    // ─── Attestation (only approved attestors) ───

    function addReputation(address agent, uint256 score, string calldata evidence) external onlyAttestor {
        require(agent != address(0), "zero agent");
        require(score <= 100, "score too high");

        Reputation storage rep = _reputations[agent];
        rep.totalScore += score;
        rep.attestationCount += 1;

        emit ReputationAdded(agent, msg.sender, score, evidence);
    }

    // ─── View ───

    function getReputation(address agent) external view returns (
        uint256 score,
        uint256 attestationCount
    ) {
        Reputation storage rep = _reputations[agent];
        attestationCount = rep.attestationCount;
        score = attestationCount > 0 ? rep.totalScore / attestationCount : 0;
    }
}
