// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ICreditOracle.sol";

/**
 * @title ReputationCreditOracle
 * @notice Credit oracle that reads from an ERC-8004 ReputationRegistry.
 *
 * Score = min(reputation_score, 100)
 * maxExposure = score * exposureMultiplier
 */
contract ReputationCreditOracle is ICreditOracle {
    IReputationRegistry public immutable reputationRegistry;
    address public immutable escrow;
    uint256 public exposureMultiplier;
    address public governance;
    address public pendingGovernance;

    uint256 public constant MIN_MULTIPLIER = 1;
    uint256 public constant MAX_MULTIPLIER = 100_000e6; // 100K USDC per score point max

    event ExposureMultiplierUpdated(uint256 oldValue, uint256 newValue);
    event GovernanceProposed(address indexed newGovernance);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    constructor(
        address _reputationRegistry,
        address _escrow,
        uint256 _exposureMultiplier
    ) {
        require(_reputationRegistry != address(0), "zero registry");
        require(_escrow != address(0), "zero escrow");
        require(_exposureMultiplier >= MIN_MULTIPLIER && _exposureMultiplier <= MAX_MULTIPLIER, "multiplier out of range");
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        escrow = _escrow;
        exposureMultiplier = _exposureMultiplier;
        governance = msg.sender;
    }

    function setExposureMultiplier(uint256 _multiplier) external onlyGovernance {
        require(_multiplier >= MIN_MULTIPLIER && _multiplier <= MAX_MULTIPLIER, "out of range");
        emit ExposureMultiplierUpdated(exposureMultiplier, _multiplier);
        exposureMultiplier = _multiplier;
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

    function getCredit(address agent) external view override returns (
        uint256 score,
        uint256 totalExposure,
        uint256 maxExposure
    ) {
        (uint256 repScore,) = reputationRegistry.getReputation(agent);
        score = repScore > 100 ? 100 : repScore;
        totalExposure = ITrustlessEscrow(escrow).exposure(agent);
        maxExposure = score * exposureMultiplier;
    }
}

interface IReputationRegistry {
    function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount);
}

interface ITrustlessEscrow {
    function exposure(address agent) external view returns (uint256);
}
