import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  type ContractTransactionResponse,
  type Signer
} from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbiEventDecoder } from "../../src/decoder";
import type { Hex } from "../../src/domain";
import { EventIndexer } from "../../src/indexer";
import { IndexerMetrics } from "../../src/metrics";
import { EthersJsonRpcProvider } from "../../src/provider/json-rpc-provider";
import { IndexStore } from "../../src/store";
import { readEscrowArtifact } from "./escrow-artifact";
import { mineBlock, rpc, startDevNode, TEST_MNEMONIC, type DevNode } from "./dev-node";

/**
 * End-to-end indexer tests against a real JSON-RPC node.
 *
 * The `tests/indexer` suite runs against `FakeChainProvider` and is the fast unit
 * tier. It is deliberately kept, but it can only prove the indexer is correct with
 * respect to a fake we wrote ourselves. This suite closes that gap: a genuine EVM
 * node produces the block hashes, the real `SafeEscrow` emits the logs, and the
 * indexer reads them through `EthersJsonRpcProvider` over HTTP.
 *
 * The reorg case is the important one. The repo's headline claim is reorg-safety, so
 * it is proven here by snapshotting the chain, mining one history, reverting, then
 * mining a genuinely different history with different transactions. The node
 * recomputes real block hashes, so the indexer must detect the divergence and roll
 * back to the common ancestor exactly as it would on a live network.
 */

// A dedicated port so this suite does not contend with any other local chain.
const RPC_PORT = 18_546;
const CHAIN_ID = 31_337;

let node: DevNode;
let provider: JsonRpcProvider;
let signers: Signer[];

/**
 * Hardhat Network and anvil both pre-fund accounts derived from the same well-known
 * public test mnemonic, so deriving locally avoids depending on a node-specific
 * account-listing RPC. The BIP-44 path must be spelled out in full: `Wallet.fromPhrase`
 * already returns account 0, so derivating further from it yields unfunded addresses.
 */
const deriveSigners = (count: number, rpcProvider: JsonRpcProvider): Signer[] =>
  Array.from({ length: count }, (_, index) =>
    HDNodeWallet.fromPhrase(
      TEST_MNEMONIC,
      undefined,
      `m/44'/60'/0'/0/${String(index)}`
    ).connect(rpcProvider)
  );

beforeAll(async () => {
  node = await startDevNode(RPC_PORT);
  provider = new JsonRpcProvider(node.url, CHAIN_ID, { staticNetwork: true });
  signers = deriveSigners(4, provider);
  // Surfaced so a CI log makes clear which backend actually ran.
  console.log(`real-node suite backend: ${node.kind} at ${node.url}`);
}, 90_000);

afterAll(async () => {
  provider?.destroy();
  await node?.stop();
});

/** Deploys a fresh escrow and returns it plus the block it landed in. */
const deployEscrow = async (
  admin: Signer
): Promise<{ address: Hex; deployBlock: number }> => {
  const artifact = readEscrowArtifact();
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, admin);
  const deployTx = await factory.getDeployTransaction(await admin.getAddress());
  const sent = await admin.sendTransaction(deployTx);
  await mineBlock(node.url);
  const receipt = await provider.getTransactionReceipt(sent.hash);
  if (receipt === null) throw new Error("Escrow deployment was not mined");
  return {
    address: receipt.contractAddress?.toLowerCase() as Hex,
    deployBlock: receipt.blockNumber
  };
};

const buildIndexer = (
  address: Hex,
  startBlock: number,
  overrides: { confirmations?: number; batchSize?: number } = {}
): { indexer: EventIndexer; store: IndexStore } => {
  const store = new IndexStore();
  const indexer = new EventIndexer(
    new EthersJsonRpcProvider(node.url),
    store,
    new AbiEventDecoder(),
    new IndexerMetrics(),
    {
      chainId: CHAIN_ID,
      streamId: `escrow:${address}`,
      contractAddress: address,
      startBlock,
      confirmations: overrides.confirmations ?? 0,
      batchSize: overrides.batchSize ?? 10
    }
  );
  return { indexer, store };
};

/** Submits a deposit and mines it into its own block, returning that block number. */
const depositInOwnBlock = async (
  escrowAddress: Hex,
  payer: Signer,
  payee: string,
  arbiter: string,
  value: bigint
): Promise<number> => {
  const latest = await provider.getBlock("latest");
  if (latest === null) throw new Error("Latest block unavailable");
  const deadline = latest.timestamp + 86_400;

  const escrow = new Contract(
    escrowAddress,
    readEscrowArtifact().abi,
    payer
  ) as Contract & {
    deposit: (
      payee_: string,
      arbiter_: string,
      refundAfter: number,
      overrides: { value: bigint }
    ) => Promise<ContractTransactionResponse>;
  };

  const tx = await escrow.deposit(payee, arbiter, deadline, { value });
  await mineBlock(node.url);
  const receipt = await provider.getTransactionReceipt(tx.hash);
  if (receipt === null) throw new Error("Deposit was not mined");
  if (receipt.status !== 1) throw new Error("Deposit reverted on the real node");
  return receipt.blockNumber;
};

