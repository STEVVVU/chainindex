/**
 * Runs a Vitest tier and asserts it actually executed at least `--min` tests.
 *
 * Why this exists
 * ---------------
 * The Hardhat contract tier is guarded by Mocha's `failZero` (see hardhat.config.ts).
 * Vitest needs a different guard, because the two tools fail differently.
 *
 * Vitest 4 already exits 1 on every *total* collection failure -- a filter matching
 * no files, a glob matching no files, a file with no suite, and a suite with no test
 * cases all exit non-zero (verified against vitest 4.1.10). So a `failZero` equivalent
 * would be redundant here; that is not the hole.
 *
 * The hole is *partial* collection loss. Renaming or dropping one file out of a tier
 * leaves the run green: `tests/indexer` reports "2 passed (2) / 8 passed (8)" and exits
 * 0 after `api.test.ts` is renamed away. Nothing in the tool notices that a third of
 * the tier stopped existing, because from Vitest's point of view every test it found
 * passed. A count floor is the only thing that catches that, and it also subsumes the
 * zero-test case for free.
 *
 * The floor is a ratchet, not an exact count: adding tests never breaks it, removing
 * them does. When a tier legitimately shrinks, lower the floor in the same commit that
 * removes the tests -- that keeps the deletion visible in review instead of silent.
 *
 * The floor is asserted against *passed* tests rather than collected tests on purpose.
 * Vitest already fails the run on a failing test, so past that point passed == executed,
 * and using it means the guard also trips if tests are mass-`.skip`ped rather than
 * deleted -- a skipped test still counts toward `numTotalTests`.
 *
 * Usage:
 *   tsx scripts/assert-test-floor.ts --min 9 -- tests/indexer
 *   tsx scripts/assert-test-floor.ts --min 3 -- --config vitest.e2e.config.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The subset of Vitest's JSON reporter output this script relies on. */
interface TestCounts {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
}

function isTestCounts(value: unknown): value is TestCounts {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.numTotalTests === "number" &&
    typeof record.numPassedTests === "number" &&
    typeof record.numFailedTests === "number"
  );
}

/** Narrows Vitest's package.json to the one field this script reads from it. */
function hasVitestBin(value: unknown): value is { bin: { vitest: string } } {
  if (typeof value !== "object" || value === null || !("bin" in value)) {
    return false;
  }
  const { bin } = value;
  return (
    typeof bin === "object" && bin !== null && "vitest" in bin && typeof bin.vitest === "string"
  );
}

function fail(message: string): never {
  console.error(`assert-test-floor: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { min: number; vitestArgs: string[] } {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    fail("expected `--min <n> -- <vitest args...>`; the `--` separator is missing");
  }

  const own = argv.slice(0, separator);
  const vitestArgs = argv.slice(separator + 1);

  if (own[0] !== "--min" || own.length !== 2) {
    fail("expected exactly `--min <n>` before the `--` separator");
  }

  const min = Number(own[1]);
  if (!Number.isInteger(min) || min < 1) {
    fail(`--min must be a positive integer, got "${own[1]}"`);
  }
  if (vitestArgs.length === 0) {
    fail("no arguments were passed through to vitest");
  }

  return { min, vitestArgs };
}

const { min, vitestArgs } = parseArgs(process.argv.slice(2));

// Run Vitest's CLI entry under this Node binary rather than shelling out to the
// `vitest` bin shim: the shim is a .cmd file on Windows, which spawnSync cannot execute
// without a shell. The entry is read out of Vitest's own `bin` field (its package.json
// is an exported subpath, whereas the .mjs entry itself is not), so this keeps working
// if the file is ever renamed.
const vitestPkgPath = require.resolve("vitest/package.json");
const vitestPkg: unknown = JSON.parse(readFileSync(vitestPkgPath, "utf8"));
if (!hasVitestBin(vitestPkg)) {
  fail("could not read the vitest CLI entry point from vitest's package.json");
}
const vitestCli = join(dirname(vitestPkgPath), vitestPkg.bin.vitest);

// The JSON report is an implementation detail of this check, so it goes to a private
// temp dir -- not into the repo, where it would need a .gitignore entry and could be
// committed by accident.
const reportDir = mkdtempSync(join(tmpdir(), "chainindex-test-floor-"));
const reportPath = join(reportDir, "report.json");

// Cleanup is registered on `exit` rather than wrapped in try/finally because `fail()`
// calls process.exit(), which does not unwind a finally block -- so a finally here
// would leak a temp dir on exactly the failure paths this script exists to take.
process.on("exit", () => {
  rmSync(reportDir, { recursive: true, force: true });
});

// `--reporter=default` is kept alongside the JSON reporter so the human-readable
// progress output still streams to the terminal and to CI logs.
const run = spawnSync(
  process.execPath,
  [
    vitestCli,
    "run",
    ...vitestArgs,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportPath}`
  ],
  { stdio: "inherit" }
);

if (run.error) {
  fail(`could not start vitest: ${run.error.message}`);
}
// A real test failure outranks the floor check: report Vitest's own verdict and stop.
if (run.status !== 0) {
  if (run.signal !== null) {
    fail(`vitest was killed by signal ${run.signal}`);
  }
  process.exit(run.status ?? 1);
}

if (!existsSync(reportPath)) {
  fail(
    "vitest exited 0 but wrote no JSON report, so the test count could not be " +
      "verified; treating that as a failure rather than trusting the exit code"
  );
}

const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
if (!isTestCounts(parsed)) {
  fail("vitest's JSON report did not contain the expected test-count fields");
}

if (parsed.numPassedTests < min) {
  fail(
    `expected at least ${min} passing tests but only ${parsed.numPassedTests} ran ` +
      `(${parsed.numTotalTests} collected). Tests were removed, renamed out of the ` +
      `include glob, or skipped. If the shrink is intentional, lower --min for this ` +
      `tier in package.json.`
  );
}

console.log(`assert-test-floor: ok -- ${parsed.numPassedTests} passing tests (floor ${min}).`);
