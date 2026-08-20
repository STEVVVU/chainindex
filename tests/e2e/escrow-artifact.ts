import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InterfaceAbi } from "ethers";

const ARTIFACT_PATH = join(
  __dirname,
  "..",
  "..",
  "artifacts",
  "contracts",
  "SafeEscrow.sol",
  "SafeEscrow.json"
);

export interface EscrowArtifact {
  abi: InterfaceAbi;
  bytecode: string;
}

let cached: EscrowArtifact | undefined;

/**
 * Loads the compiled `SafeEscrow` artifact produced by `hardhat compile`.
 *
 * The E2E suite deploys the *real* contract to a real node, so it needs real bytecode.
 * Reading Hardhat's artifact keeps a single source of truth: the bytecode under test
 * is the same one the Hardhat contract suite exercises, compiled by the pinned
 * solc 0.8.28. `npm run test:e2e` compiles first so this file is guaranteed present.
 */
export const readEscrowArtifact = (): EscrowArtifact => {
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    raw = readFileSync(ARTIFACT_PATH, "utf8");
  } catch {
    throw new Error(
      `Compiled SafeEscrow artifact not found at ${ARTIFACT_PATH}. ` +
        "Run `npx hardhat compile` first (npm run test:e2e does this automatically)."
    );
  }
  const parsed = JSON.parse(raw) as { abi?: unknown; bytecode?: unknown };
  if (!Array.isArray(parsed.abi) || typeof parsed.bytecode !== "string") {
    throw new Error("SafeEscrow artifact is missing its abi or bytecode");
  }
  cached = { abi: parsed.abi as InterfaceAbi, bytecode: parsed.bytecode };
  return cached;
};
