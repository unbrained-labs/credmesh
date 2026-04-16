// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../interfaces/ICreditOracle.sol";

contract MockCreditOracle is ICreditOracle {
    address public escrow;
    mapping(address => uint256) public scores;
    uint256 public exposureMultiplier = 500e6; // 500 USDC per score point

    constructor(address _escrow) {
        escrow = _escrow;
    }

    function setScore(address agent, uint256 score) external {
        scores[agent] = score;
    }

    function setEscrow(address _escrow) external {
        escrow = _escrow;
    }

    function getCredit(address agent) external view override returns (
        uint256 score, uint256 totalExposure, uint256 maxExposure
    ) {
        score = scores[agent];
        // Read exposure from the escrow contract
        (bool ok, bytes memory data) = escrow.staticcall(
            abi.encodeWithSignature("exposure(address)", agent)
        );
        totalExposure = ok ? abi.decode(data, (uint256)) : 0;
        maxExposure = score * exposureMultiplier;
    }
}
