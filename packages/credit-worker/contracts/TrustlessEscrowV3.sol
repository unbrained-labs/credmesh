// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IReceivableOracle.sol";
import "./interfaces/ICreditOracle.sol";

/**
 * @title TrustlessEscrowV3
 * @notice Non-custodial credit escrow with ERC-4626 LP vault.
 *
 * LPs deposit USDC via standard ERC-4626 (deposit/mint/withdraw/redeem).
 * Share price accrues fees automatically as advances settle.
 * Withdrawals are idle-only: LPs can redeem up to the contract's current
 * USDC balance (capital deployed in active advances is not withdrawable
 * until it returns via settle or is written off via liquidate).
 *
 * Advances are issued automatically when on-chain conditions are met.
 * No operator approval needed.
 *
 * Governance can:
 *   - Register/remove receivable oracles with per-oracle advance ratio (timelocked)
 *   - Set credit oracle (timelocked)
 *   - Set credit parameters (timelocked)
 *   - Transfer governance (2-step with timeout)
 *   - NOT approve or deny individual advances
 *   - NOT withdraw LP capital
 *   - NOT pause the contract
 *
 * Trust assumptions:
 *   - USDC is pausable by Circle. If paused, all operations stall.
 *   - USDC is blacklistable. A blacklisted LP cannot redeem shares.
 *   - USDC is upgradeable. Future implementation changes are a risk.
 *
 * @dev Inherits OpenZeppelin ERC4626 v5.1+ with _decimalsOffset=6 to
 *      mitigate the first-depositor inflation attack (share decimals = 12).
 */
