// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISafeEscrow {
    function deposit(address payable payee, address arbiter, uint64 refundAfter) external payable returns (uint256);
    function release(uint256 escrowId) external;
}

contract ReentrantPayee {
    ISafeEscrow public immutable escrow;
    uint256 public targetId;
    bool public reentryBlocked;

    constructor(ISafeEscrow escrow_) {
        escrow = escrow_;
    }

    function setTarget(uint256 escrowId) external {
        targetId = escrowId;
    }

    receive() external payable {
        try escrow.release(targetId) {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
    }
}
