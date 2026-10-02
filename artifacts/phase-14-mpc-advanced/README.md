# Phase 14 MPC advanced artifacts

These fixtures are deterministic, synthetic, and sanitized. They contain no
card images, live card asset IDs, private URLs, filesystem paths, response
bodies, or credentials. The protocol file records route behavior already
documented in ADR 0006 and labels it as historical evidence.

`batch-benchmark.json` records request counts derived from the same 20-ID
hydration planner and limits used by the provider. It is a reproducible request
count benchmark, not a throughput or latency claim. Network access is not used
by the benchmark test.

Validate the benchmark with:

```sh
npx vitest run tests/artwork/mpc-batch-benchmark.test.ts --maxWorkers=1
```

Validate the diagnostic example against its contract with:

```sh
npx vitest run tests/artwork/mpc-diagnostic-report.test.ts --maxWorkers=1
```
