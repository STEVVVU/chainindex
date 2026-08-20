import { defineConfig } from "vitest/config";

/**
 * Separate config for the real-node E2E suite.
 *
 * It is kept out of the default `vitest run tests/indexer` invocation on purpose: the
 * unit tier must stay fast and hermetic, while this tier spawns a real EVM node,
 * compiles contracts, and takes tens of seconds.
 *
 * The suites share one chain per file and mutate it (snapshot/revert), so they must
 * not run in parallel against the same node.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    // One process, no concurrency: the reorg test reverts global chain state.
    fileParallelism: false,
    pool: "forks",
    maxForks: 1,
    minForks: 1,
    // Spawning a node plus compiling contracts dwarfs the default 5s timeout.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000
  }
});
