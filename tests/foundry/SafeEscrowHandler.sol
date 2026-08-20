// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {SafeEscrow} from "../../contracts/SafeEscrow.sol";

/// @title SafeEscrowHandler
/// @notice Bounded actor model driving `SafeEscrow` for invariant runs.
/// @dev Foundry's invariant fuzzer calls this handler's public functions in random
///      order with random arguments. The handler exists to keep those calls inside
///      the contract's documented preconditions (distinct parties, future deadlines,
///      non-zero value) so runs spend their budget exploring *reachable* states
///      instead of bouncing off input validation.
///
///      The handler also records two things the invariants cannot observe after the
///      fact: settlements that succeeded for a non-party, and settlements that were
///      wrongly blocked while the contract was paused. Both counters must stay zero.
contract SafeEscrowHandler is CommonBase, StdCheats, StdUtils {
    uint256 private constant ACTOR_COUNT = 4;
    /// @dev Bounded so `msg.value` can never approach the `uint96` deposit ceiling,
    ///      keeping `AmountTooLarge` out of the reachable state space.
    uint256 private constant MAX_DEPOSIT = 100 ether;

    SafeEscrow public immutable escrow;
    address public immutable admin;

    address[ACTOR_COUNT] public actors;

    /// @notice Escrow ids the handler has observed reach a settled status.
    uint256[] public settledIds;
    mapping(uint256 escrowId => bool settled) public isSettled;

    /// @notice Count of successful `release`/`refund` calls by a non-party. Must stay 0.
    uint256 public unauthorizedSettlements;
    /// @notice Count of party settlements wrongly rejected while paused. Must stay 0.
    uint256 public settlementsBlockedWhilePaused;
    /// @notice Count of escrows successfully funded, used to confirm run coverage.
    uint256 public depositCount;
    /// @notice Count of successful settlements, used to confirm run coverage.
    uint256 public settlementCount;

    constructor(SafeEscrow escrow_, address admin_) {
        escrow = escrow_;
        admin = admin_;
        for (uint256 index = 0; index < ACTOR_COUNT; index++) {
            // Deterministic, clearly-synthetic test actors. Funded generously so a
            // deposit never fails for lack of balance.
            address actor = address(uint160(uint256(keccak256(abi.encode("chainindex.actor", index)))));
            actors[index] = actor;
            deal(actor, 1_000 ether);
        }
    }

    /// @notice Funds a new escrow with three distinct parties and a future deadline.
    function deposit(uint256 payerSeed, uint256 payeeSeed, uint256 arbiterSeed, uint256 amountSeed) external {
        (address payer, address payee, address arbiter) = _threeDistinctActors(payerSeed, payeeSeed, arbiterSeed);
        uint256 amount = bound(amountSeed, 1 wei, MAX_DEPOSIT);
        uint64 refundAfter = uint64(block.timestamp + bound(amountSeed, 1, 365 days));

        vm.prank(payer);
        try escrow.deposit{value: amount}(payable(payee), arbiter, refundAfter) {
            depositCount++;
        } catch {
            // A revert here is acceptable (for example while paused) and is covered by
            // the dedicated pause invariant rather than by failing the run.
        }
    }

    /// @notice Releases an escrow as its payer or arbiter.
    function release(uint256 idSeed, bool asArbiter) external {
        uint256 escrowId = _existingId(idSeed);
        if (escrowId == 0) return;
        (address payer,, address arbiter,,, SafeEscrow.Status status) = escrow.escrows(escrowId);
        bool paused = escrow.paused();

        vm.prank(asArbiter ? arbiter : payer);
        try escrow.release(escrowId) {
            settlementCount++;
            _markSettled(escrowId);
        } catch {
            // Only a Funded escrow is settleable; anything else legitimately reverts.
            // A funded escrow rejecting its own party while paused is the bug we hunt.
            if (status == SafeEscrow.Status.Funded && paused) {
                settlementsBlockedWhilePaused++;
            }
        }
    }

    /// @notice Refunds an escrow as its payee or arbiter, who need not wait for the deadline.
    function refund(uint256 idSeed, bool asArbiter) external {
        uint256 escrowId = _existingId(idSeed);
        if (escrowId == 0) return;
        (, address payee, address arbiter,,, SafeEscrow.Status status) = escrow.escrows(escrowId);
        bool paused = escrow.paused();

        vm.prank(asArbiter ? arbiter : payee);
        try escrow.refund(escrowId) {
            settlementCount++;
            _markSettled(escrowId);
        } catch {
            if (status == SafeEscrow.Status.Funded && paused) {
                settlementsBlockedWhilePaused++;
            }
        }
    }

    /// @notice Attempts settlement from an account that is not a party to the escrow.
    /// @dev Any success is an access-control break and is recorded for the invariant.
    ///      The pause admin is included in the candidate set so the run also proves the
    ///      breaker grants no settlement authority.
    function settleAsNonParty(uint256 idSeed, uint256 actorSeed, bool useRefund) external {
        uint256 escrowId = _existingId(idSeed);
        if (escrowId == 0) return;
        (address payer, address payee, address arbiter,,,) = escrow.escrows(escrowId);

        uint256 choice = bound(actorSeed, 0, ACTOR_COUNT);
        address caller = choice == ACTOR_COUNT ? admin : actors[choice];
        // `release` authorizes payer/arbiter; `refund` also authorizes payee. Skip the
        // caller unless it is a genuine outsider for the path under test.
        if (caller == payer || caller == arbiter) return;
        if (useRefund && caller == payee) return;

        vm.prank(caller);
        if (useRefund) {
            try escrow.refund(escrowId) {
                unauthorizedSettlements++;
            } catch {}
        } else {
            try escrow.release(escrowId) {
                unauthorizedSettlements++;
            } catch {}
        }
    }

    /// @notice Toggles the deposit circuit breaker as the admin.
    function togglePause() external {
        vm.startPrank(admin);
        if (escrow.paused()) {
            escrow.unpause();
        } else {
            escrow.pause();
        }
        vm.stopPrank();
    }

    /// @notice Advances time so payer-initiated refunds past the deadline are reachable.
    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 30 days));
    }

    /// @notice Refunds an escrow as its payer, valid only once the deadline has passed.
    function refundAsPayer(uint256 idSeed) external {
        uint256 escrowId = _existingId(idSeed);
        if (escrowId == 0) return;
        (address payer,,,,, SafeEscrow.Status status) = escrow.escrows(escrowId);
        bool paused = escrow.paused();

        vm.prank(payer);
        try escrow.refund(escrowId) {
            settlementCount++;
            _markSettled(escrowId);
        } catch {
            if (status == SafeEscrow.Status.Funded && paused) {
                settlementsBlockedWhilePaused++;
            }
        }
    }

    /// @notice Number of escrow ids observed to have settled.
    function settledCount() external view returns (uint256) {
        return settledIds.length;
    }

    function _markSettled(uint256 escrowId) private {
        if (isSettled[escrowId]) return;
        isSettled[escrowId] = true;
        settledIds.push(escrowId);
    }

    /// @dev Maps a fuzzed seed onto an existing escrow id, or 0 when none exist yet.
    function _existingId(uint256 idSeed) private view returns (uint256) {
        uint256 minted = escrow.nextEscrowId() - 1;
        if (minted == 0) return 0;
        return bound(idSeed, 1, minted);
    }

    /// @dev Selects three distinct actors, satisfying the contract's party checks.
    function _threeDistinctActors(uint256 firstSeed, uint256 secondSeed, uint256 thirdSeed)
        private
        view
        returns (address first, address second, address third)
    {
        uint256 firstIndex = bound(firstSeed, 0, ACTOR_COUNT - 1);
        // A non-zero offset guarantees a different slot without a rejection loop.
        uint256 secondIndex = (firstIndex + bound(secondSeed, 1, ACTOR_COUNT - 1)) % ACTOR_COUNT;

        uint256 skip = bound(thirdSeed, 0, ACTOR_COUNT - 3);
        uint256 thirdIndex = type(uint256).max;
        for (uint256 index = 0; index < ACTOR_COUNT; index++) {
            if (index == firstIndex || index == secondIndex) continue;
            if (skip == 0) {
                thirdIndex = index;
                break;
            }
            skip--;
        }
        return (actors[firstIndex], actors[secondIndex], actors[thirdIndex]);
    }
}
