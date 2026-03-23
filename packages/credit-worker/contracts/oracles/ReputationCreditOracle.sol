// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ICreditOracle.sol";

/**
 * @title ReputationCreditOracle
 * @notice Credit oracle that reads from an ERC-8004 ReputationRegistry.
 *
 * Score = min(reputation_score, 100)
 * maxExposure = score * exposureMultiplier (e.g., score 80 * 10 = 800 USDC max)
 *
 * Reads totalExposure from the TrustlessEscrow contract directly.
 */
contract ReputationCreditOracle is ICreditOracle {
    IReputationRegistry public immutable reputationRegistry;
    address public immutable escrow;
    uint256 public exposureMultiplier; // in token units per score point
    address public deployer;

    constructor(
        address _reputationRegistry,
        address _escrow,
        uint256 _exposureMultiplier
    ) {
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        escrow = _escrow;
        exposureMultiplier = _exposureMultiplier;
        deployer = msg.sender;
    }

    function setExposureMultiplier(uint256 _multiplier) external {
        require(msg.sender == deployer, "not deployer");
        exposureMultiplier = _multiplier;
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
        return (score, totalExposure, maxExposure);
    }
}

interface IReputationRegistry {
    function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount);
}

interface ITrustlessEscrow {
    function exposure(address agent) external view returns (uint256);
}
