// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SafeEscrow
/// @notice Holds native ETH until a payer, payee, or designated arbiter settles it.
/// @dev This reference implementation has not received an external security audit.
///
/// @dev Authorization is split across two deliberately separate layers:
///
///      1. **Per-escrow settlement authority** (`payer`, `payee`, `arbiter`) lives in
///         each {Escrow} record and is checked inline. This is intentionally *not*
///         modelled with OpenZeppelin {AccessControl}: `AccessControl` keeps a single
///         contract-wide `role => account` registry, so granting an `ARBITER_ROLE`
///         would authorize that account against **every** escrow rather than the one
///         it was named on. Per-escrow parties are relationship data, not global
///         permissions, so they stay in storage.
///      2. **Contract-wide operational authority** uses {AccessControl}. Its only
///         privileged capability is the {Pausable} circuit breaker over {deposit}.
///
///      The breaker is deliberately inflow-only: {release} and {refund} are never
///      pausable, so no admin — including a compromised admin key — can freeze,
///      seize, or strand ETH that is already escrowed. Funded escrows always stay
///      settleable by their own parties. The Hardhat suite and the Foundry invariant
///      suite both assert this property directly.
contract SafeEscrow is AccessControl, Pausable, ReentrancyGuard {
    enum Status {
        None,
        Funded,
        Released,
        Refunded
    }

    struct Escrow {
        address payer;
        address payable payee;
        address arbiter;
        uint96 amount;
        uint64 refundAfter;
        Status status;
    }

    /// @notice Role permitted to pause and unpause new deposits.
    /// @dev Holders cannot release, refund, or otherwise reach escrowed ETH.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    error AmountRequired();
    error InvalidAddress();
    error InvalidDeadline();
    error EscrowNotFunded();
    error Unauthorized();
    error RefundNotAvailable();
    error TransferFailed();
    error AmountTooLarge();

    event Deposited(
        uint256 indexed escrowId,
        address indexed payer,
        address indexed payee,
        address arbiter,
        uint256 amount,
        uint256 refundAfter
    );
    event Released(uint256 indexed escrowId, address indexed authorizedBy, address indexed payee, uint256 amount);
    event Refunded(uint256 indexed escrowId, address indexed authorizedBy, address indexed payer, uint256 amount);

    uint256 public nextEscrowId = 1;
    mapping(uint256 escrowId => Escrow escrow) public escrows;

    /// @notice Assigns the contract-wide administrative roles.
    /// @param admin Account granted `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`.
    /// @dev The admin governs the deposit circuit breaker only; it holds no settlement
    ///      authority over any escrow. The zero address is rejected so the breaker
    ///      cannot be deployed unowned.
    constructor(address admin) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice Stops acceptance of new deposits.
    /// @dev Settlement of already-funded escrows is unaffected by design.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes acceptance of new deposits.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Creates and funds an escrow.
    /// @param payee Recipient if the escrow is released.
    /// @param arbiter Optional third party that may release or refund.
    /// @param refundAfter Earliest timestamp at which the payer may refund.
    function deposit(
        address payable payee,
        address arbiter,
        uint64 refundAfter
    ) external payable nonReentrant whenNotPaused returns (uint256 escrowId) {
        if (msg.value == 0) revert AmountRequired();
        if (payee == address(0) || payee == msg.sender || arbiter == msg.sender || arbiter == payee) {
            revert InvalidAddress();
        }
        if (refundAfter <= block.timestamp) revert InvalidDeadline();
        if (msg.value > type(uint96).max) revert AmountTooLarge();

        escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            payer: msg.sender,
            payee: payee,
            arbiter: arbiter,
            amount: uint96(msg.value),
            refundAfter: refundAfter,
            status: Status.Funded
        });

        emit Deposited(escrowId, msg.sender, payee, arbiter, msg.value, refundAfter);
    }

    /// @notice Pays the escrow to the payee. The payer or arbiter may authorize.
    /// @dev Never pausable: settlement must stay available to the escrow's own parties.
    function release(uint256 escrowId) external nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.status != Status.Funded) revert EscrowNotFunded();
        if (msg.sender != escrow.payer && msg.sender != escrow.arbiter) revert Unauthorized();

        uint256 amount = escrow.amount;
        address payable payee = escrow.payee;
        escrow.status = Status.Released;
        escrow.amount = 0;

        emit Released(escrowId, msg.sender, payee, amount);
        (bool sent, ) = payee.call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    /// @notice Returns the escrow to the payer.
    /// @dev Payee and arbiter may refund immediately; payer must wait for refundAfter.
    /// @dev Never pausable: settlement must stay available to the escrow's own parties.
    function refund(uint256 escrowId) external nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.status != Status.Funded) revert EscrowNotFunded();

        bool privileged = msg.sender == escrow.payee || msg.sender == escrow.arbiter;
        if (!privileged && msg.sender != escrow.payer) revert Unauthorized();
        if (!privileged && block.timestamp < escrow.refundAfter) revert RefundNotAvailable();

        uint256 amount = escrow.amount;
        address payable payer = payable(escrow.payer);
        escrow.status = Status.Refunded;
        escrow.amount = 0;

        emit Refunded(escrowId, msg.sender, payer, amount);
        (bool sent, ) = payer.call{value: amount}("");
        if (!sent) revert TransferFailed();
    }
}
