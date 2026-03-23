// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

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
 * Governance can:
 *   - Register/remove receivable oracles (with timelock)
 *   - Set credit oracle (with timelock)
 *   - Set credit parameters (advance ratio, min score, fee rate)
 *   - Transfer governance (2-step: propose + accept)
 *   - NOT approve or deny individual advances
 *   - NOT withdraw deposited capital
 *   - NOT pause the contract
 */
contract TrustlessEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───

    uint256 public constant TIMELOCK_DELAY = 48 hours;
    uint256 public constant MIN_CREDIT_SCORE_FLOOR = 10;
    uint256 public constant MAX_ADVANCE_RATIO_CAP = 5000; // 50%
    uint256 public constant MAX_FEE_CAP = 2500; // 25%

    // ─── Immutables ───

    IERC20 public immutable token;

    // ─── Governance (2-step transfer) ───

    address public governance;
    address public pendingGovernance;

    // ─── Parameters ───

    ICreditOracle public creditOracle;
    uint256 public maxAdvanceRatioBps;
    uint256 public minCreditScore;
    uint256 public feeBps;
    uint256 public hardCapPerAdvance; // absolute max per advance, independent of oracle

    // ─── Timelocked Changes ───

    struct PendingChange {
        address target;
        uint256 executeAfter; // 0 = no pending change
    }

    mapping(bytes32 => PendingChange) public pendingChanges;

    // ─── Oracle Registry ───

    mapping(address => bool) public trustedOracles;

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

    mapping(bytes32 => Advance) public advances;
    mapping(address => uint256) public exposure;
    mapping(bytes32 => bool) public usedReceivables;

    uint256 public totalDeposited;   // cumulative
    uint256 public totalAdvanced;    // cumulative
    uint256 public totalRepaid;
    uint256 public totalFeesEarned;

    // ─── Events ───

    event Deposited(address indexed depositor, uint256 amount);
    event AdvanceIssued(bytes32 indexed advanceId, address indexed agent, address oracle, bytes32 receivableId, uint256 principal, uint256 fee);
    event Settled(bytes32 indexed advanceId, address indexed agent, uint256 principalRepaid, uint256 feeRepaid, uint256 agentRemainder);
    event ChangeProposed(bytes32 indexed changeId, address target, uint256 executeAfter);
    event ChangeExecuted(bytes32 indexed changeId, address target);
    event ChangeCancelled(bytes32 indexed changeId);
    event GovernanceProposed(address indexed newGovernance);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);
    event ParametersUpdated(uint256 maxAdvanceRatioBps, uint256 minCreditScore, uint256 feeBps);

    // ─── Modifiers ───

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    // ─── Constructor ───

    constructor(
        address _token,
        address _creditOracle,
        uint256 _maxAdvanceRatioBps,
        uint256 _minCreditScore,
        uint256 _feeBps,
        uint256 _hardCapPerAdvance
    ) {
        require(_token != address(0), "zero token");
        require(_creditOracle != address(0), "zero oracle");
        require(_maxAdvanceRatioBps <= MAX_ADVANCE_RATIO_CAP, "ratio too high");
        require(_minCreditScore >= MIN_CREDIT_SCORE_FLOOR, "score too low");
        require(_feeBps <= MAX_FEE_CAP, "fee too high");
        require(_hardCapPerAdvance > 0, "zero cap");

        token = IERC20(_token);
        governance = msg.sender;
        creditOracle = ICreditOracle(_creditOracle);
        maxAdvanceRatioBps = _maxAdvanceRatioBps;
        minCreditScore = _minCreditScore;
        feeBps = _feeBps;
        hardCapPerAdvance = _hardCapPerAdvance;
    }

    // ─── Governance: 2-Step Transfer ───

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

    // ─── Governance: Timelocked Oracle/Credit Oracle Changes ───

    function proposeOracleAdd(address oracle) external onlyGovernance {
        bytes32 id = keccak256(abi.encodePacked("addOracle", oracle));
        pendingChanges[id] = PendingChange(oracle, block.timestamp + TIMELOCK_DELAY);
        emit ChangeProposed(id, oracle, block.timestamp + TIMELOCK_DELAY);
    }

    function executeOracleAdd(address oracle) external onlyGovernance {
        bytes32 id = keccak256(abi.encodePacked("addOracle", oracle));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        require(pc.target == oracle, "target mismatch");

        trustedOracles[oracle] = true;
        delete pendingChanges[id];
        emit ChangeExecuted(id, oracle);
    }

    function removeOracle(address oracle) external onlyGovernance {
        // Removal is immediate (prevents further advances against this oracle)
        // This is safe: it can only block new advances, not steal existing ones
        trustedOracles[oracle] = false;
    }

    function proposeCreditOracle(address newOracle) external onlyGovernance {
        require(newOracle != address(0), "zero oracle");
        bytes32 id = keccak256(abi.encodePacked("creditOracle", newOracle));
        pendingChanges[id] = PendingChange(newOracle, block.timestamp + TIMELOCK_DELAY);
        emit ChangeProposed(id, newOracle, block.timestamp + TIMELOCK_DELAY);
    }

    function executeCreditOracle(address newOracle) external onlyGovernance {
        bytes32 id = keccak256(abi.encodePacked("creditOracle", newOracle));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        require(pc.target == newOracle, "target mismatch");

        creditOracle = ICreditOracle(newOracle);
        delete pendingChanges[id];
        emit ChangeExecuted(id, newOracle);
    }

    function cancelPendingChange(bytes32 changeId) external onlyGovernance {
        delete pendingChanges[changeId];
        emit ChangeCancelled(changeId);
    }

    // ─── Governance: Parameters (immediate — bounded by caps) ───

    function setParameters(
        uint256 _maxAdvanceRatioBps,
        uint256 _minCreditScore,
        uint256 _feeBps
    ) external onlyGovernance {
        require(_maxAdvanceRatioBps <= MAX_ADVANCE_RATIO_CAP, "ratio too high");
        require(_minCreditScore >= MIN_CREDIT_SCORE_FLOOR, "score too low");
        require(_feeBps <= MAX_FEE_CAP, "fee too high");
        maxAdvanceRatioBps = _maxAdvanceRatioBps;
        minCreditScore = _minCreditScore;
        feeBps = _feeBps;
        emit ParametersUpdated(_maxAdvanceRatioBps, _minCreditScore, _feeBps);
    }

    function setHardCap(uint256 _hardCap) external onlyGovernance {
        require(_hardCap > 0, "zero cap");
        hardCapPerAdvance = _hardCap;
    }

    // ─── Anyone: Deposit Capital ───

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        token.safeTransferFrom(msg.sender, address(this), amount);
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    // ─── Anyone: Request Advance (if on-chain conditions pass) ───

    function requestAdvance(
        address oracle,
        bytes32 receivableId,
        uint256 requestedAmount
    ) external nonReentrant returns (bytes32 advanceId) {
        require(trustedOracles[oracle], "untrusted oracle");
        require(requestedAmount > 0, "zero amount");
        require(requestedAmount <= hardCapPerAdvance, "exceeds hard cap");

        // Verify receivable
        (bool exists, address beneficiary, uint256 amount, bool settled) =
            IReceivableOracle(oracle).getReceivable(receivableId);
        require(exists, "receivable not found");
        require(!settled, "receivable already settled");
        require(beneficiary == msg.sender, "not your receivable");
        require(!usedReceivables[receivableId], "receivable already used");

        // Amount within ratio
        uint256 maxAdvance = (amount * maxAdvanceRatioBps) / 10000;
        require(requestedAmount <= maxAdvance, "exceeds advance ratio");

        // Update exposure BEFORE credit check (prevents TOCTOU race)
        exposure[msg.sender] += requestedAmount;

        // Credit check (reads updated exposure)
        (uint256 score,, uint256 maxExposure) = creditOracle.getCredit(msg.sender);
        require(score >= minCreditScore, "credit score too low");
        require(exposure[msg.sender] <= maxExposure, "exposure limit exceeded");

        // Sufficient liquidity
        require(token.balanceOf(address(this)) >= requestedAmount, "insufficient liquidity");

        // Calculate fee
        uint256 fee = (requestedAmount * feeBps) / 10000;

        // Create advance
        advanceId = keccak256(abi.encodePacked(msg.sender, oracle, receivableId, block.timestamp, block.prevrandao));
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
        totalAdvanced += requestedAmount;

        // Transfer tokens to agent
        token.safeTransfer(msg.sender, requestedAmount);

        emit AdvanceIssued(advanceId, msg.sender, oracle, receivableId, requestedAmount, fee);
    }

    // ─── Agent or Funder: Settle Advance ───

    function settle(bytes32 advanceId, uint256 payoutAmount) external nonReentrant {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(!adv.settled, "already settled");
        // Must repay at least the principal
        require(payoutAmount >= adv.principal, "must repay at least principal");

        // Pull payout tokens
        token.safeTransferFrom(msg.sender, address(this), payoutAmount);

        uint256 remaining = payoutAmount;

        // Waterfall: principal first
        uint256 principalRepaid = adv.principal;
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
}
