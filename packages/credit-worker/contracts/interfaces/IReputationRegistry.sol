// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IReputationRegistry {
    function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount);
}
