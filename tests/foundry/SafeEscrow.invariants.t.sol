// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SafeEscrow} from "../../contracts/SafeEscrow.sol";
import {SafeEscrowHandler} from "./SafeEscrowHandler.sol";

/// @title SafeEscrowInvariants
/// @notice Property-based invariant suite for `SafeEscrow`.
/// @dev These assert properties that must hold across *every* reachable state, which
///      is the gap the example-based Hardhat suite cannot close. The Hardhat tests
///      prove specific attacks fail; these prove no random call ordering reaches a
///      state where solvency or access control is broken.
///
///      Run with `npm run test:invariant` (requires Foundry: `forge`).
contract SafeEscrowInvariants is Test {
    SafeEscrow internal escrow;
    SafeEscrowHandler internal handler;
    address internal admin = makeAddr("pauseAdmin");

    function setUp() public {
        escrow = new SafeEscrow(admin);
        handler = new SafeEscrowHandler(escrow, admin);
        targetContract(address(handler));
    }

    /// @notice Solvency: the contract's ETH balance always covers every unreleased deposit.
    /// @dev The headline safety property. `amount` is zeroed on settlement, so summing
    ///      the live `amount` fields yields total outstanding liability. Balance may
    ///      exceed it (forced ETH via SELFDESTRUCT is unattributable and documented in
    ///      the threat model) but must never fall below it.
    function invariant_balanceCoversOutstandingDeposits() public view {
        uint256 minted = escrow.nextEscrowId() - 1;
        uint256 outstanding;
        for (uint256 escrowId = 1; escrowId <= minted; escrowId++) {
            (,,, uint96 amount,,) = escrow.escrows(escrowId);
            outstanding += amount;
        }
        assertGe(
            address(escrow).balance,
            outstanding,
            "escrow balance fell below outstanding deposits"
        );
    }

    /// @notice Access control: no non-party call ever settles an escrow.
    /// @dev Covers the pause admin too, proving the breaker confers no fund authority.
    function invariant_onlyPartiesCanSettle() public view {
        assertEq(
            handler.unauthorizedSettlements(),
            0,
            "a non-party successfully settled an escrow"
        );
    }

    /// @notice Liveness: pausing never blocks settlement of an already-funded escrow.
    /// @dev Guards the inflow-only breaker design; a regression that added
    ///      `whenNotPaused` to release/refund would surface here.
    function invariant_pauseNeverBlocksSettlement() public view {
        assertEq(
            handler.settlementsBlockedWhilePaused(),
            0,
            "pause blocked settlement of a funded escrow"
        );
    }

    /// @notice A settled escrow is terminal: its amount is zero and status is never Funded.
    /// @dev Encodes the no-double-settlement property as a state invariant rather than
    ///      as the single replay example the Hardhat suite checks.
    function invariant_settledEscrowsAreTerminal() public view {
        uint256 count = handler.settledCount();
        for (uint256 index = 0; index < count; index++) {
            uint256 escrowId = handler.settledIds(index);
            (,,, uint96 amount,, SafeEscrow.Status status) = escrow.escrows(escrowId);
            assertEq(amount, 0, "settled escrow retains a balance");
            assertTrue(
                status == SafeEscrow.Status.Released || status == SafeEscrow.Status.Refunded,
                "settled escrow left a non-terminal status"
            );
        }
    }

    /// @notice Escrow ids are strictly allocated and never reused.
    function invariant_escrowIdsAreMonotonic() public view {
        assertGe(escrow.nextEscrowId(), 1, "id counter fell below its initial value");
        uint256 unusedId = escrow.nextEscrowId();
        (,,, uint96 amount,, SafeEscrow.Status status) = escrow.escrows(unusedId);
        assertEq(amount, 0, "unallocated escrow id carries a balance");
        assertTrue(status == SafeEscrow.Status.None, "unallocated escrow id carries a status");
    }

    /// @notice Reports handler coverage so a vacuously-passing run is visible.
    /// @dev Invariants over an empty state space pass trivially. This fails the suite if
    ///      the actor model never funded an escrow, which would mean the handler
    ///      preconditions drifted out of sync with the contract.
    function invariant_handlerReachedMeaningfulStates() public view {
        assertGt(handler.depositCount(), 0, "no escrow was ever funded during the run");
    }

    /// @notice Fuzz: a released escrow always credits exactly the deposited amount.
    /// @dev Stateless companion to the invariants; bounds are the contract's documented
    ///      preconditions.
    function testFuzz_releasePaysExactDepositedAmount(uint96 amount, uint64 deadlineOffset) public {
        amount = uint96(bound(amount, 1, 100 ether));
        uint64 refundAfter = uint64(bound(deadlineOffset, 1, 365 days)) + uint64(block.timestamp);

        address payer = makeAddr("fuzzPayer");
        address payee = makeAddr("fuzzPayee");
        address arbiter = makeAddr("fuzzArbiter");
        vm.deal(payer, amount);

        vm.prank(payer);
        uint256 escrowId = escrow.deposit{value: amount}(payable(payee), arbiter, refundAfter);

        uint256 payeeBefore = payee.balance;
        vm.prank(arbiter);
        escrow.release(escrowId);

        assertEq(payee.balance - payeeBefore, amount, "payee credited the wrong amount");
        assertEq(address(escrow).balance, 0, "escrow retained ETH after full settlement");
    }

    /// @notice Fuzz: a payer can never refund before the deadline it set.
    function testFuzz_payerCannotRefundEarly(uint96 amount, uint64 deadlineOffset) public {
        amount = uint96(bound(amount, 1, 100 ether));
        uint64 offset = uint64(bound(deadlineOffset, 2, 365 days));
        uint64 refundAfter = uint64(block.timestamp) + offset;

        address payer = makeAddr("fuzzPayer");
        address payee = makeAddr("fuzzPayee");
        address arbiter = makeAddr("fuzzArbiter");
        vm.deal(payer, amount);

        vm.prank(payer);
        uint256 escrowId = escrow.deposit{value: amount}(payable(payee), arbiter, refundAfter);

        vm.warp(refundAfter - 1);
        vm.prank(payer);
        vm.expectRevert(SafeEscrow.RefundNotAvailable.selector);
        escrow.refund(escrowId);

        vm.warp(refundAfter);
        vm.prank(payer);
        escrow.refund(escrowId);
        assertEq(address(escrow).balance, 0, "escrow retained ETH after refund");
    }
}
