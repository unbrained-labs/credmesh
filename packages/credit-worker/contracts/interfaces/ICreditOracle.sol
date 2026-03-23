// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICreditOracle
 * @notice On-chain credit scoring source. TrustVault reads this to decide
 *         whether an advance is safe to issue.
 *
 * Default implementation reads from an ERC-8004 ReputationRegistry.
 * Can be replaced with any on-chain scoring source.
 */
interface ICreditOracle {
    /**
     * @notice Get an agent's credit standing.
     * @param agent The agent requesting an advance
     * @return score           Credit score (0-100)
     * @return totalExposure   Current outstanding advance principal
     * @return maxExposure     Maximum allowed exposure for this agent
     */
    function getCredit(address agent) external view returns (
        uint256 score,
        uint256 totalExposure,
        uint256 maxExposure
    );
}
