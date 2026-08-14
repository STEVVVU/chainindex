import { Interface } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { buildApi } from "../../src/api";
import { AbiEventDecoder, escrowEventAbi } from "../../src/decoder";
import type { Hex } from "../../src/domain";
import { EventIndexer } from "../../src/indexer";
import { IndexerMetrics } from "../../src/metrics";
import { FakeChainProvider } from "../../src/provider/fake-chain-provider";
import { IndexStore } from "../../src/store";

const contract = "0x1000000000000000000000000000000000000001" as Hex;

describe("query API", () => {
  const close: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const callback of close.splice(0).reverse()) await callback();
  });

  it("paginates normalized events and exports Prometheus metrics", async () => {
    const chain = new FakeChainProvider();
    const store = new IndexStore();
    const metrics = new IndexerMetrics();
    const decoder = new AbiEventDecoder();
    const eventInterface = new Interface(escrowEventAbi);
    const fragment = eventInterface.getEvent("Deposited");
    if (fragment === null) throw new Error("Deposited event missing");
    const encoded = eventInterface.encodeEventLog(fragment, [
      1n,
      "0x2000000000000000000000000000000000000002",
      "0x3000000000000000000000000000000000000003",
      "0x4000000000000000000000000000000000000004",
      1000n,
      1_800_000_000n
    ]);
    chain.mine([
      {
        address: contract,
        topics: encoded.topics as Hex[],
        data: encoded.data as Hex
      }
    ]);
    const indexer = new EventIndexer(chain, store, decoder, metrics, {
      chainId: 31337,
      streamId: `escrow:${contract}`,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 10
    });
    await indexer.syncOnce();
    const app = buildApi(store, metrics);
    close.push(() => store.close(), () => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/v1/events?chainId=31337&eventName=Deposited&limit=1"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ eventName: "Deposited", blockNumber: 1 }]
    });

    const badQuery = await app.inject({
      method: "GET",
      url: "/v1/events?chainId=31337&fromBlock=10&toBlock=2"
    });
    expect(badQuery.statusCode).toBe(400);

    const metricsResponse = await app.inject({ method: "GET", url: "/metrics" });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.headers["content-type"]).toContain("text/plain");
    expect(metricsResponse.body).toContain("chainindex_blocks_processed_total");
  });
});
