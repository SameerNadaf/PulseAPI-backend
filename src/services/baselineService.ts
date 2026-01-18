/**
 * Baseline Calculation Service
 *
 * Calculates and updates latency baselines for endpoints
 */

import type { Env } from "../index";
import type { Baseline } from "../models/types";

// Calculate percentile value from sorted array
function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

// Calculate standard deviation
function standardDeviation(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const avgSquaredDiff =
    squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

// Calculate baseline for a single endpoint
export async function calculateBaseline(
  db: D1Database,
  endpointId: string,
  hoursBack: number = 168, // 7 days
): Promise<Baseline | null> {
  // Get successful probe latencies from the past week
  const { results } = await db
    .prepare(
      `
    SELECT latency_ms FROM probe_results
    WHERE endpoint_id = ?
      AND status = 'success'
      AND latency_ms IS NOT NULL
      AND timestamp >= datetime('now', '-${hoursBack} hours')
    ORDER BY latency_ms ASC
  `,
    )
    .bind(endpointId)
    .all<{ latency_ms: number }>();

  if (results.length < 10) {
    console.log(`Not enough data for baseline: ${results.length} samples`);
    return null; // Need at least 10 samples
  }

  const latencies = results.map((r) => r.latency_ms);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avgLatency = sum / latencies.length;

  const baseline: Baseline = {
    id: crypto.randomUUID(),
    endpoint_id: endpointId,
    avg_latency_ms: avgLatency,
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    p99_latency_ms: percentile(latencies, 99),
    std_deviation: standardDeviation(latencies, avgLatency),
    sample_count: latencies.length,
    calculated_at: new Date().toISOString(),
  };

  return baseline;
}

// Store or update baseline in database
export async function upsertBaseline(
  db: D1Database,
  baseline: Baseline,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO baselines (id, endpoint_id, avg_latency_ms, p50_latency_ms, p95_latency_ms, p99_latency_ms, std_deviation, sample_count, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint_id) DO UPDATE SET
      avg_latency_ms = excluded.avg_latency_ms,
      p50_latency_ms = excluded.p50_latency_ms,
      p95_latency_ms = excluded.p95_latency_ms,
      p99_latency_ms = excluded.p99_latency_ms,
      std_deviation = excluded.std_deviation,
      sample_count = excluded.sample_count,
      calculated_at = excluded.calculated_at
  `,
    )
    .bind(
      baseline.id,
      baseline.endpoint_id,
      baseline.avg_latency_ms,
      baseline.p50_latency_ms ?? null,
      baseline.p95_latency_ms ?? null,
      baseline.p99_latency_ms ?? null,
      baseline.std_deviation ?? null,
      baseline.sample_count,
      baseline.calculated_at,
    )
    .run();
}

// Recalculate baselines for all active endpoints
export async function recalculateAllBaselines(
  env: Env,
): Promise<{ updated: number; skipped: number }> {
  console.log("Recalculating baselines for all endpoints...");

  const { results: endpoints } = await env.DB.prepare(
    "SELECT id, name FROM endpoints WHERE is_active = 1",
  ).all<{ id: string; name: string }>();

  let updated = 0;
  let skipped = 0;

  for (const endpoint of endpoints) {
    const baseline = await calculateBaseline(env.DB, endpoint.id);

    if (baseline) {
      await upsertBaseline(env.DB, baseline);
      console.log(
        `Updated baseline for ${endpoint.name}: avg=${baseline.avg_latency_ms.toFixed(0)}ms, p95=${baseline.p95_latency_ms?.toFixed(0)}ms`,
      );
      updated++;
    } else {
      console.log(`Skipped baseline for ${endpoint.name}: not enough data`);
      skipped++;
    }
  }

  console.log(
    `Baseline recalculation complete. Updated: ${updated}, Skipped: ${skipped}`,
  );
  return { updated, skipped };
}
