import { JsonRpcProvider } from "ethers";
import type { ChainBlock, ChainLog, Hex, LogFilter } from "../domain";
import type { ChainProvider } from "./chain-provider";

export class EthersJsonRpcProvider implements ChainProvider {
  readonly provider: JsonRpcProvider;

  constructor(url: string) {
    this.provider = new JsonRpcProvider(url, undefined, {
      staticNetwork: false
    });
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async getBlock(blockNumber: number): Promise<ChainBlock> {
    const block = await this.provider.getBlock(blockNumber);
    if (block === null || block.hash === null) {
      throw new Error(`Block ${blockNumber} was not returned by the RPC provider`);
    }
    return {
      number: block.number,
      hash: block.hash as Hex,
      parentHash: block.parentHash as Hex,
      timestamp: block.timestamp
    };
  }

  async getLogs(filter: LogFilter): Promise<readonly ChainLog[]> {
    const topics = filter.topics?.map(
      (topic): string | string[] | null => {
        if (topic === null || typeof topic === "string") return topic;
        return Array.from(topic);
      }
    );
    const logs = await this.provider.getLogs({
      address: filter.address,
      fromBlock: filter.fromBlock,
      toBlock: filter.toBlock,
      topics
    });
    return logs.map((log) => ({
      address: log.address as Hex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash as Hex,
      transactionHash: log.transactionHash as Hex,
      transactionIndex: log.transactionIndex,
      logIndex: log.index,
      topics: log.topics as Hex[],
      data: log.data as Hex
    }));
  }
}
