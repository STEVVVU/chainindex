import type { ChainBlock, ChainLog, LogFilter } from "../domain";
import type { ChainProvider } from "./chain-provider";

export interface RetryNotice {
  operation: string;
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface ResilientProviderOptions {
  requestsPerSecond: number;
  maxRetries: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (notice: RetryNotice) => void;
}

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export class ResilientProvider implements ChainProvider {
  private readonly minimumIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private readonly inner: ChainProvider,
    private readonly options: ResilientProviderOptions
  ) {
    if (options.requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond must be positive");
    }
    if (options.maxRetries < 0) {
      throw new Error("maxRetries cannot be negative");
    }
    this.minimumIntervalMs = 1_000 / options.requestsPerSecond;
    this.sleep = options.sleep ?? defaultSleep;
  }

  getBlockNumber(): Promise<number> {
    return this.run("getBlockNumber", () => this.inner.getBlockNumber());
  }

  getBlock(blockNumber: number): Promise<ChainBlock> {
    return this.run("getBlock", () => this.inner.getBlock(blockNumber));
  }

  getLogs(filter: LogFilter): Promise<readonly ChainLog[]> {
    return this.run("getLogs", () => this.inner.getLogs(filter));
  }

  private async run<T>(operation: string, request: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = (): void => undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      for (let attempt = 0; ; attempt += 1) {
        const waitMs = Math.max(0, this.nextRequestAt - Date.now());
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }
        this.nextRequestAt = Date.now() + this.minimumIntervalMs;

        try {
          return await request();
        } catch (error) {
          if (attempt >= this.options.maxRetries) {
            throw error;
          }
          const delayMs = (this.options.baseDelayMs ?? 100) * 2 ** attempt;
          this.options.onRetry?.({
            operation,
            attempt: attempt + 1,
            delayMs,
            error
          });
          await this.sleep(delayMs);
        }
      }
    } finally {
      release();
    }
  }
}
