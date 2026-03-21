// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CreditEscrow
 * @notice Holds lender capital, issues advances to agents, and settles repayments
 *         via a waterfall: principal → fees → remainder to agent.
 *         Self-custodial: no party can withdraw arbitrary funds.
 *         Owner (the credit worker) can only issue advances from deposited capital.
 */
contract CreditEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    uint256 public totalDeposited;
    uint256 public totalAdvanced;
    uint256 public totalRepaid;
    uint256 public totalFeesEarned;
    uint256 public totalDefaultLoss;

    struct Advance {
        address agent;
        uint256 principal;
        uint256 fee;
        bool settled;
    }

    mapping(bytes32 => Advance) public advances;

    event Deposited(address indexed lender, uint256 amount);
    event AdvanceIssued(bytes32 indexed advanceId, address indexed agent, uint256 principal, uint256 fee);
    event Settled(bytes32 indexed advanceId, address indexed agent, uint256 principalRepaid, uint256 feeRepaid, uint256 agentRemainder);
    event DefaultRecorded(bytes32 indexed advanceId, address indexed agent, uint256 lossAmount);

    constructor(address _token) Ownable(msg.sender) {
        token = IERC20(_token);
    }

    /// @notice Lender deposits capital into the escrow
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        token.safeTransferFrom(msg.sender, address(this), amount);
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Available capital for new advances
    function availableFunds() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Owner issues an advance to an agent (transfers tokens from escrow to agent)
    function issueAdvance(
        bytes32 advanceId,
        address agent,
        uint256 principal,
        uint256 fee
    ) external onlyOwner nonReentrant {
        require(advances[advanceId].agent == address(0), "advance exists");
        require(principal > 0, "zero principal");
        require(token.balanceOf(address(this)) >= principal, "insufficient funds");

        advances[advanceId] = Advance({
            agent: agent,
            principal: principal,
            fee: fee,
            settled: false
        });

        totalAdvanced += principal;
        token.safeTransfer(agent, principal);

        emit AdvanceIssued(advanceId, agent, principal, fee);
    }

    /// @notice Settle an advance: agent (or anyone) sends payout, contract runs waterfall
    /// @param advanceId The advance being settled
    /// @param payoutAmount Total payout amount being sent for settlement
    function settle(
        bytes32 advanceId,
        uint256 payoutAmount
    ) external nonReentrant {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(!adv.settled, "already settled");

        // Pull payout tokens from caller (agent or client)
        token.safeTransferFrom(msg.sender, address(this), payoutAmount);

        uint256 remaining = payoutAmount;

        // Waterfall: principal first
        uint256 principalRepaid = remaining >= adv.principal ? adv.principal : remaining;
        remaining -= principalRepaid;
        totalRepaid += principalRepaid;

        // Then fees
        uint256 feeRepaid = remaining >= adv.fee ? adv.fee : remaining;
        remaining -= feeRepaid;
        totalFeesEarned += feeRepaid;

        // Remainder goes back to agent
        if (remaining > 0) {
            token.safeTransfer(adv.agent, remaining);
        }

        // Record shortfall as loss if not fully repaid
        uint256 totalDue = adv.principal + adv.fee;
        uint256 totalPaid = principalRepaid + feeRepaid;
        if (totalPaid < totalDue) {
            uint256 loss = totalDue - totalPaid;
            totalDefaultLoss += loss;
            emit DefaultRecorded(advanceId, adv.agent, loss);
        }

        adv.settled = true;
        emit Settled(advanceId, adv.agent, principalRepaid, feeRepaid, remaining);
    }

    /// @notice Read advance details
    function getAdvance(bytes32 advanceId) external view returns (
        address agent, uint256 principal, uint256 fee, bool settled
    ) {
        Advance storage adv = advances[advanceId];
        return (adv.agent, adv.principal, adv.fee, adv.settled);
    }

    /// @notice Escrow stats
    function stats() external view returns (
        uint256 _totalDeposited,
        uint256 _totalAdvanced,
        uint256 _totalRepaid,
        uint256 _totalFeesEarned,
        uint256 _totalDefaultLoss,
        uint256 _balance
    ) {
        return (totalDeposited, totalAdvanced, totalRepaid, totalFeesEarned, totalDefaultLoss, token.balanceOf(address(this)));
    }
}
