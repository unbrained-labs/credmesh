// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReputationCreditOracle} from "../contracts/oracles/ReputationCreditOracle.sol";
import {IdentityRegistry} from "../contracts/IdentityRegistry.sol";

/// Minimal escrow stub exposing exposure(agent) — the only surface the oracle reads.
contract EscrowStub {
    mapping(address => uint256) public exposure;
    function setExposure(address agent, uint256 amount) external {
        exposure[agent] = amount;
    }
}

/// Minimal reputation registry stub exposing the ERC-8004 getReputation surface.
contract RepRegistryStub {
    struct Rep { uint256 score; uint256 count; }
    mapping(address => Rep) public reps;
    function setReputation(address agent, uint256 score, uint256 count) external {
        reps[agent] = Rep(score, count);
    }
    function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount) {
        Rep storage r = reps[agent];
        return (r.score, r.count);
    }
}

contract ReputationCreditOracleTest is Test {
    uint256 constant USDC = 1e6;
    uint256 constant EXPOSURE_MULTIPLIER = 500 * USDC; // 500 USDC per score point
    uint256 constant BONUS_BPS = 2000; // +20% for identity-registered agents

    RepRegistryStub repReg;
    IdentityRegistry identityReg;
    EscrowStub escrow;
    ReputationCreditOracle oracle;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        repReg = new RepRegistryStub();
        identityReg = new IdentityRegistry();
        escrow = new EscrowStub();
        oracle = new ReputationCreditOracle(
            address(repReg),
            address(escrow),
            EXPOSURE_MULTIPLIER,
            address(identityReg),
            BONUS_BPS
        );
    }

    // ─── constructor ───

    function test_Constructor_setsImmutables() public view {
        assertEq(address(oracle.reputationRegistry()), address(repReg));
        assertEq(oracle.escrow(), address(escrow));
        assertEq(oracle.exposureMultiplier(), EXPOSURE_MULTIPLIER);
        assertEq(address(oracle.identityRegistry()), address(identityReg));
        assertEq(oracle.identityBonusMultiplier(), BONUS_BPS);
        assertEq(oracle.governance(), address(this));
    }

    function test_Constructor_revertsZeroReputationRegistry() public {
        vm.expectRevert("zero registry");
        new ReputationCreditOracle(address(0), address(escrow), EXPOSURE_MULTIPLIER, address(0), 0);
    }

    function test_Constructor_revertsZeroEscrow() public {
        vm.expectRevert("zero escrow");
        new ReputationCreditOracle(address(repReg), address(0), EXPOSURE_MULTIPLIER, address(0), 0);
    }

    function test_Constructor_revertsBonusTooHigh() public {
        vm.expectRevert("bonus too high");
        new ReputationCreditOracle(address(repReg), address(escrow), EXPOSURE_MULTIPLIER, address(identityReg), 10001);
    }

    function test_Constructor_allowsZeroIdentityRegistry() public {
        ReputationCreditOracle o = new ReputationCreditOracle(
            address(repReg), address(escrow), EXPOSURE_MULTIPLIER, address(0), 0
        );
        assertEq(address(o.identityRegistry()), address(0));
        assertEq(o.identityBonusMultiplier(), 0);
    }

    // ─── getCredit: reputation math ───

    function test_GetCredit_scoreCappedAt100() public {
        repReg.setReputation(alice, 250, 10);
        (uint256 score,, uint256 maxExp) = oracle.getCredit(alice);
        assertEq(score, 100, "score cap");
        // Base: 100 * 500 USDC = 50k USDC. +20% bonus not applied (alice unregistered). = 50k USDC.
        assertEq(maxExp, 100 * EXPOSURE_MULTIPLIER, "no bonus when unregistered");
    }

    function test_GetCredit_readsEscrowExposure() public {
        repReg.setReputation(alice, 80, 5);
        escrow.setExposure(alice, 12_345 * USDC);
        (, uint256 total,) = oracle.getCredit(alice);
        assertEq(total, 12_345 * USDC, "reads exposure from escrow");
    }

    // ─── getCredit: identity bonus ───

    function test_GetCredit_noBonusWhenUnregistered() public {
        repReg.setReputation(alice, 80, 5);
        (, , uint256 maxExp) = oracle.getCredit(alice);
        assertEq(maxExp, 80 * EXPOSURE_MULTIPLIER, "unregistered = base only");
    }

    function test_GetCredit_bonusAppliedWhenRegistered() public {
        repReg.setReputation(alice, 80, 5);
        vm.prank(alice);
        identityReg.register("https://alice.example/agent.json", keccak256("card"));

        (, , uint256 maxExp) = oracle.getCredit(alice);
        uint256 base = 80 * EXPOSURE_MULTIPLIER;
        uint256 expected = base + (base * BONUS_BPS) / 10000;
        assertEq(maxExp, expected, "registered: base plus 20 percent");
    }

    function test_GetCredit_bonusDoesNotLeakAcrossAgents() public {
        repReg.setReputation(alice, 80, 5);
        repReg.setReputation(bob, 80, 5);
        vm.prank(alice);
        identityReg.register("https://alice.example/agent.json", keccak256("card-a"));

        (, , uint256 aliceMax) = oracle.getCredit(alice);
        (, , uint256 bobMax) = oracle.getCredit(bob);

        uint256 base = 80 * EXPOSURE_MULTIPLIER;
        assertEq(aliceMax, base + (base * BONUS_BPS) / 10000, "alice bonus");
        assertEq(bobMax, base, "bob no bonus");
    }

    function test_GetCredit_bonusRevokedOnDeregister() public {
        repReg.setReputation(alice, 80, 5);
        vm.prank(alice);
        identityReg.register("https://alice.example/agent.json", keccak256("card"));
        vm.prank(alice);
        identityReg.deregister();

        (, , uint256 maxExp) = oracle.getCredit(alice);
        assertEq(maxExp, 80 * EXPOSURE_MULTIPLIER, "bonus revoked after deregister");
    }

    function test_GetCredit_noBonusWhenMultiplierZero() public {
        ReputationCreditOracle zeroBonus = new ReputationCreditOracle(
            address(repReg), address(escrow), EXPOSURE_MULTIPLIER, address(identityReg), 0
        );
        repReg.setReputation(alice, 80, 5);
        vm.prank(alice);
        identityReg.register("https://alice.example/agent.json", keccak256("card"));

        (, , uint256 maxExp) = zeroBonus.getCredit(alice);
        assertEq(maxExp, 80 * EXPOSURE_MULTIPLIER, "bonus=0 means registered equals unregistered");
    }

    function test_GetCredit_noBonusWhenRegistryZero() public {
        ReputationCreditOracle noReg = new ReputationCreditOracle(
            address(repReg), address(escrow), EXPOSURE_MULTIPLIER, address(0), 0
        );
        repReg.setReputation(alice, 80, 5);

        (, , uint256 maxExp) = noReg.getCredit(alice);
        assertEq(maxExp, 80 * EXPOSURE_MULTIPLIER, "no registry = base only");
    }

    function test_GetCredit_tryCatchAbsorbsBrokenRegistry() public {
        BrokenRegistry broken = new BrokenRegistry();
        ReputationCreditOracle o = new ReputationCreditOracle(
            address(repReg), address(escrow), EXPOSURE_MULTIPLIER, address(broken), BONUS_BPS
        );
        repReg.setReputation(alice, 80, 5);

        (, , uint256 maxExp) = o.getCredit(alice);
        assertEq(maxExp, 80 * EXPOSURE_MULTIPLIER, "broken registry must not revert whole call");
    }

    // ─── governance: setIdentityRegistry ───

    function test_SetIdentityRegistry_rotatesRegistry() public {
        IdentityRegistry newReg = new IdentityRegistry();
        oracle.setIdentityRegistry(address(newReg), 3000);

        assertEq(address(oracle.identityRegistry()), address(newReg));
        assertEq(oracle.identityBonusMultiplier(), 3000);
    }

    function test_SetIdentityRegistry_revertsBonusTooHigh() public {
        vm.expectRevert("bonus too high");
        oracle.setIdentityRegistry(address(identityReg), 10001);
    }

    function test_SetIdentityRegistry_onlyGovernance() public {
        vm.prank(alice);
        vm.expectRevert("not governance");
        oracle.setIdentityRegistry(address(identityReg), 1000);
    }

    function test_SetIdentityRegistry_canDisableByZeroing() public {
        oracle.setIdentityRegistry(address(0), 0);
        assertEq(address(oracle.identityRegistry()), address(0));

        repReg.setReputation(alice, 80, 5);
        (, , uint256 maxExp) = oracle.getCredit(alice);
        assertEq(maxExp, 80 * EXPOSURE_MULTIPLIER, "disabled: base only");
    }

    // ─── governance: setExposureMultiplier ───

    function test_SetExposureMultiplier_updatesMath() public {
        oracle.setExposureMultiplier(1000 * USDC);
        repReg.setReputation(alice, 50, 3);
        (, , uint256 maxExp) = oracle.getCredit(alice);
        assertEq(maxExp, 50 * 1000 * USDC, "new multiplier applied");
    }

    function test_SetExposureMultiplier_onlyGovernance() public {
        vm.prank(alice);
        vm.expectRevert("not governance");
        oracle.setExposureMultiplier(1000 * USDC);
    }

    function test_SetExposureMultiplier_revertsOutOfRange() public {
        vm.expectRevert("out of range");
        oracle.setExposureMultiplier(0);

        vm.expectRevert("out of range");
        oracle.setExposureMultiplier(100_001e6);
    }

    // ─── governance: transfer ───

    function test_GovernanceTransfer_twoStep() public {
        oracle.proposeGovernance(alice);
        assertEq(oracle.pendingGovernance(), alice);

        vm.prank(alice);
        oracle.acceptGovernance();
        assertEq(oracle.governance(), alice);
        assertEq(oracle.pendingGovernance(), address(0));
    }

    function test_GovernanceTransfer_onlyPendingCanAccept() public {
        oracle.proposeGovernance(alice);
        vm.prank(bob);
        vm.expectRevert("not pending");
        oracle.acceptGovernance();
    }
}

contract BrokenRegistry {
    function getAgent(address) external pure returns (bytes memory) {
        revert("broken");
    }
}
