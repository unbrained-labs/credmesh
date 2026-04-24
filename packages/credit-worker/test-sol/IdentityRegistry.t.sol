// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../contracts/IdentityRegistry.sol";

contract IdentityRegistryTest is Test {
    IdentityRegistry registry;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    string constant URI_A = "https://alice.example/.well-known/agent.json";
    string constant URI_B = "https://bob.example/.well-known/agent.json";
    bytes32 constant HASH_A = keccak256("card-a");
    bytes32 constant HASH_B = keccak256("card-b");

    event AgentRegistered(address indexed agent, string agentCardUri, bytes32 agentCardHash);
    event AgentUpdated(address indexed agent, string agentCardUri, bytes32 agentCardHash);
    event AgentDeregistered(address indexed agent);

    function setUp() public {
        registry = new IdentityRegistry();
    }

    // ─── register ───

    function test_Register_storesAgent() public {
        vm.expectEmit(true, false, false, true);
        emit AgentRegistered(alice, URI_A, HASH_A);

        vm.prank(alice);
        registry.register(URI_A, HASH_A);

        (string memory uri, bytes32 h, uint64 reg, uint64 upd) = registry.agentInfo(alice);
        assertEq(uri, URI_A, "uri");
        assertEq(h, HASH_A, "hash");
        assertEq(reg, uint64(block.timestamp), "registeredAt");
        assertEq(upd, uint64(block.timestamp), "updatedAt equals registeredAt on first register");
        assertTrue(registry.isRegistered(alice), "isRegistered");
    }

    function test_Register_revertsEmptyUri() public {
        vm.prank(alice);
        vm.expectRevert("empty uri");
        registry.register("", HASH_A);
    }

    function test_Register_revertsEmptyHash() public {
        vm.prank(alice);
        vm.expectRevert("empty hash");
        registry.register(URI_A, bytes32(0));
    }

    function test_Register_revertsDoubleRegister() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);

        vm.prank(alice);
        vm.expectRevert("already registered");
        registry.register(URI_A, HASH_A);
    }

    function test_Register_isolatedPerAddress() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);
        vm.prank(bob);
        registry.register(URI_B, HASH_B);

        assertTrue(registry.isRegistered(alice));
        assertTrue(registry.isRegistered(bob));

        (string memory aliceUri,,,) = registry.agentInfo(alice);
        (string memory bobUri,,,) = registry.agentInfo(bob);
        assertEq(aliceUri, URI_A);
        assertEq(bobUri, URI_B);
    }

    // ─── update ───

    function test_Update_advancesUpdatedAtPreservesRegisteredAt() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);
        uint64 firstReg = uint64(block.timestamp);

        vm.warp(block.timestamp + 1 days);

        vm.expectEmit(true, false, false, true);
        emit AgentUpdated(alice, URI_B, HASH_B);

        vm.prank(alice);
        registry.update(URI_B, HASH_B);

        (string memory uri, bytes32 h, uint64 reg, uint64 upd) = registry.agentInfo(alice);
        assertEq(uri, URI_B, "uri rotated");
        assertEq(h, HASH_B, "hash rotated");
        assertEq(reg, firstReg, "registeredAt immutable");
        assertEq(upd, uint64(block.timestamp), "updatedAt advanced");
    }

    function test_Update_revertsIfNotRegistered() public {
        vm.prank(alice);
        vm.expectRevert("not registered");
        registry.update(URI_A, HASH_A);
    }

    function test_Update_revertsEmptyUri() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);

        vm.prank(alice);
        vm.expectRevert("empty uri");
        registry.update("", HASH_B);
    }

    function test_Update_revertsEmptyHash() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);

        vm.prank(alice);
        vm.expectRevert("empty hash");
        registry.update(URI_B, bytes32(0));
    }

    // ─── deregister ───

    function test_Deregister_clearsEntry() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);
        assertTrue(registry.isRegistered(alice));

        vm.expectEmit(true, false, false, true);
        emit AgentDeregistered(alice);

        vm.prank(alice);
        registry.deregister();

        assertFalse(registry.isRegistered(alice));
        assertEq(registry.getAgent(alice).length, 0, "getAgent empty after deregister");
    }

    function test_Deregister_revertsIfNotRegistered() public {
        vm.prank(alice);
        vm.expectRevert("not registered");
        registry.deregister();
    }

    function test_Deregister_allowsReRegister() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);
        vm.prank(alice);
        registry.deregister();

        vm.warp(block.timestamp + 1 hours);

        vm.prank(alice);
        registry.register(URI_B, HASH_B);

        (string memory uri, bytes32 h, uint64 reg,) = registry.agentInfo(alice);
        assertEq(uri, URI_B, "new uri");
        assertEq(h, HASH_B, "new hash");
        assertEq(reg, uint64(block.timestamp), "fresh registeredAt");
    }

    // ─── getAgent ERC-8004 surface ───

    function test_GetAgent_emptyBytesForUnregistered() public view {
        assertEq(registry.getAgent(alice).length, 0, "unregistered returns empty");
    }

    function test_GetAgent_nonEmptyForRegistered() public {
        vm.prank(alice);
        registry.register(URI_A, HASH_A);

        bytes memory data = registry.getAgent(alice);
        assertGt(data.length, 0, "registered returns non-empty");

        (string memory uri, bytes32 h, uint64 reg, uint64 upd) =
            abi.decode(data, (string, bytes32, uint64, uint64));
        assertEq(uri, URI_A);
        assertEq(h, HASH_A);
        assertEq(reg, upd);
    }
}
