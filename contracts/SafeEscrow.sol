// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SafeEscrow
/// @notice Holds native ETH until a payer, payee, or designated arbiter settles it.
/// @dev This reference implementation has not received an external security audit.
contract SafeEscrow {
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

    error AmountRequired();
    error InvalidAddress();
    error InvalidDeadline();
    error EscrowNotFunded();
    error Unauthorized();
    error RefundNotAvailable();
    error TransferFailed();
    error ReentrantCall();
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

    uint256 private locked = 1;

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    /// @notice Creates and funds an escrow.
    /// @param payee Recipient if the escrow is released.
    /// @param arbiter Optional third party that may release or refund.
    /// @param refundAfter Earliest timestamp at which the payer may refund.
    function deposit(
        address payable payee,
        address arbiter,
        uint64 refundAfter
    ) external payable nonReentrant returns (uint256 escrowId) {
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
