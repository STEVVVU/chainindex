export type Hex = `0x${string}`;

export interface ChainBlock {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
}

export interface ChainLog {
  address: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  topics: readonly Hex[];
  data: Hex;
}

export interface LogFilter {
  address: Hex;
  fromBlock: number;
  toBlock: number;
  topics?: readonly (Hex | readonly Hex[] | null)[];
}

export interface NormalizedEvent {
  chainId: number;
  streamId: string;
  address: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  topic0: Hex;
  eventName: string;
  args: Record<string, boolean | null | number | string>;
}

export interface Checkpoint {
  chainId: number;
  streamId: string;
  nextBlock: number;
  lastHash: Hex | null;
}

export interface BackfillJob {
  id: string;
  chainId: number;
  streamId: string;
  fromBlock: number;
  toBlock: number;
  nextBlock: number;
  status: "pending" | "running" | "complete";
}

export interface EventQuery {
  chainId: number;
  streamId?: string;
  address?: string;
  eventName?: string;
  fromBlock?: number;
  toBlock?: number;
  cursor?: number;
  limit: number;
}

export interface StoredEvent extends NormalizedEvent {
  id: number;
}
