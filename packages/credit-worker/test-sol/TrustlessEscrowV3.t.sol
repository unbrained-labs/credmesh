// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TrustlessEscrowV3} from "../contracts/TrustlessEscrowV3.sol";
import {MockUSDC} from "../contracts/mocks/MockUSDC.sol";
import {MockCreditOracle} from "../contracts/mocks/MockCreditOracle.sol";
import {MockReceivableOracle} from "../contracts/mocks/MockReceivableOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TrustlessEscrowV3Test is Test {
    // ─── Constants ───
    uint256 constant USDC = 1e6; // 1 USDC
    uint256 constant SHARES_UNIT = 1e12; // 1 share (6 USDC decimals + 6 offset)
    uint256 constant TIMELOCK = 300; // 5 minutes for testnet
    uint256 constant INITIAL_LP_DEPOSIT = 10_000 * USDC;
    uint256 constant ADVANCE_AMOUNT = 1_000 * USDC;
    uint256 constant FEE_BPS = 500; // 5%
    uint256 constant PROTOCOL_FEE_BPS = 1500; // 15% of advance fee
    uint256 constant MIN_CREDIT = 20;
    uint256 constant HARD_CAP = 10_000 * USDC;
    uint256 constant MAX_EXPOSURE = 100_000 * USDC;
    uint256 constant ORACLE_RATIO = 10000; // 100%
    uint256 constant ADVANCE_DURATION = 7 days;

    // ─── Actors ───
    address governance = address(this);
    address treasury = makeAddr("treasury");
    address lp1 = makeAddr("lp1");
    address lp2 = makeAddr("lp2");
    address agent = makeAddr("agent");
    address relayer = makeAddr("relayer");

    // ─── Contracts ───
    MockUSDC usdc;
    MockCreditOracle creditOracle;
    MockReceivableOracle receivableOracle;
    TrustlessEscrowV3 escrow;

    // ─── Helpers ───
    bytes32 constant JOB_ID = keccak256("job-001");
    bytes32 constant JOB_ID_2 = keccak256("job-002");

    function setUp() public {
        usdc = new MockUSDC();
        creditOracle = new MockCreditOracle(address(0)); // placeholder, set after escrow deploy
        receivableOracle = new MockReceivableOracle();

        escrow = new TrustlessEscrowV3(
            address(usdc),
            address(creditOracle),
            MIN_CREDIT,
            FEE_BPS,
            HARD_CAP,
            TIMELOCK,
            MAX_EXPOSURE,
            ADVANCE_DURATION,
            treasury,
            PROTOCOL_FEE_BPS
        );

        // Wire the mock oracle to read exposure from the real escrow
        creditOracle.setEscrow(address(escrow));

        // Register the receivable oracle with 100% advance ratio
        escrow.proposeOracleAdd(address(receivableOracle), ORACLE_RATIO);
        vm.warp(block.timestamp + TIMELOCK + 1);
        escrow.executeOracleAdd(address(receivableOracle));

        // Give agent a good credit score
        creditOracle.setScore(agent, 80);

        // Mint USDC to LPs and agent
        usdc.mint(lp1, 100_000 * USDC);
        usdc.mint(lp2, 100_000 * USDC);
        usdc.mint(agent, 100_000 * USDC);
        usdc.mint(relayer, 100_000 * USDC);
    }

    // ═════════════════════════════════════════════════════════════
    // 1. Deployment
    // ═════════════════════════════════════════════════════════════

    function test_Deployment_setsGovernance() public view {
        assertEq(escrow.governance(), governance);
    }

    function test_Deployment_setsAsset() public view {
        assertEq(escrow.asset(), address(usdc));
    }

    function test_Deployment_setsParams() public view {
        assertEq(escrow.minCreditScore(), MIN_CREDIT);
        assertEq(escrow.feeBps(), FEE_BPS);
        assertEq(escrow.hardCapPerAdvance(), HARD_CAP);
        assertEq(escrow.timelockDelay(), TIMELOCK);
        assertEq(escrow.maxExposurePerAgent(), MAX_EXPOSURE);
    }

    function test_Deployment_shareDecimalsIs12() public view {
        assertEq(escrow.decimals(), 12);
    }

    function test_Deployment_revertsZeroToken() public {
        vm.expectRevert("zero token");
        new TrustlessEscrowV3(address(0), address(creditOracle), MIN_CREDIT, FEE_BPS, HARD_CAP, TIMELOCK, MAX_EXPOSURE, ADVANCE_DURATION, treasury, PROTOCOL_FEE_BPS);
    }

    // ═════════════════════════════════════════════════════════════
    // 2. LP Lifecycle (ERC-4626)
    // ═════════════════════════════════════════════════════════════

    function test_LP_depositAndReceiveShares() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP_DEPOSIT);
        uint256 shares = escrow.deposit(INITIAL_LP_DEPOSIT, lp1);
        vm.stopPrank();

        assertGt(shares, 0, "should receive shares");
        assertEq(escrow.totalAssets(), INITIAL_LP_DEPOSIT, "totalAssets should match deposit");
        assertEq(usdc.balanceOf(address(escrow)), INITIAL_LP_DEPOSIT, "escrow should hold USDC");
    }

    function test_LP_withdrawIdleCapital() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);

        uint256 balBefore = usdc.balanceOf(lp1);
        vm.startPrank(lp1);
        escrow.withdraw(INITIAL_LP_DEPOSIT, lp1, lp1);
        vm.stopPrank();

        assertEq(usdc.balanceOf(lp1) - balBefore, INITIAL_LP_DEPOSIT, "should withdraw full deposit");
        assertEq(escrow.totalAssets(), 0, "pool should be empty");
    }

    function test_LP_maxWithdrawClampsToIdle() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 idle = INITIAL_LP_DEPOSIT - ADVANCE_AMOUNT;
        assertEq(escrow.maxWithdraw(lp1), idle, "maxWithdraw should be idle only");
    }

    function test_LP_cannotWithdrawDeployedCapital() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        vm.startPrank(lp1);
        vm.expectRevert();
        escrow.withdraw(INITIAL_LP_DEPOSIT, lp1, lp1); // full amount, but some is deployed
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════
    // 3. Advance Lifecycle (full E2E)
    // ═════════════════════════════════════════════════════════════

    function test_Advance_revertsUntrustedOracle() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        receivableOracle.register(JOB_ID, agent, ADVANCE_AMOUNT);

        vm.startPrank(agent);
        vm.expectRevert("untrusted oracle");
        escrow.requestAdvance(makeAddr("fake-oracle"), JOB_ID, ADVANCE_AMOUNT);
        vm.stopPrank();
    }

    function test_Advance_revertsLowCreditScore() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        receivableOracle.register(JOB_ID, agent, ADVANCE_AMOUNT);
        creditOracle.setScore(agent, 5); // below MIN_CREDIT=20

        vm.startPrank(agent);
        vm.expectRevert("credit score too low");
        escrow.requestAdvance(address(receivableOracle), JOB_ID, ADVANCE_AMOUNT);
        vm.stopPrank();
    }

    function test_Advance_revertsInsufficientLiquidity() public {
        // No LP deposit → no liquidity
        receivableOracle.register(JOB_ID, agent, ADVANCE_AMOUNT);

        vm.startPrank(agent);
        vm.expectRevert("insufficient liquidity");
        escrow.requestAdvance(address(receivableOracle), JOB_ID, ADVANCE_AMOUNT);
        vm.stopPrank();
    }

    function test_Advance_issuesSendsUSDCtoAgent() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);

        uint256 agentBalBefore = usdc.balanceOf(agent);
        _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);
        uint256 agentBalAfter = usdc.balanceOf(agent);

        assertEq(agentBalAfter - agentBalBefore, ADVANCE_AMOUNT, "agent should receive advance");
        assertEq(escrow.totalAdvanced(), ADVANCE_AMOUNT, "totalAdvanced should track");
        assertEq(escrow.exposure(agent), ADVANCE_AMOUNT, "exposure should track");
    }

    function test_Advance_settleWithFeeRaisesSharePrice() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);

        uint256 sharePriceBefore = escrow.convertToAssets(SHARES_UNIT);

        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        // Settle: principal 1000 + fee 50 (5% of 1000) = 1050
        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        uint256 settleAmount = ADVANCE_AMOUNT + fee;

        vm.startPrank(agent);
        usdc.approve(address(escrow), settleAmount);
        escrow.settle(advId, settleAmount);
        vm.stopPrank();

        uint256 sharePriceAfter = escrow.convertToAssets(SHARES_UNIT);
        assertGt(sharePriceAfter, sharePriceBefore, "share price should rise after fee accrual");
        assertEq(escrow.totalFeesEarned(), fee, "totalFeesEarned should track");

        uint256 expectedProtocol = (fee * PROTOCOL_FEE_BPS) / 10000;
        uint256 expectedLP = fee - expectedProtocol;
        assertEq(escrow.totalProtocolFeesEarned(), expectedProtocol, "protocol fees should track");
        assertEq(escrow.totalLPFeesEarned(), expectedLP, "LP fees should track");
        assertEq(escrow.accruedProtocolFees(), expectedProtocol, "accrued protocol fees should track");
    }

    function test_Advance_lpRedeemsAtProfit() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);

        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(escrow), ADVANCE_AMOUNT + fee);
        escrow.settle(advId, ADVANCE_AMOUNT + fee);
        vm.stopPrank();

        uint256 lpFee = fee - (fee * PROTOCOL_FEE_BPS) / 10000;

        uint256 redeemable = escrow.maxRedeem(lp1);
        vm.startPrank(lp1);
        uint256 redeemed = escrow.redeem(redeemable, lp1, lp1);
        vm.stopPrank();

        assertGt(redeemed, INITIAL_LP_DEPOSIT, "LP should redeem more than deposited (fee earned)");
        assertApproxEqAbs(redeemed, INITIAL_LP_DEPOSIT + lpFee, 2, "profit should equal LP share of fee");
    }

    // ═════════════════════════════════════════════════════════════
    // 4. Liquidation Flow
    // ═════════════════════════════════════════════════════════════

    function test_Liquidation_revertsIfNotExpired() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        vm.expectRevert("not expired");
        escrow.liquidate(advId);
    }

    function test_Liquidation_succeedsAfterExpiry() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        vm.warp(block.timestamp + 7 days + 1);
        escrow.liquidate(advId);

        assertEq(escrow.totalLiquidated(), ADVANCE_AMOUNT, "should track liquidated amount");
        assertEq(escrow.exposure(agent), 0, "exposure should clear");
    }

    function test_Liquidation_dropsSharePrice() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);

        uint256 sharePriceBefore = escrow.convertToAssets(SHARES_UNIT);

        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        vm.warp(block.timestamp + 7 days + 1);
        escrow.liquidate(advId);

        uint256 sharePriceAfter = escrow.convertToAssets(SHARES_UNIT);
        assertLt(sharePriceAfter, sharePriceBefore, "share price should drop after liquidation");
    }

    function test_Liquidation_lpAbsorbsLossProRata() public {
        _lpDeposit(lp1, 5_000 * USDC);
        _lpDeposit(lp2, 5_000 * USDC);

        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        vm.warp(block.timestamp + 7 days + 1);
        escrow.liquidate(advId);

        // Each LP holds 50% of shares, should see 50% of the 1000 loss
        uint256 lp1Max = escrow.maxWithdraw(lp1);
        uint256 lp2Max = escrow.maxWithdraw(lp2);
        uint256 expectedPerLp = (10_000 * USDC - ADVANCE_AMOUNT) / 2;

        // Allow 1 wei rounding tolerance
        assertApproxEqAbs(lp1Max, expectedPerLp, 1, "lp1 absorbs half the loss");
        assertApproxEqAbs(lp2Max, expectedPerLp, 1, "lp2 absorbs half the loss");
    }

    // ═════════════════════════════════════════════════════════════
    // 5. Pull-over-Push Settle (remainder handling)
    // ═════════════════════════════════════════════════════════════

    function test_PullSettle_accumulatesRemainder() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        uint256 overpayment = 500 * USDC;
        uint256 settleAmount = ADVANCE_AMOUNT + fee + overpayment;

        vm.startPrank(agent);
        usdc.approve(address(escrow), settleAmount);
        escrow.settle(advId, settleAmount);
        vm.stopPrank();

        assertEq(escrow.unclaimedRemainders(agent), overpayment, "remainder should be tracked");
        assertEq(escrow.totalUnclaimedRemainders(), overpayment, "aggregate should track");
    }

    function test_PullSettle_agentClaimsRemainder() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        uint256 overpayment = 500 * USDC;

        vm.startPrank(agent);
        usdc.approve(address(escrow), ADVANCE_AMOUNT + fee + overpayment);
        escrow.settle(advId, ADVANCE_AMOUNT + fee + overpayment);
        vm.stopPrank();

        uint256 balBefore = usdc.balanceOf(agent);
        vm.prank(agent);
        escrow.claimRemainder();
        uint256 balAfter = usdc.balanceOf(agent);

        assertEq(balAfter - balBefore, overpayment, "agent should receive the remainder");
        assertEq(escrow.unclaimedRemainders(agent), 0, "remainder should be cleared");
        assertEq(escrow.totalUnclaimedRemainders(), 0, "aggregate should be zero");
    }

    function test_PullSettle_revertsNothingToClaim() public {
        vm.prank(agent);
        vm.expectRevert("nothing to claim");
        escrow.claimRemainder();
    }

    function test_PullSettle_remainderExcludedFromTotalAssets() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        uint256 overpayment = 500 * USDC;

        vm.startPrank(agent);
        usdc.approve(address(escrow), ADVANCE_AMOUNT + fee + overpayment);
        escrow.settle(advId, ADVANCE_AMOUNT + fee + overpayment);
        vm.stopPrank();

        uint256 protocolCut = (fee * PROTOCOL_FEE_BPS) / 10000;
        uint256 lpFee = fee - protocolCut;
        assertEq(escrow.totalAssets(), INITIAL_LP_DEPOSIT + lpFee, "unclaimed remainder and protocol fees must not inflate totalAssets");
    }

    // ═════════════════════════════════════════════════════════════
    // 6. First-Depositor Inflation Attack
    // ═════════════════════════════════════════════════════════════

    function test_InflationAttack_economicallyInfeasible() public {
        // Attacker deposits 1 wei of USDC
        address attacker = makeAddr("attacker");
        usdc.mint(attacker, 1_000_001 * USDC);

        vm.startPrank(attacker);
        usdc.approve(address(escrow), 1);
        escrow.deposit(1, attacker);
        vm.stopPrank();

        // Attacker donates 1000 USDC directly to inflate share price
        vm.prank(attacker);
        usdc.transfer(address(escrow), 1_000 * USDC);

        // Victim deposits 999 USDC
        address victim = makeAddr("victim");
        usdc.mint(victim, 1_000 * USDC);
        vm.startPrank(victim);
        usdc.approve(address(escrow), 999 * USDC);
        uint256 victimShares = escrow.deposit(999 * USDC, victim);
        vm.stopPrank();

        // With _decimalsOffset=6, the victim should still get a meaningful
        // amount of shares. Without offset, they'd get 0 shares.
        assertGt(victimShares, 0, "victim must receive shares (inflation attack mitigated)");

        // Victim should be able to redeem close to their deposit (minus rounding)
        uint256 victimAssets = escrow.convertToAssets(victimShares);
        assertGt(victimAssets, 990 * USDC, "victim should retain >99% of deposit value");
    }

    // ═════════════════════════════════════════════════════════════
    // 7. Idle-Only Withdrawal (full cycle)
    // ═════════════════════════════════════════════════════════════

    function test_IdleOnly_fullCycle() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);

        bytes32 advId = _issueAdvance(agent, JOB_ID, 8_000 * USDC);

        assertEq(escrow.maxWithdraw(lp1), 2_000 * USDC, "only idle 2000 available");

        uint256 fee = (8_000 * USDC * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(escrow), 8_000 * USDC + fee);
        escrow.settle(advId, 8_000 * USDC + fee);
        vm.stopPrank();

        uint256 lpFee = fee - (fee * PROTOCOL_FEE_BPS) / 10000;
        uint256 maxNow = escrow.maxWithdraw(lp1);
        assertApproxEqAbs(maxNow, INITIAL_LP_DEPOSIT + lpFee, 2, "full amount + LP fee available after settle");

        uint256 redeemable = escrow.maxRedeem(lp1);
        vm.startPrank(lp1);
        uint256 redeemed = escrow.redeem(redeemable, lp1, lp1);
        vm.stopPrank();

        assertApproxEqAbs(redeemed, INITIAL_LP_DEPOSIT + lpFee, 2, "LP exits with profit");
    }

    // ═════════════════════════════════════════════════════════════
    // 8. Governance Timelock
    // ═════════════════════════════════════════════════════════════

    function test_Governance_revertsEarlyExecute() public {
        address newOracle = makeAddr("newOracle");
        escrow.proposeOracleAdd(newOracle, 5000);

        vm.expectRevert("timelock active");
        escrow.executeOracleAdd(newOracle);
    }

    function test_Governance_executesAfterTimelock() public {
        address newOracle = makeAddr("newOracle");
        escrow.proposeOracleAdd(newOracle, 5000);

        vm.warp(block.timestamp + TIMELOCK + 1);
        escrow.executeOracleAdd(newOracle);

        assertEq(escrow.oracleAdvanceRatioBps(newOracle), 5000, "oracle should be registered");
    }

    function test_Governance_revertsNonGovernance() public {
        vm.prank(lp1);
        vm.expectRevert("not governance");
        escrow.proposeOracleAdd(makeAddr("oracle"), 5000);
    }

    function test_Governance_timelockRemoveOracle() public {
        // V3: removeOracle is now timelocked (was instant in V2)
        escrow.proposeOracleRemove(address(receivableOracle));

        vm.expectRevert("timelock active");
        escrow.executeOracleRemove(address(receivableOracle));

        vm.warp(block.timestamp + TIMELOCK + 1);
        escrow.executeOracleRemove(address(receivableOracle));

        assertEq(escrow.oracleAdvanceRatioBps(address(receivableOracle)), 0, "oracle removed");
    }

    // ═════════════════════════════════════════════════════════════
    // 9. Edge Cases
    // ═════════════════════════════════════════════════════════════

    function test_Edge_zeroDepositMintsZeroShares() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), 0);
        uint256 shares = escrow.deposit(0, lp1);
        vm.stopPrank();
        assertEq(shares, 0, "zero deposit should mint zero shares");
    }

    function test_Edge_settleAlreadySettledReverts() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 settleAmt = ADVANCE_AMOUNT + (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(escrow), settleAmt * 2);
        escrow.settle(advId, settleAmt);

        vm.expectRevert("already settled");
        escrow.settle(advId, settleAmt);
        vm.stopPrank();
    }

    function test_Edge_liquidateNonExpiredReverts() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        vm.expectRevert("not expired");
        escrow.liquidate(advId);
    }

    function test_Edge_rescueTokenWorks() public {
        MockUSDC otherToken = new MockUSDC();
        otherToken.mint(address(escrow), 1_000 * USDC);

        escrow.rescueToken(address(otherToken), governance, 1_000 * USDC);
        assertEq(otherToken.balanceOf(governance), 1_000 * USDC, "should rescue non-vault token");
    }

    function test_Edge_rescueTokenRevertsForVaultAsset() public {
        vm.expectRevert("cannot rescue vault asset");
        escrow.rescueToken(address(usdc), governance, 1);
    }

    function test_Edge_cancelGovernanceRevertsIfNoPending() public {
        vm.expectRevert("no pending proposal");
        escrow.cancelGovernanceProposal();
    }

    function test_Edge_resetReceivableAfterSettle() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 settleAmt = ADVANCE_AMOUNT + (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(escrow), settleAmt);
        escrow.settle(advId, settleAmt);
        vm.stopPrank();

        // Receivable should be marked as used
        assertTrue(escrow.usedReceivables(JOB_ID), "receivable should be used");

        // Reset it
        escrow.resetReceivable(advId);
        assertFalse(escrow.usedReceivables(JOB_ID), "receivable should be cleared");
    }

    // ═════════════════════════════════════════════════════════════
    // 10. Invariant Checks (documented properties)
    // ═════════════════════════════════════════════════════════════

    function test_Invariant_totalAssetsEquation() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 expectedOutstanding = escrow.totalAdvanced() - escrow.totalRepaid() - escrow.totalLiquidated();
        uint256 expectedAssets = usdc.balanceOf(address(escrow)) - escrow.totalUnclaimedRemainders() - escrow.accruedProtocolFees() + expectedOutstanding;
        assertEq(escrow.totalAssets(), expectedAssets, "totalAssets = idle - unclaimed - protocolFees + outstanding");

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(escrow), ADVANCE_AMOUNT + fee);
        escrow.settle(advId, ADVANCE_AMOUNT + fee);
        vm.stopPrank();

        expectedOutstanding = escrow.totalAdvanced() - escrow.totalRepaid() - escrow.totalLiquidated();
        expectedAssets = usdc.balanceOf(address(escrow)) - escrow.totalUnclaimedRemainders() - escrow.accruedProtocolFees() + expectedOutstanding;
        assertEq(escrow.totalAssets(), expectedAssets, "equation holds after settle");
    }

    function test_Invariant_maxWithdrawNeverExceedsIdle() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        _lpDeposit(lp2, 5_000 * USDC);
        _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 idle = usdc.balanceOf(address(escrow)) - escrow.totalUnclaimedRemainders() - escrow.accruedProtocolFees();
        assertLe(escrow.maxWithdraw(lp1), idle, "lp1 maxWithdraw <= idle");
        assertLe(escrow.maxWithdraw(lp2), idle, "lp2 maxWithdraw <= idle");
    }

    // ═════════════════════════════════════════════════════════════
    // 11. Protocol Fee Split
    // ═════════════════════════════════════════════════════════════

    function test_ProtocolFee_splitOnSettle() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        uint256 expectedProtocol = (fee * PROTOCOL_FEE_BPS) / 10000;
        uint256 expectedLP = fee - expectedProtocol;

        vm.startPrank(agent);
        usdc.approve(address(escrow), ADVANCE_AMOUNT + fee);
        escrow.settle(advId, ADVANCE_AMOUNT + fee);
        vm.stopPrank();

        assertEq(escrow.accruedProtocolFees(), expectedProtocol, "protocol fees accrued");
        assertEq(escrow.totalLPFeesEarned(), expectedLP, "LP fees tracked");
        assertEq(escrow.totalProtocolFeesEarned(), expectedProtocol, "protocol fees tracked");
        assertEq(escrow.totalAssets(), INITIAL_LP_DEPOSIT + expectedLP, "totalAssets excludes protocol cut");
    }

    function test_ProtocolFee_withdrawSendsToTreasury() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(escrow), ADVANCE_AMOUNT + fee);
        escrow.settle(advId, ADVANCE_AMOUNT + fee);
        vm.stopPrank();

        uint256 protocolCut = escrow.accruedProtocolFees();
        assertGt(protocolCut, 0, "should have protocol fees");

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        escrow.withdrawProtocolFees();
        uint256 treasuryAfter = usdc.balanceOf(treasury);

        assertEq(treasuryAfter - treasuryBefore, protocolCut, "treasury receives protocol fees");
        assertEq(escrow.accruedProtocolFees(), 0, "accrued fees cleared");
    }

    function test_ProtocolFee_withdrawRevertsNoTreasury() public {
        TrustlessEscrowV3 noTreasuryEscrow = new TrustlessEscrowV3(
            address(usdc), address(creditOracle), MIN_CREDIT, FEE_BPS,
            HARD_CAP, TIMELOCK, MAX_EXPOSURE, ADVANCE_DURATION, address(0), PROTOCOL_FEE_BPS
        );
        vm.expectRevert("no treasury set");
        noTreasuryEscrow.withdrawProtocolFees();
    }

    function test_ProtocolFee_withdrawRevertsNoFees() public {
        vm.expectRevert("no fees to withdraw");
        escrow.withdrawProtocolFees();
    }

    function test_ProtocolFee_zeroProtocolBpsMeansAllToLP() public {
        TrustlessEscrowV3 noProtocolEscrow = new TrustlessEscrowV3(
            address(usdc), address(creditOracle), MIN_CREDIT, FEE_BPS,
            HARD_CAP, TIMELOCK, MAX_EXPOSURE, ADVANCE_DURATION, treasury, 0
        );
        creditOracle.setEscrow(address(noProtocolEscrow));
        noProtocolEscrow.proposeOracleAdd(address(receivableOracle), ORACLE_RATIO);
        vm.warp(block.timestamp + TIMELOCK + 1);
        noProtocolEscrow.executeOracleAdd(address(receivableOracle));
        creditOracle.setScore(agent, 80);

        vm.startPrank(lp1);
        usdc.approve(address(noProtocolEscrow), INITIAL_LP_DEPOSIT);
        noProtocolEscrow.deposit(INITIAL_LP_DEPOSIT, lp1);
        vm.stopPrank();

        receivableOracle.register(JOB_ID, agent, ADVANCE_AMOUNT);
        vm.startPrank(agent);
        bytes32 advId = noProtocolEscrow.requestAdvance(address(receivableOracle), JOB_ID, ADVANCE_AMOUNT);
        vm.stopPrank();

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(noProtocolEscrow), ADVANCE_AMOUNT + fee);
        noProtocolEscrow.settle(advId, ADVANCE_AMOUNT + fee);
        vm.stopPrank();

        assertEq(noProtocolEscrow.accruedProtocolFees(), 0, "no protocol fees when bps=0");
        assertEq(noProtocolEscrow.totalLPFeesEarned(), fee, "all fees go to LP");
        assertEq(noProtocolEscrow.totalAssets(), INITIAL_LP_DEPOSIT + fee, "LP gets full fee");
    }

    // ═════════════════════════════════════════════════════════════
    // 12. Timelocked Protocol Fee Changes
    // ═════════════════════════════════════════════════════════════

    function test_ProtocolFee_timelockProposeBps() public {
        escrow.proposeProtocolFeeBps(2000);

        vm.expectRevert("timelock active");
        escrow.executeProtocolFeeBps();

        vm.warp(block.timestamp + TIMELOCK + 1);
        escrow.executeProtocolFeeBps();

        assertEq(escrow.protocolFeeBps(), 2000, "protocol fee bps updated");
    }

    function test_ProtocolFee_timelockRevertsTooHigh() public {
        vm.expectRevert("protocol fee too high");
        escrow.proposeProtocolFeeBps(5001);
    }

    function test_ProtocolFee_timelockProposeTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        escrow.proposeProtocolTreasury(newTreasury);

        vm.warp(block.timestamp + TIMELOCK + 1);
        escrow.executeProtocolTreasury(newTreasury);

        assertEq(escrow.protocolTreasury(), newTreasury, "treasury updated");
    }

    function test_ProtocolFee_protocolFeesExcludedFromSharePrice() public {
        _lpDeposit(lp1, INITIAL_LP_DEPOSIT);
        bytes32 advId = _issueAdvance(agent, JOB_ID, ADVANCE_AMOUNT);

        uint256 fee = (ADVANCE_AMOUNT * FEE_BPS) / 10000;
        vm.startPrank(agent);
        usdc.approve(address(escrow), ADVANCE_AMOUNT + fee);
        escrow.settle(advId, ADVANCE_AMOUNT + fee);
        vm.stopPrank();

        uint256 protocolCut = (fee * PROTOCOL_FEE_BPS) / 10000;
        uint256 lpFee = fee - protocolCut;

        uint256 redeemable = escrow.maxRedeem(lp1);
        vm.startPrank(lp1);
        uint256 redeemed = escrow.redeem(redeemable, lp1, lp1);
        vm.stopPrank();

        assertApproxEqAbs(redeemed, INITIAL_LP_DEPOSIT + lpFee, 2, "LP gets only 85% of fee");
        assertLt(redeemed, INITIAL_LP_DEPOSIT + fee, "LP does NOT get full fee");
    }

    // ═════════════════════════════════════════════════════════════
    // Internal helpers
    // ═════════════════════════════════════════════════════════════

    function _lpDeposit(address lp, uint256 amount) internal {
        vm.startPrank(lp);
        usdc.approve(address(escrow), amount);
        escrow.deposit(amount, lp);
        vm.stopPrank();
    }

    function _issueAdvance(address _agent, bytes32 jobId, uint256 amount) internal returns (bytes32) {
        receivableOracle.register(jobId, _agent, amount);

        vm.startPrank(_agent);
        bytes32 advId = escrow.requestAdvance(address(receivableOracle), jobId, amount);
        vm.stopPrank();

        return advId;
    }
}
