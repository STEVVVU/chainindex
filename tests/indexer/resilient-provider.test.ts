import { describe, expect, it } from "vitest";
import { FakeChainProvider } from "../../src/provider/fake-chain-provider";
import { ResilientProvider } from "../../src/provider/resilient-provider";

describe("ResilientProvider", () => {
  it("retries transient failures with bounded exponential delays", async () => {
    const chain = new FakeChainProvider();
    chain.failNext("getBlockNumber", 2);
    const delays: number[] = [];
    const retries: number[] = [];
    const provider = new ResilientProvider(chain, {
      requestsPerSecond: 1_000_000,
      maxRetries: 2,
      baseDelayMs: 25,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
      onRetry: ({ attempt }) => retries.push(attempt)
    });

    await expect(provider.getBlockNumber()).resolves.toBe(0);
    expect(chain.calls.getBlockNumber).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(delays.filter((delay) => delay >= 25)).toEqual([25, 50]);
  });

  it("stops once the retry budget is exhausted", async () => {
    const chain = new FakeChainProvider();
    chain.failNext("getBlock", 3);
    const provider = new ResilientProvider(chain, {
      requestsPerSecond: 1_000_000,
      maxRetries: 2,
      sleep: () => Promise.resolve()
    });

    await expect(provider.getBlock(0)).rejects.toThrow("Injected getBlock failure");
    expect(chain.calls.getBlock).toBe(3);
  });
});
