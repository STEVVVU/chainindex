# Reproducible Evidence

`benchmark.json` records one local run of:

```bash
npm run benchmark
```

The workload is deterministic: 10,000 blocks, one ABI-encoded `Deposited` log per
block, 500-block batches, an in-process fake provider, and in-memory SQLite.
Correctness is checked by matching stored block and event counts, and the harness
throws if any repetition indexes the wrong number of blocks or events.

## Why the throughput figure is a range

The harness times five repetitions (`BENCHMARK_REPEATS`, default 5) and reports the
min, median, and max rather than a single number.

This is deliberate. Wall-clock throughput on a developer machine is dominated by host
CPU availability, not by the code under test. While re-measuring for the
`feat/modernize-stack` changes, the *byte-identical* pipeline was observed anywhere
between 550 and 1,960 blocks/s across consecutive runs on a contended host — a 3.5x
spread. Publishing whichever single value happened to be sampled would overstate the
precision of the measurement, so the artifact records the spread and the environment
that produced it.

Treat the median as indicative of local pipeline overhead on a comparable host, and the
range as the honest uncertainty. This measures in-process indexing, decoding, and SQLite
commit cost only — never JSON-RPC latency or mainnet throughput.

## Prior schema

`schemaVersion: 1` recorded a single run (`elapsedSeconds` and `blocksPerSecond` as
scalars). `schemaVersion: 2` replaces both with `{ min, median, max }` objects and adds
`workload.repeats`.

## CI

CI executes the same harness with `BENCHMARK_BLOCKS=2000` as a smoke benchmark. Shared
CI runners are noisier than a local host, so CI asserts the harness runs and stays
correct rather than gating on a throughput threshold.
