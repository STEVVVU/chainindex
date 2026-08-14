# Reproducible Evidence

`benchmark.json` records one local run of:

```bash
npm run benchmark
```

The workload is deterministic: 10,000 blocks, one ABI-encoded `Deposited` log per
block, 500-block batches, an in-process fake provider, and in-memory SQLite.
Wall-clock throughput varies by host, so the artifact records Node, OS, and
architecture. Correctness is checked by matching stored block and event counts.

CI executes the same harness with `BENCHMARK_BLOCKS=2000` as a smoke benchmark.