contract TrustlessEscrowV3 is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───

    uint256 public constant MAX_ADVANCE_RATIO_CAP = 10000; // 100%
    uint256 public constant MAX_FEE_CAP = 2500; // 25%
    uint256 public constant MAX_PROTOCOL_FEE_CAP = 5000; // 50% of advance fee
    uint256 public constant MIN_CREDIT_SCORE_FLOOR = 10;
    uint256 public constant GOVERNANCE_ACCEPT_WINDOW = 7 days;

    // ─── Immutables ───

    uint256 public immutable timelockDelay;

    // ─── Governance ───

    address public governance;
    address public pendingGovernance;
    uint256 public governanceProposedAt;

    // ─── Parameters ───

    ICreditOracle public creditOracle;
    uint256 public minCreditScore;
    uint256 public feeBps;
    uint256 public hardCapPerAdvance;
    uint256 public maxExposurePerAgent;
    uint256 public advanceDuration;

    // ─── Protocol Fee Split ───

    address public protocolTreasury;
    uint256 public protocolFeeBps;
    uint256 public accruedProtocolFees;

    // ─── Timelocked Changes ───

    struct PendingChange {
        address target;
        uint256 value;
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
    uint256 public pendingMaxExposure;
    uint256 public pendingMaxExposureExecuteAfter;
    uint256 public pendingProtocolFeeBps;
    uint256 public pendingProtocolFeeBpsExecuteAfter;

    // ─── Oracle Registry ───

    mapping(address => uint256) public oracleAdvanceRatioBps;

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

    // ─── Accounting ───

    uint256 public totalAdvanced;
    uint256 public totalRepaid;
    uint256 public totalLPFeesEarned;
    uint256 public totalProtocolFeesEarned;
    uint256 public totalLiquidated;
    uint256 private _advanceNonce;

    // ─── Unclaimed Remainders (pull-over-push for blacklist safety) ───

    mapping(address => uint256) public unclaimedRemainders;
    uint256 public totalUnclaimedRemainders;

    // ─── Events ───

    event AdvanceIssued(
        bytes32 indexed advanceId, address indexed agent, address oracle,
        bytes32 receivableId, uint256 principal, uint256 fee
    );
    event Settled(
        bytes32 indexed advanceId, address indexed agent,
        uint256 principalRepaid, uint256 feeRepaid, uint256 agentRemainder
    );
    event Liquidated(
        bytes32 indexed advanceId, address indexed agent,
        address indexed liquidator, uint256 principal
    );
    event OracleAdded(address indexed oracle, uint256 advanceRatioBps);
    event OracleRemoved(address indexed oracle);
    event OracleRatioUpdated(address indexed oracle, uint256 oldRatio, uint256 newRatio);
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
    event MaxExposureProposed(uint256 newExposure, uint256 executeAfter);
    event MaxExposureUpdated(uint256 oldExposure, uint256 newExposure);
    event ProtocolFeeBpsProposed(uint256 newBps, uint256 executeAfter);
    event ProtocolFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event ProtocolTreasuryUpdated(address oldTreasury, address newTreasury);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);

    // ─── Modifiers ───

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    // ─── Constructor ───

    /// @param _timelockDelay Short (30s) for testnet, long (172800s) for mainnet.
    ///        A value of 1 is allowed but functionally no timelock.
    constructor(
        address _token,
        address _creditOracle,
        uint256 _minCreditScore,
        uint256 _feeBps,
        uint256 _hardCapPerAdvance,
        uint256 _timelockDelay,
        uint256 _maxExposurePerAgent,
        uint256 _advanceDuration,
        address _protocolTreasury,
        uint256 _protocolFeeBps
    )
        ERC4626(IERC20(_token))
        ERC20("CredMesh Shares", "cmCREDIT")
    {
        require(_token != address(0), "zero token");
        require(_creditOracle != address(0), "zero oracle");
        require(_minCreditScore >= MIN_CREDIT_SCORE_FLOOR, "score too low");
        require(_feeBps <= MAX_FEE_CAP, "fee too high");
        require(_hardCapPerAdvance > 0, "zero cap");
        require(_timelockDelay >= 1, "zero delay");
        require(_maxExposurePerAgent > 0, "zero max exposure");
        require(_advanceDuration >= 1 hours, "duration too short");
        require(_advanceDuration <= 365 days, "duration too long");
        require(_protocolFeeBps <= MAX_PROTOCOL_FEE_CAP, "protocol fee too high");

        timelockDelay = _timelockDelay;
        governance = msg.sender;
        creditOracle = ICreditOracle(_creditOracle);
        minCreditScore = _minCreditScore;
        feeBps = _feeBps;
        hardCapPerAdvance = _hardCapPerAdvance;
        maxExposurePerAgent = _maxExposurePerAgent;
        advanceDuration = _advanceDuration;
        protocolTreasury = _protocolTreasury;
        protocolFeeBps = _protocolFeeBps;

        emit GovernanceTransferred(address(0), msg.sender);
        emit ParametersUpdated(_minCreditScore, _feeBps);
        emit HardCapUpdated(0, _hardCapPerAdvance);
        emit MaxExposureUpdated(0, _maxExposurePerAgent);
        emit AdvanceDurationUpdated(0, _advanceDuration);
        emit ProtocolFeeBpsUpdated(0, _protocolFeeBps);
        if (_protocolTreasury != address(0)) {
            emit ProtocolTreasuryUpdated(address(0), _protocolTreasury);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ERC-4626 Overrides
    // ═══════════════════════════════════════════════════════════════

    /// @dev 6 extra decimals of precision on shares (12 total for USDC).
    /// Mitigates the first-depositor inflation attack — an attacker would
    /// need ~10^12 wei (1M USDC) of donations to meaningfully skew the
    /// share price by 1 wei.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Fees from settled advances are already in the balance (share price
    /// rises automatically). Liquidated principal is subtracted from outstanding
    /// (share price drops — LPs absorb losses pro-rata).
    function totalAssets() public view override returns (uint256) {
        return _idleBalance() + outstandingPrincipal();
    }

    /// @dev Idle-only: capital deployed in active advances is not withdrawable
    /// until it returns via settle or is written off via liquidate.
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 ownerAssets = convertToAssets(balanceOf(owner));
        uint256 idle = _idleBalance();
        return ownerAssets < idle ? ownerAssets : idle;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return convertToShares(maxWithdraw(owner));
    }

    /// @dev [H-01] Defense-in-depth: nonReentrant on all ERC-4626 entry points.
    /// USDC has no hooks, but the constructor accepts any ERC20 address.
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    // ═══════════════════════════════════════════════════════════════
    // View Helpers
    // ═══════════════════════════════════════════════════════════════

    function totalFeesEarned() external view returns (uint256) {
        return totalLPFeesEarned + totalProtocolFeesEarned;
    }

    function outstandingPrincipal() public view returns (uint256) {
        return totalAdvanced - totalRepaid - totalLiquidated;
    }

    function utilizationBps() external view returns (uint256) {
        uint256 total = totalAssets();
        if (total == 0) return 0;
        return (outstandingPrincipal() * 10000) / total;
    }

    function availableLiquidity() external view returns (uint256) {
        return _idleBalance();
    }

    function _idleBalance() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - totalUnclaimedRemainders - accruedProtocolFees;
    }

    // ═══════════════════════════════════════════════════════════════
    // Governance: 2-Step Transfer (with timeout + cancel)
    // ═══════════════════════════════════════════════════════════════

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
        require(pendingGovernance != address(0), "no pending proposal");
        emit GovernanceCancelled(pendingGovernance);
        pendingGovernance = address(0);
        governanceProposedAt = 0;
    }

    // ═══════════════════════════════════════════════════════════════
    // Governance: Timelocked Oracle Changes
    // ═══════════════════════════════════════════════════════════════

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
        oracleAdvanceRatioBps[oracle] = pc.value;
        delete pendingChanges[id];
        emit OracleAdded(oracle, pc.value);
        emit ChangeExecuted(id, oracle);
    }

    function proposeOracleRemove(address oracle) external onlyGovernance {
        require(oracle != address(0), "zero oracle");
        require(oracleAdvanceRatioBps[oracle] > 0, "oracle not registered");
        bytes32 id = keccak256(abi.encode("removeOracle", oracle));
        pendingChanges[id] = PendingChange(oracle, 0, block.timestamp + timelockDelay);
        emit ChangeProposed(id, oracle, 0, block.timestamp + timelockDelay);
    }

    function executeOracleRemove(address oracle) external onlyGovernance {
        bytes32 id = keccak256(abi.encode("removeOracle", oracle));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        require(pc.target == oracle, "target mismatch");
        oracleAdvanceRatioBps[oracle] = 0;
        delete pendingChanges[id];
        emit OracleRemoved(oracle);
        emit ChangeExecuted(id, oracle);
    }

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
        require(pendingChanges[changeId].executeAfter > 0, "nothing to cancel");
        address target = pendingChanges[changeId].target;
        delete pendingChanges[changeId];
        emit ChangeCancelled(changeId, target);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyGovernance {
        require(token != asset(), "cannot rescue vault asset");
        require(to != address(0), "zero recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════
    // Governance: Timelocked Parameters
    // ═══════════════════════════════════════════════════════════════

    function proposeParameters(uint256 _minCreditScore, uint256 _feeBps) external onlyGovernance {
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

    function proposeMaxExposure(uint256 _maxExposure) external onlyGovernance {
        require(_maxExposure > 0, "zero exposure");
        pendingMaxExposure = _maxExposure;
        pendingMaxExposureExecuteAfter = block.timestamp + timelockDelay;
        emit MaxExposureProposed(_maxExposure, pendingMaxExposureExecuteAfter);
    }

    function executeMaxExposure() external onlyGovernance {
        require(pendingMaxExposureExecuteAfter > 0, "not proposed");
        require(block.timestamp >= pendingMaxExposureExecuteAfter, "timelock active");
        emit MaxExposureUpdated(maxExposurePerAgent, pendingMaxExposure);
        maxExposurePerAgent = pendingMaxExposure;
        pendingMaxExposure = 0;
        pendingMaxExposureExecuteAfter = 0;
    }

    function proposeAdvanceDuration(uint256 _duration) external onlyGovernance {
        require(_duration >= 1 hours, "duration too short");
        require(_duration <= 365 days, "duration too long");
        bytes32 id = keccak256(abi.encode("advanceDuration", _duration));
        pendingChanges[id] = PendingChange(address(0), _duration, block.timestamp + timelockDelay);
        emit ChangeProposed(id, address(0), _duration, block.timestamp + timelockDelay);
    }

    function executeAdvanceDuration(uint256 _duration) external onlyGovernance {
        bytes32 id = keccak256(abi.encode("advanceDuration", _duration));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        emit AdvanceDurationUpdated(advanceDuration, _duration);
        advanceDuration = _duration;
        delete pendingChanges[id];
        emit ChangeExecuted(id, address(0));
    }

    // ═══════════════════════════════════════════════════════════════
    // Governance: Protocol Fee Split
    // ═══════════════════════════════════════════════════════════════

    function proposeProtocolFeeBps(uint256 _protocolFeeBps) external onlyGovernance {
        require(_protocolFeeBps <= MAX_PROTOCOL_FEE_CAP, "protocol fee too high");
        pendingProtocolFeeBps = _protocolFeeBps;
        pendingProtocolFeeBpsExecuteAfter = block.timestamp + timelockDelay;
        emit ProtocolFeeBpsProposed(_protocolFeeBps, pendingProtocolFeeBpsExecuteAfter);
    }

    function executeProtocolFeeBps() external onlyGovernance {
        require(pendingProtocolFeeBpsExecuteAfter > 0, "not proposed");
        require(block.timestamp >= pendingProtocolFeeBpsExecuteAfter, "timelock active");
        emit ProtocolFeeBpsUpdated(protocolFeeBps, pendingProtocolFeeBps);
        protocolFeeBps = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;
        pendingProtocolFeeBpsExecuteAfter = 0;
    }

    function cancelPendingProtocolFeeBps() external onlyGovernance {
        require(pendingProtocolFeeBpsExecuteAfter > 0, "nothing to cancel");
        pendingProtocolFeeBps = 0;
        pendingProtocolFeeBpsExecuteAfter = 0;
    }

    function proposeProtocolTreasury(address _treasury) external onlyGovernance {
        require(_treasury != address(0), "zero treasury");
        bytes32 id = keccak256(abi.encode("protocolTreasury", _treasury));
        pendingChanges[id] = PendingChange(_treasury, 0, block.timestamp + timelockDelay);
        emit ChangeProposed(id, _treasury, 0, block.timestamp + timelockDelay);
    }

    function executeProtocolTreasury(address _treasury) external onlyGovernance {
        bytes32 id = keccak256(abi.encode("protocolTreasury", _treasury));
        PendingChange storage pc = pendingChanges[id];
        require(pc.executeAfter > 0, "not proposed");
        require(block.timestamp >= pc.executeAfter, "timelock active");
        require(pc.target == _treasury, "target mismatch");
        emit ProtocolTreasuryUpdated(protocolTreasury, _treasury);
        protocolTreasury = _treasury;
        delete pendingChanges[id];
        emit ChangeExecuted(id, _treasury);
    }

    function withdrawProtocolFees() external onlyGovernance nonReentrant {
        require(protocolTreasury != address(0), "no treasury set");
        require(accruedProtocolFees > 0, "no fees to withdraw");
        uint256 amount = accruedProtocolFees;
        accruedProtocolFees = 0;
        IERC20(asset()).safeTransfer(protocolTreasury, amount);
        emit ProtocolFeesWithdrawn(protocolTreasury, amount);
    }

    // ═══════════════════════════════════════════════════════════════
    // Public: Advance Lifecycle
    // ═══════════════════════════════════════════════════════════════

    function requestAdvance(
        address oracle,
        bytes32 receivableId,
        uint256 requestedAmount
    ) external nonReentrant returns (bytes32 advanceId) {
        uint256 ratioBps = oracleAdvanceRatioBps[oracle];
        require(ratioBps > 0, "untrusted oracle");
        require(requestedAmount > 0, "zero amount");
        require(requestedAmount <= hardCapPerAdvance, "exceeds hard cap");

        _validateReceivable(oracle, receivableId, requestedAmount, ratioBps);

        (uint256 score,, uint256 oracleMaxExposure) = creditOracle.getCredit(msg.sender);
        _updateExposureAndCheckCredit(msg.sender, requestedAmount, score, oracleMaxExposure);

        require(_idleBalance() >= requestedAmount, "insufficient liquidity");

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
        IERC20(asset()).safeTransfer(msg.sender, requestedAmount);

        emit AdvanceIssued(advanceId, msg.sender, oracle, receivableId, requestedAmount, fee);
    }

    /// @dev Excess above principal+fee goes to unclaimedRemainders —
    /// pull-over-push to avoid revert if the agent is USDC-blacklisted.
    function settle(bytes32 advanceId, uint256 payoutAmount) external nonReentrant {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(!adv.settled, "already settled");
        require(!adv.liquidated, "advance was liquidated");
        require(payoutAmount >= adv.principal + adv.fee, "must repay principal + fee");

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), payoutAmount);

        uint256 remaining = payoutAmount;
        remaining -= adv.principal;
        totalRepaid += adv.principal;

        remaining -= adv.fee;

        uint256 protocolCut = (adv.fee * protocolFeeBps) / 10000;
        uint256 lpCut = adv.fee - protocolCut;
        accruedProtocolFees += protocolCut;
        totalProtocolFeesEarned += protocolCut;
        totalLPFeesEarned += lpCut;

        if (remaining > 0) {
            unclaimedRemainders[adv.agent] += remaining;
            totalUnclaimedRemainders += remaining;
        }

        exposure[adv.agent] -= adv.principal;
        adv.settled = true;

        emit Settled(advanceId, adv.agent, adv.principal, adv.fee, remaining);
    }

    function claimRemainder() external nonReentrant {
        uint256 amount = unclaimedRemainders[msg.sender];
        require(amount > 0, "nothing to claim");
        unclaimedRemainders[msg.sender] = 0;
        totalUnclaimedRemainders -= amount;
        IERC20(asset()).safeTransfer(msg.sender, amount);
    }

    /// @dev No tokens move — principal is written off as a loss, reducing
    /// share price pro-rata for all LPs.
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

    function resetReceivable(bytes32 advanceId) external {
        Advance storage adv = advances[advanceId];
        require(adv.agent != address(0), "unknown advance");
        require(adv.settled || adv.liquidated, "advance still active");
        require(usedReceivables[adv.receivableId], "receivable not used");
        usedReceivables[adv.receivableId] = false;
    }

    // ─── Internal: Advance Validation Helpers ───

    function _validateReceivable(
        address oracle,
        bytes32 receivableId,
        uint256 requestedAmount,
        uint256 ratioBps
    ) internal view {
        (bool exists, address beneficiary, uint256 amount, bool settled) =
            IReceivableOracle(oracle).getReceivable(receivableId);
        require(exists, "receivable not found");
        require(!settled, "receivable already settled");
        require(beneficiary == msg.sender, "not your receivable");
        require(!usedReceivables[receivableId], "receivable already used");
        require(requestedAmount <= (amount * ratioBps) / 10000, "exceeds advance ratio");
    }

    function _updateExposureAndCheckCredit(address agent, uint256 requestedAmount, uint256 score, uint256 oracleMaxExposure) internal {
        exposure[agent] += requestedAmount;
        require(exposure[agent] <= maxExposurePerAgent, "exceeds max exposure per agent");
        require(score >= minCreditScore, "credit score too low");
        require(exposure[agent] <= oracleMaxExposure, "exposure limit exceeded");
    }
}
