# Scaling Reference

## Worker Scaling Guidelines

| Agents  | Recommended T3 Workers | T2 Managers | T1 Executives |
|---------|------------------------|-------------|---------------|
| 5–10    | 4–8                    | 1–2         | 1             |
| 10–50   | 8–16                   | 2–4         | 1–2           |
| 50–100  | 16–32                  | 4–8         | 2             |
| 100+    | 32–64                  | 8–16        | 2–4           |

## Backpressure Defaults

Default concurrent limits per tier: T1=2, T2=4, T3=8.
Adjust via environment variables:

```
SIDJUA_BACKPRESSURE_T1_MAX=2
SIDJUA_BACKPRESSURE_T2_MAX=4
SIDJUA_BACKPRESSURE_T3_MAX=8
SIDJUA_BACKPRESSURE_QUEUE_MAX=100
SIDJUA_BACKPRESSURE_QUEUE_TIMEOUT_MS=120000
```

## Dead Worker Recovery Defaults

Tasks stuck in RUNNING beyond 5 minutes are failed automatically.
Adjust via environment variables:

```
SIDJUA_DEAD_WORKER_TIMEOUT=300000
SIDJUA_DEAD_WORKER_CHECK_INTERVAL=60000
```

## Benchmark Baseline

Run the quick benchmark after each deployment to establish a performance baseline.
Compare subsequent runs to detect regressions.

```bash
npm run benchmark:quick
```

Compare results stored in `benchmarks/*.json` across releases.

## Benchmark Scenarios

| Scenario           | Duration | Rate          | Purpose                                  |
|--------------------|----------|---------------|------------------------------------------|
| short-burst        | 10s      | 5 tasks/sec   | CI smoke test, quick sanity check        |
| sustained-load     | 60s      | 10 tasks/sec  | Backpressure activation, queue behavior  |
| spike-load         | 30s      | 0→20 tasks/sec | Queue overflow, 503 responses, recovery  |
| delegation-chain   | 30s      | 3 tasks/sec   | Delegation latency, budget tracking      |
| freeze-during-load | 30s      | 5 tasks/sec   | Graceful freeze/resume under active load |

## Interpreting Results

**Throughput (tasks/sec):** Completed tasks only. Rejected and failed tasks are excluded.
Use this metric for capacity planning.

**p99 latency:** The 99th percentile end-to-end task duration. Includes time spent queued
in the backpressure queue. Spikes in p99 indicate queue saturation.

**Backpressure activations:** Number of times the queue went from empty to non-empty.
Sustained high activations indicate the concurrency limit is too low for the workload.

**Dead worker recoveries:** Tasks that were stuck in RUNNING and automatically failed.
Non-zero in normal operation indicates transient worker issues.

## Capacity Planning Formula

Sustained throughput ceiling = concurrent slots × (1000 / avg_latency_ms)

Example: T3 with 8 slots and 100ms avg latency → 80 tasks/sec maximum.

Set `SIDJUA_BACKPRESSURE_T3_MAX` so the ceiling exceeds your peak load by at least 20%.