describe("indexer against a real JSON-RPC node", () => {
  it("indexes real logs emitted by the deployed escrow", async () => {
    const [admin, payer, payee, arbiter] = signers;
    if (!admin || !payer || !payee || !arbiter) throw new Error("Missing signers");
    const { address, deployBlock } = await deployEscrow(admin);
    const { indexer, store } = buildIndexer(address, deployBlock);

    try {
      await depositInOwnBlock(
        address,
        payer,
        await payee.getAddress(),
        await arbiter.getAddress(),
        1_000_000_000_000_000n
      );

      const result = await indexer.syncOnce();
      const events = store.queryEvents({ chainId: CHAIN_ID, limit: 100 });

      expect(result.newEvents).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventName).toBe("Deposited");
      // Proves the value round-tripped through real ABI encoding on a real node.
      expect(events[0]?.args).toMatchObject({
        escrowId: "1",
        payer: (await payer.getAddress()).toLowerCase(),
        amount: "1000000000000000"
      });

      // Block metadata must match what the node reports, not a fake's synthetic hash.
      const stored = store.getBlock(CHAIN_ID, events[0]?.blockNumber ?? 0);
      const canonical = await provider.getBlock(events[0]?.blockNumber ?? 0);
      expect(stored?.hash).toBe(canonical?.hash);
    } finally {
      store.close();
    }
  }, 90_000);

  it("is idempotent when a real range is deliberately replayed", async () => {
    const [admin, payer, payee, arbiter] = signers;
    if (!admin || !payer || !payee || !arbiter) throw new Error("Missing signers");
    const { address, deployBlock } = await deployEscrow(admin);
    const { indexer, store } = buildIndexer(address, deployBlock);

    try {
      await depositInOwnBlock(
        address,
        payer,
        await payee.getAddress(),
        await arbiter.getAddress(),
        5_000_000_000_000_000n
      );
      expect((await indexer.syncOnce()).newEvents).toBe(1);

      store.rewindCheckpoint(CHAIN_ID, `escrow:${address}`, deployBlock);
      const replay = await indexer.syncOnce();

      // Re-reading the same real logs must not duplicate rows.
      expect(replay.newEvents).toBe(0);
      expect(store.countEvents(CHAIN_ID)).toBe(1);
    } finally {
      store.close();
    }
  }, 90_000);

  it("recovers from a real chain reorganization produced by the node", async () => {
    const [admin, payer, payee, arbiter] = signers;
    if (!admin || !payer || !payee || !arbiter) throw new Error("Missing signers");
    const { address, deployBlock } = await deployEscrow(admin);
    const { indexer, store } = buildIndexer(address, deployBlock);
    const payeeAddress = await payee.getAddress();
    const arbiterAddress = await arbiter.getAddress();

    try {
      // Snapshot the pre-fork state. Everything mined after this point is discardable.
      const snapshot = await rpc<string>(node.url, "evm_snapshot");

      // Fork A: one deposit, indexed and committed.
      const forkABlock = await depositInOwnBlock(
        address,
        payer,
        payeeAddress,
        arbiterAddress,
        1_000_000_000_000_000n
      );
      await indexer.syncOnce();

      const forkAHash = store.getBlock(CHAIN_ID, forkABlock)?.hash;
      expect(forkAHash).toBeDefined();
      expect(store.countEvents(CHAIN_ID)).toBe(1);

      // Discard fork A on the node. The indexer still holds fork A's headers/events.
      const reverted = await rpc<boolean>(node.url, "evm_revert", [snapshot]);
      expect(reverted).toBe(true);

      // Fork B: a different history at the same heights. The differing deposit value
      // changes the transaction, so the node computes genuinely different block hashes
      // rather than replaying identical empty blocks.
      const forkBBlock = await depositInOwnBlock(
        address,
        payer,
        payeeAddress,
        arbiterAddress,
        7_000_000_000_000_000n
      );
      await depositInOwnBlock(
        address,
        payer,
        payeeAddress,
        arbiterAddress,
        9_000_000_000_000_000n
      );
      expect(forkBBlock).toBe(forkABlock);

      const canonicalForkB = await provider.getBlock(forkBBlock);
      // Guard the premise: if these matched, the test would prove nothing.
      expect(canonicalForkB?.hash).not.toBe(forkAHash);

      // The indexer must detect the divergence, roll back to the common ancestor, and
      // re-index fork B.
      const recovery = await indexer.syncOnce();
      expect(recovery.reorgDepth).toBeGreaterThan(0);

      // Post-recovery state must reflect fork B only, with no orphaned rows left.
      expect(store.getBlock(CHAIN_ID, forkBBlock)?.hash).toBe(canonicalForkB?.hash);
      const events = store.queryEvents({ chainId: CHAIN_ID, limit: 100 });
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.args.amount)).toEqual([
        "7000000000000000",
        "9000000000000000"
      ]);
      for (const event of events) {
        const canonical = await provider.getBlock(event.blockNumber);
        expect(event.blockHash).toBe(canonical?.hash);
      }
    } finally {
      store.close();
    }
  }, 120_000);
});
