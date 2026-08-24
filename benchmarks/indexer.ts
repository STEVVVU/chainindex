import { Interface } from "ethers";
import { AbiEventDecoder, escrowEventAbi } from "../src/decoder";
import type { Hex } from "../src/domain";
import { EventIndexer } from "../src/indexer";
import { IndexerMetrics } from "../src/metrics";
import { FakeChainProvider } from "../src/provider/fake-chain-provider";
import { IndexStore } from "../src/store";

const blockCount = Number(process.env.BENCHMARK_BLOCKS ?? "10000");
if (!Number.isSafeInteger(blockCount) || blockCount <= 0) {
  throw new Error("BENCHMARK_BLOCKS must be a positive safe integer");
}

/**
 * Number of timed repetitions.
 *
 * A single run is not a reproducible figure: on a contended developer machine the same
 * unchanged pipeline was measured between 550 and 1,960 blocks/s, a 3.5x spread driven
 * entirely by host CPU availability. Reporting a range makes that visible instead of
 * publishing whichever single number happened to be observed.
 */
const repeats = Number(process.env.BENCHMARK_REPEATS ?? "5");
if (!Number.isSafeInteger(repeats) || repeats <= 0) {
  throw new Error("BENCHMARK_REPEATS must be a positive safe integer");
}

const median = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const contract = "0x1000000000000000000000000000000000000001" as Hex;
const eventInterface = new Interface(escrowEventAbi);
const fragment = eventInterface.getEvent("Deposited");
if (fragment === null) throw new Error("Deposited ABI event missing");
const encoded = eventInterface.encodeEventLog(fragment, [
  1n,
  "0x2000000000000000000000000000000000000002",
  "0x3000000000000000000000000000000000000003",
  "0x4000000000000000000000000000000000000004",
  1000n,
  1_800_000_000n
]);

/** Runs one timed pass over a freshly built chain and store. */
const runOnce = async (): Promise<{
  elapsedSeconds: number;
  indexedBlocks: number;
  indexedEvents: number;
}> => {
  const chain = new FakeChainProvider("benchmark-v1");
  for (let block = 1; block <= blockCount; block += 1) {
    chain.mine([
      {
        address: contract,
        topics: encoded.topics as Hex[],
        data: encoded.data as Hex
      }
    ]);
  }

  const store = new IndexStore();
  const indexer = new EventIndexer(
    chain,
    store,
    new AbiEventDecoder(),
    new IndexerMetrics(),
    {
      chainId: 31337,
      streamId: `escrow:${contract}`,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 500
    }
  );

  const started = process.hrtime.bigint();
  const result = await indexer.syncOnce();
  const elapsedSeconds =
    Number(process.hrtime.bigint() - started) / 1_000_000_000;
  const indexedEvents = store.countEvents(31337);
  store.close();
  return { elapsedSeconds, indexedBlocks: result.blocks, indexedEvents };
};

const main = async (): Promise<void> => {
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    runs.push(await runOnce());
  }

  // Correctness is exact and must hold on every repetition; throughput is not.
  for (const run of runs) {
    if (run.indexedBlocks !== blockCount || run.indexedEvents !== blockCount) {
      throw new Error(
        `Benchmark correctness check failed: indexed ${String(run.indexedBlocks)} blocks ` +
          `and ${String(run.indexedEvents)} events, expected ${String(blockCount)} of each`
      );
    }
  }

  const elapsed = runs.map((run) => run.elapsedSeconds).sort((a, b) => a - b);
  const throughput = runs
    .map((run) => Math.round(blockCount / run.elapsedSeconds))
    .sort((a, b) => a - b);
  const round = (value: number): number => Number(value.toFixed(3));

  const artifact = {
    schemaVersion: 2,
    workload: {
      provider: "deterministic in-process fake chain",
      blocks: blockCount,
      logsPerBlock: 1,
      batchSize: 500,
      storage: "SQLite :memory:",
      confirmations: 0,
      repeats
    },
    result: {
      indexedBlocks: blockCount,
      indexedEvents: blockCount,
      elapsedSeconds: {
        min: round(elapsed[0] ?? 0),
        median: round(median(elapsed)),
        max: round(elapsed[elapsed.length - 1] ?? 0)
      },
      blocksPerSecond: {
        min: throughput[0] ?? 0,
        median: Math.round(median(throughput)),
        max: throughput[throughput.length - 1] ?? 0
      }
    },
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`
    }
  };

  console.log(JSON.stringify(artifact, null, 2));
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
