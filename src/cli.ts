import { buildApi } from "./api";
import { loadConfig, type AppConfig } from "./config";
import { AbiEventDecoder } from "./decoder";
import { EventIndexer } from "./indexer";
import { IndexerMetrics } from "./metrics";
import { EthersJsonRpcProvider } from "./provider/json-rpc-provider";
import { ResilientProvider } from "./provider/resilient-provider";
import { IndexStore } from "./store";

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const buildRuntime = (config: AppConfig) => {
  const store = new IndexStore(config.databasePath);
  const metrics = new IndexerMetrics(true);
  const provider = new ResilientProvider(
    new EthersJsonRpcProvider(config.rpcUrl),
    {
      requestsPerSecond: config.requestsPerSecond,
      maxRetries: config.maxRetries,
      onRetry: ({ operation }) => {
        metrics.rpcRetries.inc({ operation });
      }
    }
  );
  const indexer = new EventIndexer(
    provider,
    store,
    new AbiEventDecoder(),
    metrics,
    {
      chainId: config.chainId,
      streamId: `escrow:${config.contractAddress.toLowerCase()}`,
      contractAddress: config.contractAddress,
      startBlock: config.startBlock,
      confirmations: config.confirmations,
      batchSize: config.batchSize
    }
  );
  return { store, metrics, indexer };
};

const serve = async (config: AppConfig): Promise<void> => {
  const runtime = buildRuntime(config);
  const app = buildApi(runtime.store, runtime.metrics);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await app.listen({ host: config.host, port: config.port });
    while (!stopping) {
      try {
        const result = await runtime.indexer.syncOnce();
        app.log.info(result, "indexing pass complete");
      } catch (error) {
        app.log.error(error, "indexing pass failed");
      }
      await sleep(5_000);
    }
  } finally {
    await app.close();
    runtime.store.close();
  }
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const command = process.argv[2] ?? "sync";
  if (command === "serve") {
    await serve(config);
    return;
  }

  const runtime = buildRuntime(config);
  try {
    if (command === "sync") {
      console.log(JSON.stringify(await runtime.indexer.syncOnce(), null, 2));
      return;
    }
    if (command === "backfill") {
      const [id, fromValue, toValue] = process.argv.slice(3);
      if (id === undefined || fromValue === undefined || toValue === undefined) {
        throw new Error("Usage: npm run dev -- backfill <id> <fromBlock> <toBlock>");
      }
      const fromBlock = Number(fromValue);
      const toBlock = Number(toValue);
      if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock)) {
        throw new Error("Backfill bounds must be safe integers");
      }
      try {
        runtime.indexer.createBackfill(id, fromBlock, toBlock);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint")) {
          throw error;
        }
      }
      console.log(
        JSON.stringify(await runtime.indexer.runBackfill(id), null, 2)
      );
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    runtime.store.close();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
