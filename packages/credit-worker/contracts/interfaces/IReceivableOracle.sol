// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IReceivableOracle
 * @notice Any on-chain escrow or payment source can implement this to serve
 *         as a receivable oracle for TrustVault Credit.
 *
 * Examples:
 *   - Claw Earn bounty escrow on Base
 *   - Hyperliquid subaccount balance on HyperEVM
 *   - Any job/task escrow that locks funds for a worker
 *   - A marketplace that escrows client payments
 *
 * TrustVault does not depend on any specific implementation.
 * Register any oracle via TrustlessEscrow.registerOracle().
 */
interface IReceivableOracle {
    /**
     * @notice Check if a receivable exists, its value, and who benefits.
     * @param receivableId Opaque identifier (bounty ID, job ID, subaccount, etc.)
     * @return exists      Whether the receivable is real and funded
     * @return beneficiary Who gets paid when it settles (the agent/worker)
     * @return amount      How much the receivable is worth (in token units)
     * @return settled     Whether it has already been paid out
     */
    function getReceivable(bytes32 receivableId) external view returns (
        bool exists,
        address beneficiary,
        uint256 amount,
        bool settled
    );
}
