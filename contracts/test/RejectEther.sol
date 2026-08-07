// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract RejectEther {
    receive() external payable {
        revert("no ether accepted");
    }
}
