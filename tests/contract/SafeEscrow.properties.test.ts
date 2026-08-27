import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Signer } from "ethers";

/**
 * Randomized property checks for `SafeEscrow`, run under Hardhat.
 *
 * The authoritative property-based suite is `tests/foundry/` (fuzz + invariant), which
 * needs Foundry on PATH. This file asserts the *same* core properties with a small
 * seeded random walk in TypeScript, so the properties are still exercised in the default
 * `npm test` run on a machine without Foundry.
 *
 * It is a safety net, not a replacement: Foundry explores far more states and shrinks
 * counterexamples. Keep the two in sync -- if a property changes here, change it there.
 */

/** Deterministic PRNG (mulberry32) so a failure is reproducible from the seed. */
const createRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("SafeEscrow properties", () => {
  const SEED = 20260728;
  const STEPS = 60;

  it("holds solvency, access control, and pause-liveness across a random walk", async () => {
    const signers = await ethers.getSigners();
    const [admin, ...actors] = signers;
    if (admin === undefined || actors.length < 4) {
      throw new Error("Fixture requires an admin plus four actors");
    }

    const factory = await ethers.getContractFactory("SafeEscrow");
    const escrow = await factory.deploy(admin.address);
    await escrow.waitForDeployment();
    const escrowAddress = await escrow.getAddress();

    const random = createRandom(SEED);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      if (item === undefined) throw new Error("Empty selection");
      return item;
    };

    // Mirrors the Foundry handler's bookkeeping.
    const liveIds: bigint[] = [];
    const settledIds: bigint[] = [];
    let deposits = 0;
    let settlements = 0;
    let unauthorizedSettlements = 0;
    let blockedWhilePaused = 0;

    /** Sums the amount field of every allocated escrow: total outstanding liability. */
    const outstanding = async (): Promise<bigint> => {
      const next = await escrow.nextEscrowId();
      let total = 0n;
      for (let id = 1n; id < next; id += 1n) {
        total += (await escrow.escrows(id)).amount;
      }
      return total;
    };

    const distinctThree = (): [Signer & { address: string }, string, string] => {
      const pool = [...actors];
      const first = pick(pool);
      const rest = pool.filter((s) => s.address !== first.address);
      const second = pick(rest);
      const third = pick(rest.filter((s) => s.address !== second.address));
      return [first, second.address, third.address];
    };

    for (let step = 0; step < STEPS; step += 1) {
      const paused = await escrow.paused();
      const action = random();

      if (action < 0.45) {
        // Fund a new escrow.
        const [payer, payee, arbiter] = distinctThree();
        const latest = await ethers.provider.getBlock("latest");
        if (latest === null) throw new Error("Latest block unavailable");
        const value = BigInt(Math.floor(random() * 1_000_000) + 1) * 1_000_000_000n;
        try {
          const tx = await escrow
            .connect(payer)
            .deposit(payee, arbiter, latest.timestamp + 86_400, { value });
          await tx.wait();
          liveIds.push(await escrow.nextEscrowId() - 1n);
          deposits += 1;
        } catch {
          // Only a paused contract may legitimately reject a well-formed deposit.
          expect(paused, "a well-formed deposit was rejected while unpaused").to.equal(true);
        }
      } else if (action < 0.75 && liveIds.length > 0) {
        // Settle as a genuine party. Must succeed even when paused.
        const escrowId = pick(liveIds);
        const record = await escrow.escrows(escrowId);
        const useRefund = random() < 0.5;
        const caller = useRefund
          ? actors.find((s) => s.address === record.payee)
          : actors.find(
              (s) => s.address === record.payer || s.address === record.arbiter
            );
        if (caller === undefined) continue;

        try {
          await (await escrow.connect(caller)[useRefund ? "refund" : "release"](escrowId)).wait();
          settlements += 1;
          liveIds.splice(liveIds.indexOf(escrowId), 1);
          settledIds.push(escrowId);
        } catch {
          if (record.status === 1n && paused) blockedWhilePaused += 1;
        }
      } else if (action < 0.9 && liveIds.length > 0) {
        // Attempt settlement as a non-party, including the pause admin.
        const escrowId = pick(liveIds);
        const record = await escrow.escrows(escrowId);
        const candidates: Signer[] = [
          admin,
          ...actors.filter(
            (s) =>
              s.address !== record.payer &&
              s.address !== record.payee &&
              s.address !== record.arbiter
          )
        ];
        const caller = pick(candidates);
        try {
          await (await escrow.connect(caller).release(escrowId)).wait();
          unauthorizedSettlements += 1;
        } catch {
          // Expected.
        }
        try {
          await (await escrow.connect(caller).refund(escrowId)).wait();
          unauthorizedSettlements += 1;
        } catch {
          // Expected.
        }
      } else {
        // Toggle the circuit breaker.
        await (await escrow.connect(admin)[paused ? "unpause" : "pause"]()).wait();
      }

      // Invariant 1 (solvency): held ETH always covers outstanding deposits.
      expect(
        await ethers.provider.getBalance(escrowAddress),
        `solvency broken at step ${String(step)} (seed ${String(SEED)})`
      ).to.be.gte(await outstanding());
    }

    // Invariant 2: no non-party ever settled.
    expect(
      unauthorizedSettlements,
      `a non-party settled an escrow (seed ${String(SEED)})`
    ).to.equal(0);

    // Invariant 3: pausing never blocked a funded escrow's own parties.
    expect(
      blockedWhilePaused,
      `pause blocked settlement of a funded escrow (seed ${String(SEED)})`
    ).to.equal(0);

    // Invariant 4: settled escrows are terminal.
    for (const escrowId of settledIds) {
      const record = await escrow.escrows(escrowId);
      expect(record.amount, "settled escrow retains a balance").to.equal(0n);
      expect([2n, 3n], "settled escrow left a non-terminal status").to.include(
        record.status
      );
    }

    // Coverage: the walk must have reached meaningful states, else the run is vacuous.
    expect(deposits, "no escrow was funded during the walk").to.be.greaterThan(0);
    expect(settlements, "no escrow was settled during the walk").to.be.greaterThan(0);

    // Leave the shared Hardhat chain unpaused for any later test.
    if (await escrow.paused()) await (await escrow.connect(admin).unpause()).wait();
    await network.provider.send("evm_mine", []);
  });
});
