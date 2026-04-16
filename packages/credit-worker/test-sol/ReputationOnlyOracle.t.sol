// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TrustlessEscrowV3} from "../contracts/TrustlessEscrowV3.sol";
import {ReputationOnlyOracle} from "../contracts/oracles/ReputationOnlyOracle.sol";
import {MockUSDC} from "../contracts/mocks/MockUSDC.sol";
import {MockCreditOracle} from "../contracts/mocks/MockCreditOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ReputationOnlyOracleTest is Test {
    uint256 constant USDC = 1e6;
    uint256 constant TIMELOCK = 300;
    uint256 constant FEE_BPS = 500;
    uint256 constant PROTOCOL_FEE_BPS = 1500;
    uint256 constant MIN_CREDIT = 20;
    uint256 constant HARD_CAP = 10_000 * USDC;
    uint256 constant MAX_EXPOSURE = 100_000 * USDC;
    uint256 constant ORACLE_RATIO = 10000;
    uint256 constant INITIAL_LP = 50_000 * USDC;
    uint256 constant ADVANCE_DURATION = 7 days;

    address governance = address(this);
    address treasury = makeAddr("treasury");
    address lp1 = makeAddr("lp1");
    address agent = makeAddr("agent");

    MockUSDC usdc;
    MockCreditOracle creditOracle;
    TrustlessEscrowV3 escrow;
    ReputationOnlyOracle repOracle;
    MockReputationRegistry repRegistry;

    function setUp() public {
        usdc = new MockUSDC();
        repRegistry = new MockReputationRegistry();
        creditOracle = new MockCreditOracle(address(0));

        escrow = new TrustlessEscrowV3(
            address(usdc), address(creditOracle), MIN_CREDIT, FEE_BPS,
            HARD_CAP, TIMELOCK, MAX_EXPOSURE, ADVANCE_DURATION, treasury, PROTOCOL_FEE_BPS
        );
        creditOracle.setEscrow(address(escrow));

        repOracle = new ReputationOnlyOracle(
            address(repRegistry), address(creditOracle), MIN_CREDIT
        );

        escrow.proposeOracleAdd(address(repOracle), ORACLE_RATIO);
        vm.warp(block.timestamp + TIMELOCK + 1);
        escrow.executeOracleAdd(address(repOracle));

        repRegistry.setReputation(agent, 80, 5);
        creditOracle.setScore(agent, 80);

        usdc.mint(lp1, 200_000 * USDC);
        usdc.mint(agent, 200_000 * USDC);
    }

    // ═════════════════════════════════════════════════════════════
    // Oracle Unit Tests
    // ═════════════════════════════════════════════════════════════

    function test_Register_createsVirtualReceivable() public {
        vm.prank(agent);
        bytes32 recId = repOracle.register();

        (bool exists, address beneficiary, uint256 amount, bool settled) = repOracle.getReceivable(recId);
        assertTrue(exists, "receivable should exist");
        assertEq(beneficiary, agent, "beneficiary should be agent");
        assertGt(amount, 0, "amount should be > 0");
        assertFalse(settled, "should not be settled");
    }

    function test_Register_revertsLowScore() public {
        repRegistry.setReputation(agent, 5, 1);
        vm.prank(agent);
        vm.expectRevert("score too low");
        repOracle.register();
    }

    function test_Register_revertsNoCreditLimit() public {
        creditOracle.setScore(agent, 0);
        repRegistry.setReputation(agent, 80, 5);
        vm.prank(agent);
        vm.expectRevert("no credit limit");
        repOracle.register();
    }

    function test_Register_incrementsNonce() public {
        vm.startPrank(agent);
        bytes32 id1 = repOracle.register();
        bytes32 id2 = repOracle.register();
        vm.stopPrank();

        assertTrue(id1 != id2, "nonce should produce unique IDs");
        assertEq(repOracle.nonces(agent), 2, "nonce should be 2");
    }

    function test_GetReceivable_readsLiveCredit() public {
        vm.prank(agent);
        bytes32 recId = repOracle.register();

        (, , uint256 amountBefore,) = repOracle.getReceivable(recId);

        creditOracle.setScore(agent, 40);

        (, , uint256 amountAfter,) = repOracle.getReceivable(recId);

        assertLt(amountAfter, amountBefore, "amount should decrease when score drops");
    }

    function test_GetReceivable_nonexistentReturnsFalse() public view {
        (bool exists,,,) = repOracle.getReceivable(bytes32(0));
        assertFalse(exists, "nonexistent receivable should return false");
    }

    // ═════════════════════════════════════════════════════════════
    // Oracle 2-Step Governance
    // ═════════════════════════════════════════════════════════════

    function test_Governance_setMinScore() public {
        repOracle.setMinScore(50);
        assertEq(repOracle.minScore(), 50, "minScore updated");
    }

    function test_Governance_twoStepTransfer() public {
        address newGov = makeAddr("newGov");
        repOracle.proposeGovernance(newGov);

        assertEq(repOracle.governance(), governance, "governance should not change yet");
        assertEq(repOracle.pendingGovernance(), newGov, "pending should be set");

        vm.prank(newGov);
        repOracle.acceptGovernance();

        assertEq(repOracle.governance(), newGov, "governance transferred");
        assertEq(repOracle.pendingGovernance(), address(0), "pending cleared");
    }

    function test_Governance_acceptRevertsWrongCaller() public {
        repOracle.proposeGovernance(makeAddr("newGov"));

        vm.prank(agent);
        vm.expectRevert("not pending");
        repOracle.acceptGovernance();
    }

    function test_Governance_acceptRevertsExpired() public {
        address newGov = makeAddr("newGov");
        repOracle.proposeGovernance(newGov);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(newGov);
        vm.expectRevert("proposal expired");
        repOracle.acceptGovernance();
    }

    function test_Governance_cancelProposal() public {
        address newGov = makeAddr("newGov");
        repOracle.proposeGovernance(newGov);
        repOracle.cancelGovernanceProposal();

        assertEq(repOracle.pendingGovernance(), address(0), "pending cleared");
    }

    function test_Governance_nonGovReverts() public {
        vm.prank(agent);
        vm.expectRevert("not governance");
        repOracle.setMinScore(50);
    }

    // ═════════════════════════════════════════════════════════════
    // E2E: Reputation-Only Advance Through Escrow
    // ═════════════════════════════════════════════════════════════

    function test_E2E_reputationOnlyAdvance() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        vm.prank(agent);
        bytes32 recId = repOracle.register();

        uint256 advanceAmount = 1_000 * USDC;
        uint256 agentBefore = usdc.balanceOf(agent);

        vm.prank(agent);
        escrow.requestAdvance(address(repOracle), recId, advanceAmount);

        uint256 agentAfter = usdc.balanceOf(agent);
        assertEq(agentAfter - agentBefore, advanceAmount, "agent received advance");
        assertEq(escrow.exposure(agent), advanceAmount, "exposure tracked");
    }

    function test_E2E_reputationAdvanceSettleWithFeeSplit() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        vm.prank(agent);
        bytes32 recId = repOracle.register();

        uint256 advanceAmount = 2_000 * USDC;
        vm.prank(agent);
        bytes32 advId = escrow.requestAdvance(address(repOracle), recId, advanceAmount);

        uint256 fee = (advanceAmount * FEE_BPS) / 10000;
        uint256 settleAmount = advanceAmount + fee;
        vm.startPrank(agent);
        usdc.approve(address(escrow), settleAmount);
        escrow.settle(advId, settleAmount);
        vm.stopPrank();

        uint256 protocolCut = (fee * PROTOCOL_FEE_BPS) / 10000;
        uint256 lpCut = fee - protocolCut;

        assertEq(escrow.accruedProtocolFees(), protocolCut, "protocol accrued");
        assertEq(escrow.totalLPFeesEarned(), lpCut, "LP fees");
        assertEq(escrow.totalAssets(), INITIAL_LP + lpCut, "totalAssets correct");

        escrow.withdrawProtocolFees();
        assertEq(usdc.balanceOf(treasury), protocolCut, "treasury received fees");
    }

    function test_E2E_reputationAdvanceLiquidate() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        vm.prank(agent);
        bytes32 recId = repOracle.register();

        uint256 advanceAmount = 1_000 * USDC;
        vm.prank(agent);
        bytes32 advId = escrow.requestAdvance(address(repOracle), recId, advanceAmount);

        vm.warp(block.timestamp + 7 days + 1);
        escrow.liquidate(advId);

        assertEq(escrow.totalLiquidated(), advanceAmount, "liquidation tracked");
        assertEq(escrow.exposure(agent), 0, "exposure cleared");
        assertEq(escrow.totalAssets(), INITIAL_LP - advanceAmount, "LPs absorb loss");
    }

    function test_E2E_multipleReputationAdvances() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        vm.startPrank(agent);
        bytes32 rec1 = repOracle.register();
        bytes32 adv1 = escrow.requestAdvance(address(repOracle), rec1, 500 * USDC);

        bytes32 rec2 = repOracle.register();
        bytes32 adv2 = escrow.requestAdvance(address(repOracle), rec2, 500 * USDC);
        vm.stopPrank();

        assertEq(escrow.exposure(agent), 1_000 * USDC, "exposure tracks both advances");

        uint256 fee1 = (500 * USDC * FEE_BPS) / 10000;
        uint256 fee2 = fee1;

        vm.startPrank(agent);
        usdc.approve(address(escrow), (500 * USDC + fee1) * 2);
        escrow.settle(adv1, 500 * USDC + fee1);
        escrow.settle(adv2, 500 * USDC + fee2);
        vm.stopPrank();

        assertEq(escrow.exposure(agent), 0, "exposure cleared after both settle");

        uint256 totalProtocol = (fee1 * PROTOCOL_FEE_BPS) / 10000 + (fee2 * PROTOCOL_FEE_BPS) / 10000;
        assertEq(escrow.accruedProtocolFees(), totalProtocol, "protocol fees from both");
    }

    function test_E2E_scoreDropBlocksAdvanceViaLiveRead() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        vm.prank(agent);
        bytes32 recId = repOracle.register();

        creditOracle.setScore(agent, 0);

        // Live read: score=0 → maxExposure=0 → receivable amount=0
        // Fails at _validateReceivable before reaching credit check
        vm.prank(agent);
        vm.expectRevert("exceeds advance ratio");
        escrow.requestAdvance(address(repOracle), recId, 1_000 * USDC);
    }

    // ═════════════════════════════════════════════════════════════
    // Rounding Stress Tests
    // ═════════════════════════════════════════════════════════════

    function test_Rounding_dustAdvanceFeeIsZero() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        vm.prank(agent);
        bytes32 recId = repOracle.register();

        vm.prank(agent);
        bytes32 advId = escrow.requestAdvance(address(repOracle), recId, 1);

        // fee = (1 * 500) / 10000 = 0
        // protocolCut = (0 * 1500) / 10000 = 0
        vm.startPrank(agent);
        usdc.approve(address(escrow), 1);
        escrow.settle(advId, 1);
        vm.stopPrank();

        assertEq(escrow.totalFeesEarned(), 0, "dust advance has zero fee");
        assertEq(escrow.accruedProtocolFees(), 0, "no protocol fees on dust");
        assertEq(escrow.totalLPFeesEarned(), 0, "no LP fees on dust");
        assertEq(escrow.totalAssets(), INITIAL_LP, "pool unchanged after dust roundtrip");
    }

    function test_Rounding_feeJustBelowProtocolThreshold() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        // advance = 13 → fee = (13*500)/10000 = 0
        // advance = 20 → fee = (20*500)/10000 = 1
        // protocolCut of 1 = (1*1500)/10000 = 0
        // advance = 134 → fee = (134*500)/10000 = 6
        // protocolCut of 6 = (6*1500)/10000 = 0
        // advance = 134 → fee 6, all to LP, protocol gets 0
        // advance = 140 → fee = (140*500)/10000 = 7
        // protocolCut of 7 = (7*1500)/10000 = 1 ← first non-zero protocol cut

        vm.prank(agent);
        bytes32 recId = repOracle.register();

        vm.prank(agent);
        bytes32 advId = escrow.requestAdvance(address(repOracle), recId, 134);

        uint256 fee = (134 * FEE_BPS) / 10000;
        assertEq(fee, 6, "fee should be 6 wei");

        vm.startPrank(agent);
        usdc.approve(address(escrow), 134 + fee);
        escrow.settle(advId, 134 + fee);
        vm.stopPrank();

        uint256 protocolCut = (fee * PROTOCOL_FEE_BPS) / 10000;
        assertEq(protocolCut, 0, "protocol gets nothing on fee=6");
        assertEq(escrow.totalLPFeesEarned(), 6, "LP gets all 6 wei");
        assertEq(escrow.totalAssets(), INITIAL_LP + 6, "totalAssets increased by full fee");
    }

    function test_Rounding_firstNonZeroProtocolCut() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        vm.prank(agent);
        bytes32 recId = repOracle.register();

        vm.prank(agent);
        bytes32 advId = escrow.requestAdvance(address(repOracle), recId, 140);

        uint256 fee = (140 * FEE_BPS) / 10000;
        assertEq(fee, 7, "fee should be 7 wei");

        vm.startPrank(agent);
        usdc.approve(address(escrow), 140 + fee);
        escrow.settle(advId, 140 + fee);
        vm.stopPrank();

        uint256 protocolCut = (fee * PROTOCOL_FEE_BPS) / 10000;
        assertEq(protocolCut, 1, "first non-zero protocol cut");
        assertEq(escrow.totalLPFeesEarned(), 6, "LP gets 6 of 7");
        assertEq(escrow.accruedProtocolFees(), 1, "protocol gets 1 of 7");
        assertEq(escrow.totalAssets(), INITIAL_LP + 6, "totalAssets only includes LP share");
    }

    function test_Rounding_manyDustAdvancesCantDrainPool() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        uint256 totalAssetsStart = escrow.totalAssets();

        for (uint256 i = 0; i < 100; i++) {
            vm.prank(agent);
            bytes32 recId = repOracle.register();

            vm.prank(agent);
            bytes32 advId = escrow.requestAdvance(address(repOracle), recId, 1);

            vm.startPrank(agent);
            usdc.approve(address(escrow), 1);
            escrow.settle(advId, 1);
            vm.stopPrank();
        }

        assertEq(escrow.totalAssets(), totalAssetsStart, "100 dust roundtrips: pool unchanged");
        assertEq(escrow.accruedProtocolFees(), 0, "no protocol fees from dust spam");
    }

    function test_Rounding_feeSplitAlwaysSumsToFee() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        uint256[] memory amounts = new uint256[](8);
        amounts[0] = 1;
        amounts[1] = 19;
        amounts[2] = 20;
        amounts[3] = 133;
        amounts[4] = 134;
        amounts[5] = 140;
        amounts[6] = 1_000 * USDC;
        amounts[7] = HARD_CAP;

        uint256 totalLP;
        uint256 totalProtocol;
        uint256 totalFee;

        for (uint256 i = 0; i < amounts.length; i++) {
            vm.prank(agent);
            bytes32 recId = repOracle.register();

            vm.prank(agent);
            bytes32 advId = escrow.requestAdvance(address(repOracle), recId, amounts[i]);

            uint256 fee = (amounts[i] * FEE_BPS) / 10000;
            vm.startPrank(agent);
            usdc.approve(address(escrow), amounts[i] + fee);
            escrow.settle(advId, amounts[i] + fee);
            vm.stopPrank();

            uint256 protocolCut = (fee * PROTOCOL_FEE_BPS) / 10000;
            uint256 lpCut = fee - protocolCut;

            totalLP += lpCut;
            totalProtocol += protocolCut;
            totalFee += fee;
        }

        assertEq(totalLP + totalProtocol, totalFee, "LP + protocol must always equal total fee");
        assertEq(escrow.totalLPFeesEarned(), totalLP, "on-chain LP fees match");
        assertEq(escrow.totalProtocolFeesEarned(), totalProtocol, "on-chain protocol fees match");
        assertEq(escrow.totalFeesEarned(), totalFee, "on-chain total fees match");
    }

    function test_Rounding_protocolNeverOverCollects() public {
        vm.startPrank(lp1);
        usdc.approve(address(escrow), INITIAL_LP);
        escrow.deposit(INITIAL_LP, lp1);
        vm.stopPrank();

        for (uint256 amt = 1; amt <= 300; amt++) {
            uint256 fee = (amt * FEE_BPS) / 10000;
            uint256 protocolCut = (fee * PROTOCOL_FEE_BPS) / 10000;
            uint256 lpCut = fee - protocolCut;

            assertEq(protocolCut + lpCut, fee, "split must equal total");
            if (fee > 0) {
                assertLe(protocolCut * 10000, fee * PROTOCOL_FEE_BPS, "protocol never over-collects");
            }
        }
    }
}

contract MockReputationRegistry {
    struct Rep {
        uint256 score;
        uint256 count;
    }
    mapping(address => Rep) public reps;

    function setReputation(address agent, uint256 score, uint256 count) external {
        reps[agent] = Rep(score, count);
    }

    function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount) {
        Rep storage r = reps[agent];
        return (r.score, r.count);
    }
}
