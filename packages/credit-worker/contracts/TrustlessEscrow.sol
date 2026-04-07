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
 * Governance can:
 *   - Register/remove receivable oracles with per-oracle advance ratio (timelocked)
 *   - Set credit oracle (timelocked)
 *   - Set credit parameters (timelocked)
 *   - Transfer governance (2-step with timeout)
 *   - NOT approve or deny individual advances
 *   - NOT withdraw deposited capital
 *   - NOT pause the contract
 *
 * Per-oracle advance ratios:
 *   - Fund-locked oracles (receivable USDC locked in oracle): up to 100%
 *   - Balance-reading oracles (e.g. Hyperliquid): lower ratio (e.g. 30%)
 *   - Ratio is set at oracle registration time, changeable via timelock
 */
contract TrustlessEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───

    uint256 public constant MIN_CREDIT_SCORE_FLOOR = 10;
    uint256 public constant MAX_ADVANCE_RATIO_CAP = 10000; // 100%
    uint256 public constant MAX_FEE_CAP = 2500; // 25%
    uint256 public constant MIN_TIMELOCK_DELAY = 1 hours;
    uint256 public constant GOVERNANCE_ACCEPT_WINDOW = 7 days;

    // ─── Immutables ───

    IERC20 public immutable token;
    uint256 public immutable timelockDelay;

    // ─── Governance (2-step transfer with timeout) ───

    address public governance;
    address public pendingGovernance;
    uint256 public governanceProposedAt;

    // ─── Parameters ───

    ICreditOracle public creditOracle;
    uint256 public minCreditScore;
    uint256 public feeBps;
    uint256 public hardCapPerAdvance;
    uint256 public maxExposurePerAgent;

    // ─── Timelocked Changes ───

    struct PendingChange {
        address target;
        uint256 value;       // stores ratioBps for oracle adds
        uint256 executeAfter;
    }

    struct PendingParams {
        uint256 minCreditScore;
        uint256 feeBps;
        uint256 executeAfter;
    }

    mapping(bytes32 => PendingChange) public pendingChanges;
    PendingParams public pendingParams;
    uint256 public pendingHardCap;
    uint256 public pendingHardCapExecuteAfter;

    // ─── Oracle Registry (per-oracle advance ratio) ───

    // 0 = untrusted. >0 = trusted with this advance ratio (in bps, max 10000 = 100%)
    mapping(address => uint256) public oracleAdvanceRatioBps;

    event OracleAdded(address indexed oracle, uint256 advanceRatioBps);
    event OracleRemoved(address indexed oracle);
    event OracleRatioUpdated(address indexed oracle, uint256 oldRatio, uint256 newRatio);

    // ─── Advance State ───

    struct Advance {
        address agent;
        address oracle;
        bytes32 receivableId;
        uint256 principal;
        uint256 fee;
        uint256 issuedAt;
        uint256 expiresAt;
        bool settled;
        bool liquidated;
    }

    mapping(bytes32 => Advance) public advances;
    mapping(address => uint256) public exposure;
    mapping(bytes32 => bool) public usedReceivables;

    uint256 public advanceDuration;

    // ─── Accounting ───

    uint256 public totalDeposited;
    uint256 public totalAdvanced;
    uint256 public totalRepaid;
    uint256 public totalFeesEarned;
    uint256 public totalLiquidated;
    uint256 private _advanceNonce;

    // ─── Events ───

    event Deposited(address indexed depositor, uint256 amount);
    event AdvanceIssued(bytes32 indexed advanceId, address indexed agent, address oracle, bytes32 receivableId, uint256 principal, uint256 fee);
    event Settled(bytes32 indexed advanceId, address indexed agent, uint256 principalRepaid, uint256 feeRepaid, uint256 agentRemainder);
    event Liquidated(bytes32 indexed advanceId, address indexed agent, address indexed liquidator, uint256 principal);
    event AdvanceDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event ChangeProposed(bytes32 indexed changeId, address target, uint256 value, uint256 executeAfter);
    event ChangeExecuted(bytes32 indexed changeId, address target);
    event ChangeCancelled(bytes32 indexed changeId, address target);
    event GovernanceProposed(address indexed newGovernance);
    event GovernanceCancelled(address indexed cancelled);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);
    event ParametersProposed(uint256 minCreditScore, uint256 feeBps, uint256 executeAfter);
    event ParametersUpdated(uint256 minCreditScore, uint256 feeBps);
    event HardCapProposed(uint256 newCap, uint256 executeAfter);
    event HardCapUpdated(uint256 oldCap, uint256 newCap);
    event MaxExposureUpdated(uint256 oldExposure, uint256 newExposure);

    // ─── Modifiers ───

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    // ─── Constructor ───

    constructor(
        address _token,
        address _creditOracle,
        uint256 _minCreditScore,
        uint256 _feeBps,
        uint256 _hardCapPerAdvance,
        uint256 _timelockDelay,
        uint256 _maxExposurePerAgent
    ) {
        require(_token != address(0), "zero token");
        require(_creditOracle != address(0), "zero oracle");
        require(_minCreditScore >= MIN_CREDIT_SCORE_FLOOR, "score too low");
        require(_feeBps <= MAX_FEE_CAP, "fee too high");
        require(_hardCapPerAdvance > 0, "zero cap");
        require(_timelockDelay >= MIN_TIMELOCK_DELAY, "timelock too short");
        require(_maxExposurePerAgent > 0, "zero max exposure");

        token = IERC20(_token);
        timelockDelay = _timelockDelay;
        governance = msg.sender;
        creditOracle = ICreditOracle(_creditOracle);
        minCreditScore = _minCreditScore;
        feeBps = _feeBps;
        hardCapPerAdvance = _hardCapPerAdvance;
        maxExposurePerAgent = _maxExposurePerAgent;
        advanceDuration = 7 days;
    }

    // ─── Governance: 2-Step Transfer (with timeout + cancel) ───

    function proposeGovernance(address newGovernance) external onlyGovernance {
        require(newGovernance != address(0), "zero address");
        pendingGovernance = newGovernance;
        governanceProposedAt = block.timestamp;
        emit GovernanceProposed(newGovernance);
    }

    function acceptGovernance() external {
        require(msg.sender == pendingGovernance, "not pending");
        require(block.timestamp <= governanceProposedAt + GOVERNANCE_ACCEPT_WINDOW, "proposal expired");
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
        governanceProposedAt = 0;
    }

    function cancelGovernanceProposal() external onlyGovernance {
        emit GovernanceCancelled(pendingGovernance);
        pendingGovernance = address(0);
        governanceProposedAt = 0;
    }

    // ─── Governance: Timelocked Oracle Changes (with per-oracle ratio) ───

    function proposeOracleAdd(address oracle, uint256 ratioBps) external onlyGovernance {
        require(oracle != address(0), "zero oracle");
        require(ratioBps > 0 && ratioBps <= MAX_ADVANCE_RATIO_CAP, "invalid ratio");
        bytes32 id = keccak256(abi.encode("addOracle", oracle));
        pendingChanges[id] = PendingChange(oracle, ratioBps, block.timestamp + timelockDelay);
        emit ChangeProposed(id, oracle, ratioBps, block.timestamp + timelockDelay);
    }

    function executeOracleAdd(address oracle) external onlyGovernance {
        bytes32 id = keccak256(abi.encode("addOracle", oracle));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        require(pc.target == oracle, "target mismatch");

        uint256 ratioBps = pc.value;
        oracleAdvanceRatioBps[oracle] = ratioBps;
        delete pendingChanges[id];
        emit OracleAdded(oracle, ratioBps);
        emit ChangeExecuted(id, oracle);
    }

    function removeOracle(address oracle) external onlyGovernance {
        require(oracle != address(0), "zero oracle");
        oracleAdvanceRatioBps[oracle] = 0;
        emit OracleRemoved(oracle);
    }

    /// @notice Update an existing oracle's advance ratio (timelocked)
    function proposeOracleRatioUpdate(address oracle, uint256 newRatioBps) external onlyGovernance {
        require(oracleAdvanceRatioBps[oracle] > 0, "oracle not registered");
        require(newRatioBps > 0 && newRatioBps <= MAX_ADVANCE_RATIO_CAP, "invalid ratio");
        bytes32 id = keccak256(abi.encode("updateOracleRatio", oracle));
        pendingChanges[id] = PendingChange(oracle, newRatioBps, block.timestamp + timelockDelay);
        emit ChangeProposed(id, oracle, newRatioBps, block.timestamp + timelockDelay);
    }

    function executeOracleRatioUpdate(address oracle) external onlyGovernance {
        bytes32 id = keccak256(abi.encode("updateOracleRatio", oracle));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        require(pc.target == oracle, "target mismatch");

        uint256 oldRatio = oracleAdvanceRatioBps[oracle];
        oracleAdvanceRatioBps[oracle] = pc.value;
        delete pendingChanges[id];
        emit OracleRatioUpdated(oracle, oldRatio, pc.value);
        emit ChangeExecuted(id, oracle);
    }

    function proposeCreditOracle(address newOracle) external onlyGovernance {
        require(newOracle != address(0), "zero oracle");
        bytes32 id = keccak256(abi.encode("creditOracle", newOracle));
        pendingChanges[id] = PendingChange(newOracle, 0, block.timestamp + timelockDelay);
        emit ChangeProposed(id, newOracle, 0, block.timestamp + timelockDelay);
    }

    function executeCreditOracle(address newOracle) external onlyGovernance {
        bytes32 id = keccak256(abi.encode("creditOracle", newOracle));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        require(pc.target == newOracle, "target mismatch");

        creditOracle = ICreditOracle(newOracle);
        delete pendingChanges[id];
        emit ChangeExecuted(id, newOracle);
    }

    function cancelPendingChange(bytes32 changeId) external onlyGovernance {
        address target = pendingChanges[changeId].target;
        delete pendingChanges[changeId];
        emit ChangeCancelled(changeId, target);
    }

    // ─── Governance: Timelocked Parameters ───

    function proposeParameters(
        uint256 _minCreditScore,
        uint256 _feeBps
    ) external onlyGovernance {
        require(_minCreditScore >= MIN_CREDIT_SCORE_FLOOR, "score too low");
        require(_feeBps <= MAX_FEE_CAP, "fee too high");
        uint256 executeAfter = block.timestamp + timelockDelay;
        pendingParams = PendingParams(_minCreditScore, _feeBps, executeAfter);
        emit ParametersProposed(_minCreditScore, _feeBps, executeAfter);
    }

    function executeParameters() external onlyGovernance {
        require(pendingParams.executeAfter > 0, "not proposed");
        require(block.timestamp >= pendingParams.executeAfter, "timelock active");
        minCreditScore = pendingParams.minCreditScore;
        feeBps = pendingParams.feeBps;
        emit ParametersUpdated(pendingParams.minCreditScore, pendingParams.feeBps);
        delete pendingParams;
    }

    function proposeHardCap(uint256 _hardCap) external onlyGovernance {
        require(_hardCap > 0, "zero cap");
        pendingHardCap = _hardCap;
        pendingHardCapExecuteAfter = block.timestamp + timelockDelay;
        emit HardCapProposed(_hardCap, pendingHardCapExecuteAfter);
    }

    function executeHardCap() external onlyGovernance {
        require(pendingHardCapExecuteAfter > 0, "not proposed");
        require(block.timestamp >= pendingHardCapExecuteAfter, "timelock active");
        emit HardCapUpdated(hardCapPerAdvance, pendingHardCap);
        hardCapPerAdvance = pendingHardCap;
        pendingHardCap = 0;
        pendingHardCapExecuteAfter = 0;
    }

    function setMaxExposurePerAgent(uint256 _maxExposure) external onlyGovernance {
        require(_maxExposure > 0, "zero exposure");
        emit MaxExposureUpdated(maxExposurePerAgent, _maxExposure);
        maxExposurePerAgent = _maxExposure;
    }

    function setAdvanceDuration(uint256 _duration) external onlyGovernance {
        require(_duration >= 1 hours, "duration too short");
        require(_duration <= 365 days, "duration too long");
        emit AdvanceDurationUpdated(advanceDuration, _duration);
        advanceDuration = _duration;
    }

    // ─── Anyone: Reset Used Receivable (after advance is settled/liquidated) ───

    /**
     * @notice Clear a used receivable so the agent can borrow against a new one.
     *         Only callable when the advance backed by this receivable is settled or liquidated.
     */
    function resetReceivable(bytes32 advanceId) external {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(adv.settled || adv.liquidated, "advance still active");
        require(usedReceivables[adv.receivableId], "receivable not used");

        usedReceivables[adv.receivableId] = false;
    }

    // ─── Anyone: Liquidate Expired Advance ───

    function liquidate(bytes32 advanceId) external nonReentrant {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(!adv.settled, "already settled");
        require(!adv.liquidated, "already liquidated");
        require(block.timestamp >= adv.expiresAt, "not expired");

        adv.liquidated = true;
        totalLiquidated += adv.principal;
        exposure[adv.agent] -= adv.principal;

        emit Liquidated(advanceId, adv.agent, msg.sender, adv.principal);
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
        uint256 ratioBps = oracleAdvanceRatioBps[oracle];
        require(ratioBps > 0, "untrusted oracle");
        require(requestedAmount > 0, "zero amount");
        require(requestedAmount <= hardCapPerAdvance, "exceeds hard cap");

        // Verify receivable and check ratio in a scoped block to reduce stack depth
        {
            (bool exists, address beneficiary, uint256 amount, bool settled) =
                IReceivableOracle(oracle).getReceivable(receivableId);
            require(exists, "receivable not found");
            require(!settled, "receivable already settled");
            require(beneficiary == msg.sender, "not your receivable");
            require(!usedReceivables[receivableId], "receivable already used");
            require(requestedAmount <= (amount * ratioBps) / 10000, "exceeds advance ratio");
        }

        // Update exposure BEFORE credit check (prevents TOCTOU race)
        exposure[msg.sender] += requestedAmount;
        require(exposure[msg.sender] <= maxExposurePerAgent, "exceeds max exposure per agent");

        // Credit check
        {
            (uint256 score,, uint256 oracleMaxExposure) = creditOracle.getCredit(msg.sender);
            require(score >= minCreditScore, "credit score too low");
            require(exposure[msg.sender] <= oracleMaxExposure, "exposure limit exceeded");
        }

        // Sufficient liquidity
        require(totalDeposited + totalRepaid + totalFeesEarned - totalAdvanced >= requestedAmount, "insufficient liquidity");

        // Calculate fee and create advance
        uint256 fee = (requestedAmount * feeBps) / 10000;
        advanceId = keccak256(abi.encode(msg.sender, ++_advanceNonce));
        require(advances[advanceId].agent == address(0), "advance id collision");

        advances[advanceId] = Advance({
            agent: msg.sender,
            oracle: oracle,
            receivableId: receivableId,
            principal: requestedAmount,
            fee: fee,
            issuedAt: block.timestamp,
            expiresAt: block.timestamp + advanceDuration,
            settled: false,
            liquidated: false
        });

        usedReceivables[receivableId] = true;
        totalAdvanced += requestedAmount;
        token.safeTransfer(msg.sender, requestedAmount);

        emit AdvanceIssued(advanceId, msg.sender, oracle, receivableId, requestedAmount, fee);
    }

    // ─── Anyone: Settle Advance (must repay principal + fee) ───

    function settle(bytes32 advanceId, uint256 payoutAmount) external nonReentrant {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(!adv.settled, "already settled");
        require(!adv.liquidated, "advance was liquidated");
        require(payoutAmount >= adv.principal + adv.fee, "must repay principal + fee");

        token.safeTransferFrom(msg.sender, address(this), payoutAmount);

        uint256 remaining = payoutAmount;

        uint256 principalRepaid = adv.principal;
        remaining -= principalRepaid;
        totalRepaid += principalRepaid;

        uint256 feeRepaid = adv.fee;
        remaining -= feeRepaid;
        totalFeesEarned += feeRepaid;

        if (remaining > 0) {
            token.safeTransfer(adv.agent, remaining);
        }

        exposure[adv.agent] -= adv.principal;

        adv.settled = true;
        emit Settled(advanceId, adv.agent, principalRepaid, feeRepaid, remaining);
    }

    // ─── View ───

    function availableLiquidity() external view returns (uint256) {
        return totalDeposited + totalRepaid + totalFeesEarned - totalAdvanced;
    }

    function rawBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function getAdvance(bytes32 advanceId) external view returns (
        address agent, address oracle, bytes32 receivableId,
        uint256 principal, uint256 fee, bool settled,
        uint256 expiresAt, bool liquidated
    ) {
        Advance storage adv = advances[advanceId];
        return (adv.agent, adv.oracle, adv.receivableId, adv.principal, adv.fee, adv.settled, adv.expiresAt, adv.liquidated);
    }
}
