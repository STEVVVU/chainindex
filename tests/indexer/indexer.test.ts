import { Interface } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { AbiEventDecoder, escrowEventAbi } from "../../src/decoder";
import type { Hex } from "../../src/domain";
import { EventIndexer, type IndexerConfig } from "../../src/indexer";
import { IndexerMetrics } from "../../src/metrics";
import {
  FakeChainProvider,
  type FakeLogInput
} from "../../src/provider/fake-chain-provider";
import { IndexStore } from "../../src/store";

const contract = "0x1000000000000000000000000000000000000001" as Hex;
const payer = "0x2000000000000000000000000000000000000002";
const payee = "0x3000000000000000000000000000000000000003";
const arbiter = "0x4000000000000000000000000000000000000004";
const streamId = `escrow:${contract}`;
const eventInterface = new Interface(escrowEventAbi);

const eventLog = (name: string, values: readonly unknown[]): FakeLogInput => {
  const fragment = eventInterface.getEvent(name);
  if (fragment === null) throw new Error(`Unknown fixture event ${name}`);
  const encoded = eventInterface.encodeEventLog(fragment, values);
  return {
    address: contract,
    topics: encoded.topics as Hex[],
    data: encoded.data as Hex
  };
};

const deposited = (id: bigint): FakeLogInput =>
  eventLog("Deposited", [id, payer, payee, arbiter, 1000n * id, 1_800_000_000n]);
const released = (id: bigint): FakeLogInput =>
  eventLog("Released", [id, payer, payee, 1000n * id]);
const refunded = (id: bigint): FakeLogInput =>
  eventLog("Refunded", [id, arbiter, payer, 1000n * id]);

const stores: IndexStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const harness = (
  overrides: Partial<IndexerConfig> = {}
): {
  chain: FakeChainProvider;
  store: IndexStore;
  indexer: EventIndexer;
  metrics: IndexerMetrics;
} => {
  const chain = new FakeChainProvider();
  const store = new IndexStore();
  stores.push(store);
  const metrics = new IndexerMetrics();
  const indexer = new EventIndexer(
    chain,
    store,
    new AbiEventDecoder(),
    metrics,
    {
      chainId: 31337,
      streamId,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 2,
      batchSize: 2,
      ...overrides
    }
  );
  return { chain, store, indexer, metrics };
};

describe("EventIndexer", () => {
  it("indexes only confirmed blocks and normalizes ABI values", async () => {
    const { chain, store, indexer } = harness();
    chain.mine([deposited(1n)]);
    chain.mine();
    chain.mine([released(1n)]);
    chain.mine([deposited(2n)]);
    chain.mine();

    const result = await indexer.syncOnce();
    const events = store.queryEvents({
      chainId: 31337,
      streamId,
      limit: 100
    });

    expect(result.safeBlock).toBe(3);
    expect(result.blocks).toBe(3);
    expect(result.newEvents).toBe(2);
    expect(result.nextBlock).toBe(4);
    expect(events.map((event) => event.eventName)).toEqual([
      "Deposited",
      "Released"
    ]);
    expect(events[0]?.args).toMatchObject({
      escrowId: "1",
      payer,
      payee,
      amount: "1000"
    });
  });

  it("is idempotent when the checkpoint is deliberately replayed", async () => {
    const { chain, store, indexer } = harness({ confirmations: 0 });
    chain.mine([deposited(1n)]);
    chain.mine([released(1n)]);

    expect((await indexer.syncOnce()).newEvents).toBe(2);
    store.rewindCheckpoint(31337, streamId, 1);
    const replay = await indexer.syncOnce();

    expect(replay.blocks).toBe(2);
    expect(replay.newEvents).toBe(0);
    expect(store.countEvents(31337, streamId)).toBe(2);
  });

  it("finds the common ancestor and replaces orphaned events after a reorg", async () => {
    const { chain, store, indexer } = harness({ confirmations: 0 });
    chain.mine([deposited(1n)]);
    chain.mine();
    chain.mine([released(1n)]);
    chain.mine();
    await indexer.syncOnce();

    chain.reorg(3, [[refunded(1n)], []]);
    const result = await indexer.syncOnce();
    const events = store.queryEvents({
      chainId: 31337,
      streamId,
      limit: 100
    });

    expect(result.reorgDepth).toBe(2);
    expect(events.map((event) => event.eventName)).toEqual([
      "Deposited",
      "Refunded"
    ]);
    expect(store.getBlock(31337, 3)?.hash).toEqual(
      await chain.getBlock(3).then((block) => block.hash)
    );
  });

  it("resumes a bounded backfill from durable job progress", async () => {
    const { chain, store, indexer, metrics } = harness({
      confirmations: 0,
      batchSize: 2
    });
    for (let number = 1; number <= 6; number += 1) {
      chain.mine(number % 2 === 0 ? [deposited(BigInt(number))] : []);
    }
    indexer.createBackfill("history-1", 1, 6);

    const partial = await indexer.runBackfill("history-1", 1);
    expect(partial).toMatchObject({ nextBlock: 3, status: "running" });

    const restarted = new EventIndexer(
      chain,
      store,
      new AbiEventDecoder(),
      metrics,
      indexer.config
    );
    const complete = await restarted.runBackfill("history-1");

    expect(complete).toMatchObject({ nextBlock: 7, status: "complete" });
    expect(store.countEvents(31337, streamId)).toBe(3);
  });

  it("rejects logs whose block hash does not match the fetched canonical block", async () => {
    const { chain, store, metrics } = harness({ confirmations: 0 });
    chain.mine([deposited(1n)]);
    const corruptHash: Hex = `0x${"f".repeat(64)}`;
    const corruptProvider = {
      getBlockNumber: () => chain.getBlockNumber(),
      getBlock: (number: number) => chain.getBlock(number),
      getLogs: async (...args: Parameters<FakeChainProvider["getLogs"]>) => {
        const logs = await chain.getLogs(...args);
        return logs.map((log) => ({
          ...log,
          blockHash: corruptHash
        }));
      }
    };
    const indexer = new EventIndexer(
      corruptProvider,
      store,
      new AbiEventDecoder(),
      metrics,
      {
        chainId: 31337,
        streamId,
        contractAddress: contract,
        startBlock: 1,
        confirmations: 0,
        batchSize: 10
      }
    );

    await expect(indexer.syncOnce()).rejects.toThrow(
      "log from a different fork"
    );
    expect(store.countEvents(31337, streamId)).toBe(0);
  });

  it("exposes reorg and processing metrics", async () => {
    const { chain, indexer, metrics } = harness({ confirmations: 0 });
    chain.mine([deposited(1n)]);
    chain.mine();
    await indexer.syncOnce();
    chain.reorg(2, [[released(1n)]]);
    await indexer.syncOnce();

    const output = await metrics.registry.metrics();
    expect(output).toContain("chainindex_blocks_processed_total");
    expect(output).toContain("chainindex_events_processed_total");
    expect(output).toContain("chainindex_reorgs_total{chain_id=\"31337\"} 1");
  });
});
