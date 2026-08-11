import type { ChainBlock, ChainLog, LogFilter } from "../domain";

export interface ChainProvider {
  getBlockNumber(): Promise<number>;
  getBlock(blockNumber: number): Promise<ChainBlock>;
  getLogs(filter: LogFilter): Promise<readonly ChainLog[]>;
}
