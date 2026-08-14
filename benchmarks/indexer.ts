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

const main = async (): Promise<void> => {
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
  const artifact = {
    schemaVersion: 1,
    workload: {
      provider: "deterministic in-process fake chain",
      blocks: blockCount,
      logsPerBlock: 1,
      batchSize: 500,
      storage: "SQLite :memory:",
      confirmations: 0
    },
    result: {
      indexedBlocks: result.blocks,
      indexedEvents: store.countEvents(31337),
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      blocksPerSecond: Math.round(blockCount / elapsedSeconds)
    },
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`
    }
  };

  console.log(JSON.stringify(artifact, null, 2));
  store.close();
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
