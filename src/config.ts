import { z } from "zod";
import type { Hex } from "./domain";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hexadecimal address");

const envSchema = z.object({
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  CONTRACT_ADDRESS: address,
  DATABASE_PATH: z.string().min(1).default("./chainindex.sqlite"),
  START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
  BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(500),
  RPC_REQUESTS_PER_SECOND: z.coerce.number().positive().max(1_000).default(10),
  RPC_MAX_RETRIES: z.coerce.number().int().nonnegative().max(10).default(4),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1")
});

export interface AppConfig {
  rpcUrl: string;
  chainId: number;
  contractAddress: Hex;
  databasePath: string;
  startBlock: number;
  confirmations: number;
  batchSize: number;
  requestsPerSecond: number;
  maxRetries: number;
  port: number;
  host: string;
}

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env
): AppConfig => {
  const parsed = envSchema.parse(environment);
  return {
    rpcUrl: parsed.RPC_URL,
    chainId: parsed.CHAIN_ID,
    contractAddress: parsed.CONTRACT_ADDRESS.toLowerCase() as Hex,
    databasePath: parsed.DATABASE_PATH,
    startBlock: parsed.START_BLOCK,
    confirmations: parsed.CONFIRMATIONS,
    batchSize: parsed.BATCH_SIZE,
    requestsPerSecond: parsed.RPC_REQUESTS_PER_SECOND,
    maxRetries: parsed.RPC_MAX_RETRIES,
    port: parsed.PORT,
    host: parsed.HOST
  };
};
