import { expect } from "chai";
import { ethers, network } from "hardhat";

describe("SafeEscrow", () => {
  const amount = ethers.parseEther("1");

  async function deployFixture() {
    const [payer, payee, arbiter, outsider] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("SafeEscrow");
    const escrow = await factory.deploy();
    await escrow.waitForDeployment();
    const latest = await ethers.provider.getBlock("latest");
    if (latest === null) throw new Error("Latest block unavailable");
    const deadline = latest.timestamp + 3_600;
    return { escrow, payer, payee, arbiter, outsider, deadline };
  }

  it("records a funded escrow and emits all indexed identities", async () => {
    const { escrow, payer, payee, arbiter, deadline } = await deployFixture();

    await expect(
      escrow
        .connect(payer)
        .deposit(payee.address, arbiter.address, deadline, { value: amount })
    )
      .to.emit(escrow, "Deposited")
      .withArgs(
        1n,
        payer.address,
        payee.address,
        arbiter.address,
        amount,
        deadline
      );

    const stored = await escrow.escrows(1n);
    expect(stored.payer).to.equal(payer.address);
    expect(stored.payee).to.equal(payee.address);
    expect(stored.arbiter).to.equal(arbiter.address);
    expect(stored.amount).to.equal(amount);
    expect(stored.refundAfter).to.equal(deadline);
    expect(stored.status).to.equal(1n);
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(amount);
  });

  it("rejects zero-value, invalid-party, and expired deposits", async () => {
    const { escrow, payer, payee, arbiter, deadline } = await deployFixture();

    await expect(
      escrow.connect(payer).deposit(payee.address, arbiter.address, deadline)
    ).to.be.revertedWithCustomError(escrow, "AmountRequired");
    await expect(
      escrow
        .connect(payer)
        .deposit(ethers.ZeroAddress, arbiter.address, deadline, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow
        .connect(payer)
        .deposit(payer.address, arbiter.address, deadline, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow
        .connect(payer)
        .deposit(payee.address, payer.address, deadline, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow
        .connect(payer)
        .deposit(payee.address, payee.address, deadline, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow
        .connect(payer)
        .deposit(payee.address, arbiter.address, deadline - 3_600, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
  });

  it("allows the payer to release using checks-effects-interactions", async () => {
    const { escrow, payer, payee, arbiter, deadline } = await deployFixture();
    await escrow
      .connect(payer)
      .deposit(payee.address, arbiter.address, deadline, { value: amount });

    const release = escrow.connect(payer).release(1n);
    await expect(release).to.changeEtherBalances([escrow, payee], [-amount, amount]);
    await expect(release)
      .to.emit(escrow, "Released")
      .withArgs(1n, payer.address, payee.address, amount);

    const stored = await escrow.escrows(1n);
    expect(stored.amount).to.equal(0n);
    expect(stored.status).to.equal(2n);
  });

  it("allows the arbiter, but not an outsider or payee, to release", async () => {
    const { escrow, payer, payee, arbiter, outsider, deadline } =
      await deployFixture();
    await escrow
      .connect(payer)
      .deposit(payee.address, arbiter.address, deadline, { value: amount });

    await expect(
      escrow.connect(outsider).release(1n)
    ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    await expect(
      escrow.connect(payee).release(1n)
    ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    await expect(escrow.connect(arbiter).release(1n))
      .to.emit(escrow, "Released")
      .withArgs(1n, arbiter.address, payee.address, amount);
  });

  it("prevents a second settlement", async () => {
    const { escrow, payer, payee, arbiter, deadline } = await deployFixture();
    await escrow
      .connect(payer)
      .deposit(payee.address, arbiter.address, deadline, { value: amount });
    await escrow.connect(payer).release(1n);

    await expect(
      escrow.connect(payer).release(1n)
    ).to.be.revertedWithCustomError(escrow, "EscrowNotFunded");
    await expect(
      escrow.connect(arbiter).refund(1n)
    ).to.be.revertedWithCustomError(escrow, "EscrowNotFunded");
  });

  it("lets the payee or arbiter refund immediately", async () => {
    const { escrow, payer, payee, arbiter, deadline } = await deployFixture();
    await escrow
      .connect(payer)
      .deposit(payee.address, arbiter.address, deadline, { value: amount });
    await escrow
      .connect(payer)
      .deposit(payee.address, arbiter.address, deadline, { value: amount });

    await expect(escrow.connect(payee).refund(1n))
      .to.emit(escrow, "Refunded")
      .withArgs(1n, payee.address, payer.address, amount);
    await expect(escrow.connect(arbiter).refund(2n))
      .to.emit(escrow, "Refunded")
      .withArgs(2n, arbiter.address, payer.address, amount);
  });

  it("enforces the payer refund deadline", async () => {
    const { escrow, payer, payee, arbiter, deadline } = await deployFixture();
    await escrow
      .connect(payer)
      .deposit(payee.address, arbiter.address, deadline, { value: amount });

    await expect(
      escrow.connect(payer).refund(1n)
    ).to.be.revertedWithCustomError(escrow, "RefundNotAvailable");
    await network.provider.send("evm_setNextBlockTimestamp", [deadline]);
    await expect(escrow.connect(payer).refund(1n))
      .to.emit(escrow, "Refunded")
      .withArgs(1n, payer.address, payer.address, amount);
  });

  it("rejects unauthorized refunds", async () => {
    const { escrow, payer, payee, arbiter, outsider, deadline } =
      await deployFixture();
    await escrow
      .connect(payer)
      .deposit(payee.address, arbiter.address, deadline, { value: amount });

    await expect(
      escrow.connect(outsider).refund(1n)
    ).to.be.revertedWithCustomError(escrow, "Unauthorized");
  });

  it("reverts atomically when the recipient rejects ETH", async () => {
    const { escrow, payer, arbiter, deadline } = await deployFixture();
    const rejectFactory = await ethers.getContractFactory("RejectEther");
    const reject = await rejectFactory.deploy();
    await reject.waitForDeployment();
    await escrow
      .connect(payer)
      .deposit(await reject.getAddress(), arbiter.address, deadline, { value: amount });

    await expect(
      escrow.connect(payer).release(1n)
    ).to.be.revertedWithCustomError(escrow, "TransferFailed");
    const stored = await escrow.escrows(1n);
    expect(stored.amount).to.equal(amount);
    expect(stored.status).to.equal(1n);
  });

  it("blocks callback reentrancy while completing the original release", async () => {
    const { escrow, payer, arbiter, deadline } = await deployFixture();
    const attackerFactory = await ethers.getContractFactory("ReentrantPayee");
    const attacker = await attackerFactory.deploy(await escrow.getAddress());
    await attacker.waitForDeployment();
    await escrow
      .connect(payer)
      .deposit(await attacker.getAddress(), arbiter.address, deadline, { value: amount });
    await attacker.setTarget(1n);

    await escrow.connect(payer).release(1n);

    expect(await attacker.reentryBlocked()).to.equal(true);
    expect((await escrow.escrows(1n)).status).to.equal(2n);
    expect(await ethers.provider.getBalance(await attacker.getAddress())).to.equal(amount);
  });
});
