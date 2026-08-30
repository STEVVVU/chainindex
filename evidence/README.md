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

The harness times repeated runs (`BENCHMARK_REPEATS`, default 5) and reports the min,
median, and max rather than a single number. The recorded artifact used 25.

This is deliberate. Wall-clock throughput on a developer machine is dominated by host
CPU availability, not by the code under test. Measured on this host, the
*byte-identical* pipeline spanned **1.855s to 66.2s** for the same 10,000-block
workload; across four independent 25-repetition batches the median alone ranged
4.4–6.6s. Publishing whichever single value happened to be sampled would overstate the
precision of the measurement, so the artifact records the spread and the environment
that produced it.

The spread is host noise, not harness decay. A 20-repetition probe logging per-iteration
time and `heapUsed` showed no monotonic slowdown and an ordinary GC sawtooth, so the
tail is external stalls rather than accumulated state. One 66s outlier is retained in
the reported range for that reason: discarding it would flatter the measurement.

Treat the median as indicative of local pipeline overhead on a comparable host, and the
range as the honest uncertainty. This measures in-process indexing, decoding, and SQLite
commit cost only — never JSON-RPC latency or mainnet throughput.

## Comparing against an older artifact

The previous artifact recorded 7.393 / 8.304 / 10.692s (935 / 1,204 / 1,353 blocks/s)
over 5 repetitions. The current one is faster at the median, but **no code explains it**:
`git diff <old> HEAD -- src/ benchmarks/` is empty across those revisions. Do not read a
median shift on this host as a performance result unless a diff backs it.

## Prior schema

`schemaVersion: 1` recorded a single run (`elapsedSeconds` and `blocksPerSecond` as
scalars). `schemaVersion: 2` replaces both with `{ min, median, max }` objects and adds
`workload.repeats`.

## CI

CI executes the same harness with `BENCHMARK_BLOCKS=2000` as a smoke benchmark. Shared
CI runners are noisier than a local host, so CI asserts the harness runs and stays
correct rather than gating on a throughput threshold.
