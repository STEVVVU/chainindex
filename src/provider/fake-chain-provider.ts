import { keccak256, toUtf8Bytes } from "ethers";
import type { ChainBlock, ChainLog, Hex, LogFilter } from "../domain";
import type { ChainProvider } from "./chain-provider";

export interface FakeLogInput {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
}

type ProviderMethod = "getBlock" | "getBlockNumber" | "getLogs";

const hash = (value: string): Hex => keccak256(toUtf8Bytes(value)) as Hex;

export class FakeChainProvider implements ChainProvider {
  private blocks: ChainBlock[] = [];
  private logs: ChainLog[] = [];
  private epoch = 0;
  private failures = new Map<ProviderMethod, number>();
  readonly calls: Record<ProviderMethod, number> = {
    getBlock: 0,
    getBlockNumber: 0,
    getLogs: 0
  };

  constructor(private readonly seed = "chainindex") {
    this.blocks.push({
      number: 0,
      hash: hash(`${seed}:genesis`),
      parentHash: `0x${"0".repeat(64)}`,
      timestamp: 1_700_000_000
    });
  }

  getBlockNumber(): Promise<number> {
    this.calls.getBlockNumber += 1;
    this.maybeFail("getBlockNumber");
    return Promise.resolve(this.blocks.length - 1);
  }

  getBlock(blockNumber: number): Promise<ChainBlock> {
    this.calls.getBlock += 1;
    this.maybeFail("getBlock");
    const block = this.blocks[blockNumber];
    if (block === undefined) throw new Error(`Fake block ${blockNumber} does not exist`);
    return Promise.resolve({ ...block });
  }

  getLogs(filter: LogFilter): Promise<readonly ChainLog[]> {
    this.calls.getLogs += 1;
    this.maybeFail("getLogs");
    return Promise.resolve(
      this.logs
        .filter(
          (log) =>
            log.blockNumber >= filter.fromBlock &&
            log.blockNumber <= filter.toBlock &&
            log.address.toLowerCase() === filter.address.toLowerCase() &&
            this.matchesTopics(log, filter.topics)
        )
        .map((log) => ({ ...log, topics: [...log.topics] }))
    );
  }

  mine(inputs: readonly FakeLogInput[] = []): ChainBlock {
    const parent = this.blocks.at(-1);
    if (parent === undefined) throw new Error("Fake chain has no genesis block");
    const number = parent.number + 1;
    const blockHash = hash(`${this.seed}:${this.epoch}:${number}:${parent.hash}`);
    const block: ChainBlock = {
      number,
      hash: blockHash,
      parentHash: parent.hash,
      timestamp: parent.timestamp + 12
    };
    this.blocks.push(block);
    inputs.forEach((input, logIndex) => {
      this.logs.push({
        address: input.address,
        blockNumber: number,
        blockHash,
        transactionHash: hash(
          `${this.seed}:tx:${this.epoch}:${number}:${logIndex}`
        ),
        transactionIndex: logIndex,
        logIndex,
        topics: [...input.topics],
        data: input.data
      });
    });
    return block;
  }

  reorg(fromBlock: number, replacement: readonly (readonly FakeLogInput[])[]): void {
    if (fromBlock <= 0 || fromBlock >= this.blocks.length) {
      throw new Error("Reorg must replace one or more existing non-genesis blocks");
    }
    this.blocks = this.blocks.slice(0, fromBlock);
    this.logs = this.logs.filter((log) => log.blockNumber < fromBlock);
    this.epoch += 1;
    for (const inputs of replacement) this.mine(inputs);
  }

  failNext(method: ProviderMethod, times = 1): void {
    this.failures.set(method, (this.failures.get(method) ?? 0) + times);
  }

  private maybeFail(method: ProviderMethod): void {
    const remaining = this.failures.get(method) ?? 0;
    if (remaining <= 0) return;
    this.failures.set(method, remaining - 1);
    throw new Error(`Injected ${method} failure`);
  }

  private matchesTopics(
    log: ChainLog,
    filter: LogFilter["topics"]
  ): boolean {
    if (filter === undefined) return true;
    return filter.every((candidate, index) => {
      if (candidate === null) return true;
      const actual = log.topics[index];
      if (actual === undefined) return false;
      if (typeof candidate === "string") {
        return candidate.toLowerCase() === actual.toLowerCase();
      }
      return candidate.some(
        (topic) => topic.toLowerCase() === actual.toLowerCase()
      );
    });
  }
}
