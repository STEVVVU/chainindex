import { spawn, type ChildProcess } from "node:child_process";

/**
 * Lifecycle helper for a real local JSON-RPC EVM node.
 *
 * The indexer's fast unit tests run against `FakeChainProvider`, which is a
 * hand-written stand-in. These helpers instead start a genuine node so the
 * reorg-safety claim is exercised against a real `eth_getLogs` / `eth_getBlockByNumber`
 * implementation, real RLP block hashing, and real receipt semantics.
 *
 * Two backends are supported and probed in order:
 *
 * - **anvil** (Foundry) when it is on `PATH`. Preferred, because it additionally
 *   exposes `anvil_reorg` for a first-class reorg primitive.
 * - **hardhat node** otherwise. Always available since Hardhat is a dev dependency.
 *
 * Both expose `evm_snapshot` / `evm_revert`, which is the portable way to build a
 * divergent chain, so the reorg test works on either backend.
 */

export type DevNodeKind = "anvil" | "hardhat";

export interface DevNode {
  readonly kind: DevNodeKind;
  readonly url: string;
  readonly chainId: number;
  stop(): Promise<void>;
}

/**
 * Test-only mnemonic. This is the well-known public default used by both anvil and
 * Hardhat Network; its keys are published in their documentation and hold no value on
 * any real network. It must never be reused for anything but a local test chain.
 */
export const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const RPC_READY_TIMEOUT_MS = 60_000;
const RPC_POLL_INTERVAL_MS = 250;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

/** Minimal JSON-RPC client. Deliberately dependency-free so it exercises the wire format. */
export const rpc = async <T>(
  url: string,
  method: string,
  params: readonly unknown[] = []
): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) {
    throw new Error(`RPC ${method} returned HTTP ${String(response.status)}`);
  }
  const payload = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (payload.error !== undefined) {
    throw new Error(`RPC ${method} failed: ${payload.error.message}`);
  }
  return payload.result as T;
};

const isListening = async (url: string): Promise<boolean> => {
  try {
    await rpc<string>(url, "web3_clientVersion");
    return true;
  } catch {
    return false;
  }
};

const waitForRpc = async (url: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + RPC_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Dev node exited with code ${String(child.exitCode)} before serving RPC`
      );
    }
    if (await isListening(url)) return;
    await sleep(RPC_POLL_INTERVAL_MS);
  }
  throw new Error(`Dev node did not serve RPC at ${url} within the timeout`);
};

/** Reports whether `anvil` is available, so tests can note which backend ran. */
export const detectAnvil = async (): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = spawn("anvil", ["--version"], {
      shell: process.platform === "win32",
      stdio: "ignore"
    });
    probe.once("error", () => resolve(false));
    probe.once("exit", (code) => resolve(code === 0));
  });

/**
 * Starts a local EVM node and resolves once it answers JSON-RPC.
 *
 * @param port TCP port for the node. Tests should use distinct ports so suites can
 *   run concurrently without contending for a single chain.
 */
export const startDevNode = async (port: number): Promise<DevNode> => {
  const useAnvil = await detectAnvil();
  const kind: DevNodeKind = useAnvil ? "anvil" : "hardhat";
  const url = `http://127.0.0.1:${String(port)}`;

  const child = useAnvil
    ? spawn(
        "anvil",
        [
          "--port",
          String(port),
          "--chain-id",
          "31337",
          "--mnemonic",
          TEST_MNEMONIC,
          "--no-mining",
          "--silent"
        ],
        { shell: process.platform === "win32", stdio: "ignore" }
      )
    : spawn(
        "npx",
        ["hardhat", "node", "--port", String(port), "--hostname", "127.0.0.1"],
        { shell: process.platform === "win32", stdio: "ignore" }
      );

  child.unref();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null) return;
    // Hardhat's node is an npx wrapper, so on Windows the child is a shim and
    // SIGTERM does not reach the real process. taskkill /T covers the tree.
    if (process.platform === "win32" && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore"
        });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
      return;
    }
    child.kill("SIGTERM");
  };

  try {
    await waitForRpc(url, child);
  } catch (error) {
    await stop();
    throw error;
  }

  // Manual mining keeps block production under test control, which is what makes the
  // reorg scenario deterministic. anvil takes --no-mining; Hardhat needs an RPC call.
  if (!useAnvil) {
    await rpc(url, "evm_setAutomine", [false]);
  }

  const chainIdHex = await rpc<string>(url, "eth_chainId");
  return { kind, url, chainId: Number.parseInt(chainIdHex, 16), stop };
};

/** Mines exactly one block. */
export const mineBlock = async (url: string): Promise<void> => {
  await rpc(url, "evm_mine");
};
