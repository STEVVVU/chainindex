import { Interface, type LogDescription } from "ethers";
import type { ChainLog, NormalizedEvent } from "./domain";

export const escrowEventAbi = [
  "event Deposited(uint256 indexed escrowId,address indexed payer,address indexed payee,address arbiter,uint256 amount,uint256 refundAfter)",
  "event Released(uint256 indexed escrowId,address indexed authorizedBy,address indexed payee,uint256 amount)",
  "event Refunded(uint256 indexed escrowId,address indexed authorizedBy,address indexed payer,uint256 amount)"
] as const;

export interface EventDecoder {
  readonly topics: readonly string[];
  decode(chainId: number, streamId: string, log: ChainLog): NormalizedEvent | null;
}

const normalizeValue = (value: unknown): boolean | null | number | string => {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.startsWith("0x") ? value.toLowerCase() : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  throw new TypeError("Unsupported composite ABI event value");
};

export class AbiEventDecoder implements EventDecoder {
  private readonly contractInterface: Interface;
  readonly topics: readonly string[];

  constructor(abi: readonly string[] = escrowEventAbi) {
    this.contractInterface = new Interface(abi);
    const topics: string[] = [];
    this.contractInterface.forEachEvent((fragment) => {
      topics.push(fragment.topicHash);
    });
    this.topics = topics;
  }

  decode(chainId: number, streamId: string, log: ChainLog): NormalizedEvent | null {
    let parsed: LogDescription | null;
    try {
      parsed = this.contractInterface.parseLog({
        topics: [...log.topics],
        data: log.data
      });
    } catch {
      return null;
    }
    if (parsed === null || log.topics[0] === undefined) return null;

    const args: Record<string, boolean | null | number | string> = {};
    parsed.fragment.inputs.forEach((input, index) => {
      args[input.name || String(index)] = normalizeValue(parsed.args[index]);
    });

    return {
      chainId,
      streamId,
      address: log.address.toLowerCase() as NormalizedEvent["address"],
      blockNumber: log.blockNumber,
      blockHash: log.blockHash.toLowerCase() as NormalizedEvent["blockHash"],
      transactionHash: log.transactionHash.toLowerCase() as NormalizedEvent["transactionHash"],
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      topic0: log.topics[0].toLowerCase() as NormalizedEvent["topic0"],
      eventName: parsed.name,
      args
    };
  }
}
