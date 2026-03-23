// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IReceivableOracle.sol";
import "./interfaces/ICreditOracle.sol";

/**
 * @title TrustlessEscrow
 * @notice Non-custodial credit escrow. Advances are issued automatically
 *         when on-chain conditions are met. No operator approval needed.
 *
 * The operator (deployer) can:
 *   - Register/remove receivable oracles (which escrow sources are trusted)
 *   - Set credit parameters (advance ratio, min score, fee rate)
 *   - Set the credit oracle address
 *   - NOT approve or deny individual advances
 *   - NOT withdraw deposited capital (only LPs can, via the vault)
 *   - NOT pause the contract
 *
 * Anyone can:
 *   - Deposit capital (becomes available for advances)
 *   - Request an advance (if on-chain conditions pass)
 *   - Settle a completed receivable (triggers waterfall)
 */
contract TrustlessEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables ───

    IERC20 public immutable token;
    address public immutable deployer;

    // ─── Parameters (deployer can adjust, but cannot use to block advances) ───

    ICreditOracle public creditOracle;
    uint256 public maxAdvanceRatioBps;  // e.g., 3000 = 30% of receivable
    uint256 public minCreditScore;      // e.g., 45
    uint256 public feeBps;              // e.g., 500 = 5% flat fee

    // ─── Oracle Registry ───

    mapping(address => bool) public trustedOracles;
    address[] public oracleList;

    // ─── Advance State ───

    struct Advance {
        address agent;
        address oracle;
        bytes32 receivableId;
        uint256 principal;
        uint256 fee;
        uint256 issuedAt;
        bool settled;
    }

    mapping(bytes32 => Advance) public advances;  // advanceId => Advance
    mapping(address => uint256) public exposure;   // agent => outstanding principal
    mapping(bytes32 => bool) public usedReceivables; // receivableId => used (prevents double-advance)

    uint256 public totalDeposited;
    uint256 public totalAdvanced;
    uint256 public totalRepaid;
    uint256 public totalFeesEarned;

    // ─── Events ───

    event Deposited(address indexed depositor, uint256 amount);
    event AdvanceIssued(bytes32 indexed advanceId, address indexed agent, address oracle, bytes32 receivableId, uint256 principal, uint256 fee);
    event Settled(bytes32 indexed advanceId, address indexed agent, uint256 principalRepaid, uint256 feeRepaid, uint256 agentRemainder);
    event OracleRegistered(address indexed oracle);
    event OracleRemoved(address indexed oracle);
    event ParametersUpdated(uint256 maxAdvanceRatioBps, uint256 minCreditScore, uint256 feeBps);

    // ─── Modifiers ───

    modifier onlyDeployer() {
        require(msg.sender == deployer, "not deployer");
        _;
    }

    // ─── Constructor ───

    constructor(
        address _token,
        address _creditOracle,
        uint256 _maxAdvanceRatioBps,
        uint256 _minCreditScore,
        uint256 _feeBps
    ) {
        token = IERC20(_token);
        deployer = msg.sender;
        creditOracle = ICreditOracle(_creditOracle);
        maxAdvanceRatioBps = _maxAdvanceRatioBps;
        minCreditScore = _minCreditScore;
        feeBps = _feeBps;
    }

    // ─── Deployer: Parameter Management (cannot block individual advances) ───

    function registerOracle(address oracle) external onlyDeployer {
        require(!trustedOracles[oracle], "already registered");
        trustedOracles[oracle] = true;
        oracleList.push(oracle);
        emit OracleRegistered(oracle);
    }

    function removeOracle(address oracle) external onlyDeployer {
        require(trustedOracles[oracle], "not registered");
        trustedOracles[oracle] = false;
        emit OracleRemoved(oracle);
    }

    function setParameters(
        uint256 _maxAdvanceRatioBps,
        uint256 _minCreditScore,
        uint256 _feeBps
    ) external onlyDeployer {
        require(_maxAdvanceRatioBps <= 5000, "ratio too high"); // max 50%
        require(_feeBps <= 2500, "fee too high"); // max 25%
        maxAdvanceRatioBps = _maxAdvanceRatioBps;
        minCreditScore = _minCreditScore;
        feeBps = _feeBps;
        emit ParametersUpdated(_maxAdvanceRatioBps, _minCreditScore, _feeBps);
    }

    function setCreditOracle(address _creditOracle) external onlyDeployer {
        creditOracle = ICreditOracle(_creditOracle);
    }

    // ─── Anyone: Deposit Capital ───

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        token.safeTransferFrom(msg.sender, address(this), amount);
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    // ─── Anyone: Request Advance (if on-chain conditions pass) ───

    /**
     * @notice Request an advance against a verified on-chain receivable.
     *         No operator approval needed. The contract verifies all conditions.
     * @param oracle         Registered receivable oracle to query
     * @param receivableId   Identifier of the receivable (bounty ID, job ID, etc.)
     * @param requestedAmount How much to advance (must be ≤ maxAdvanceRatio * receivable)
     */
    function requestAdvance(
        address oracle,
        bytes32 receivableId,
        uint256 requestedAmount
    ) external nonReentrant returns (bytes32 advanceId) {
        // 1. Oracle must be trusted
        require(trustedOracles[oracle], "untrusted oracle");

        // 2. Receivable must exist, be funded, and belong to the caller
        (bool exists, address beneficiary, uint256 amount, bool settled) =
            IReceivableOracle(oracle).getReceivable(receivableId);
        require(exists, "receivable not found");
        require(!settled, "receivable already settled");
        require(beneficiary == msg.sender, "not your receivable");

        // 3. No double-advance on same receivable
        require(!usedReceivables[receivableId], "receivable already used");

        // 4. Amount within limits
        uint256 maxAdvance = (amount * maxAdvanceRatioBps) / 10000;
        require(requestedAmount <= maxAdvance, "exceeds advance ratio");
        require(requestedAmount > 0, "zero amount");

        // 5. Credit check
        (uint256 score, uint256 totalExposure, uint256 maxExposure) =
            creditOracle.getCredit(msg.sender);
        require(score >= minCreditScore, "credit score too low");
        require(totalExposure + requestedAmount <= maxExposure, "exposure limit exceeded");

        // 6. Sufficient liquidity
        require(token.balanceOf(address(this)) >= requestedAmount, "insufficient liquidity");

        // 7. Calculate fee
        uint256 fee = (requestedAmount * feeBps) / 10000;

        // 8. Create advance
        advanceId = keccak256(abi.encodePacked(msg.sender, oracle, receivableId, block.timestamp));
        advances[advanceId] = Advance({
            agent: msg.sender,
            oracle: oracle,
            receivableId: receivableId,
            principal: requestedAmount,
            fee: fee,
            issuedAt: block.timestamp,
            settled: false
        });

        usedReceivables[receivableId] = true;
        exposure[msg.sender] += requestedAmount;
        totalAdvanced += requestedAmount;

        // 9. Transfer tokens to agent
        token.safeTransfer(msg.sender, requestedAmount);

        emit AdvanceIssued(advanceId, msg.sender, oracle, receivableId, requestedAmount, fee);
    }

    // ─── Anyone: Settle Advance (repay from receivable payout) ───

    /**
     * @notice Settle an advance. Caller sends the payout amount, contract
     *         runs waterfall: principal → fees → remainder to agent.
     * @param advanceId The advance to settle
     * @param payoutAmount Total payout being sent
     */
    function settle(bytes32 advanceId, uint256 payoutAmount) external nonReentrant {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(!adv.settled, "already settled");

        // Pull payout tokens
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

        // Remainder to agent
        if (remaining > 0) {
            token.safeTransfer(adv.agent, remaining);
        }

        // Update exposure
        exposure[adv.agent] = exposure[adv.agent] >= adv.principal
            ? exposure[adv.agent] - adv.principal
            : 0;

        adv.settled = true;
        emit Settled(advanceId, adv.agent, principalRepaid, feeRepaid, remaining);
    }

    // ─── View ───

    function availableLiquidity() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function getAdvance(bytes32 advanceId) external view returns (
        address agent, address oracle, bytes32 receivableId,
        uint256 principal, uint256 fee, bool settled
    ) {
        Advance storage adv = advances[advanceId];
        return (adv.agent, adv.oracle, adv.receivableId, adv.principal, adv.fee, adv.settled);
    }

    function oracleCount() external view returns (uint256) {
        return oracleList.length;
    }
}
