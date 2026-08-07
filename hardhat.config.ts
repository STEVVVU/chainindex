import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import { subtask, type HardhatUserConfig } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(
  ({ solcVersion }: { solcVersion: string }) => {
    if (solcVersion !== "0.8.28") {
      throw new Error(`Unsupported Solidity compiler ${solcVersion}`);
    }
    return Promise.resolve({
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: "0.8.28",
      longVersion: "0.8.28+commit.7893614a"
    });
  }
);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./tests/contract"
  },
  mocha: {
    timeout: 20_000
  }
};

export default config;
