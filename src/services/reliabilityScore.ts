// Reliability Score Service
// Calculates a 0-100 reliability score for each endpoint

import { D1Database } from "@cloudflare/workers-types";

interface ReliabilityScoreResult {
  endpointId: string;
  score: number;
  components: {
    uptime: number; // 40% weight
    latency: number; // 30% weight
    errorRate: number; // 20% weight
    incidentHistory: number; // 10% weight
  };
  trend: "improving" | "stable" | "declining";
  calculatedAt: string;
}

interface ProbeStats {
  totalProbes: number;
  successCount: number;
  avgLatency: number;
  baselineLatency: number;
  errorCount: number;
}

interface IncidentStats {
  last7Days: number;
  last30Days: number;
}

export async function calculateReliabilityScore(
  db: D1Database,
  endpointId: string,
): Promise<ReliabilityScoreResult> {
  // Get probe stats for last 24 hours
  const probeStats = await getProbeStats(db, endpointId, 24);

  // Get incident stats
  const incidentStats = await getIncidentStats(db, endpointId);

  // Calculate individual components
  const uptimeScore = calculateUptimeScore(probeStats);
  const latencyScore = calculateLatencyScore(probeStats);
  const errorRateScore = calculateErrorRateScore(probeStats);
  const incidentScore = calculateIncidentScore(incidentStats);

  // Weighted average
  const overallScore = Math.round(
    uptimeScore * 0.4 +
      latencyScore * 0.3 +
      errorRateScore * 0.2 +
      incidentScore * 0.1,
  );

  // Calculate trend (compare to 24h ago)
  const previousScore = await getPreviousScore(db, endpointId);
  const trend = determineTrend(overallScore, previousScore);

  // Store the score
  await storeScore(db, endpointId, overallScore, {
    uptime: uptimeScore,
    latency: latencyScore,
    errorRate: errorRateScore,
    incidentHistory: incidentScore,
  });

  return {
    endpointId,
    score: overallScore,
    components: {
      uptime: uptimeScore,
      latency: latencyScore,
      errorRate: errorRateScore,
      incidentHistory: incidentScore,
    },
    trend,
    calculatedAt: new Date().toISOString(),
  };
}

async function getProbeStats(
  db: D1Database,
  endpointId: string,
  hours: number,
): Promise<ProbeStats> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `
    SELECT 
      COUNT(*) as total_probes,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) as avg_latency,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
    FROM probe_results
    WHERE endpoint_id = ? AND timestamp >= ?
  `,
    )
    .bind(endpointId, since)
    .first<{
      total_probes: number;
      success_count: number;
      avg_latency: number | null;
      error_count: number;
    }>();

  // Get baseline latency
  const baseline = await db
    .prepare(
      `
    SELECT baseline_latency_ms FROM endpoint_baselines
    WHERE endpoint_id = ?
  `,
    )
    .bind(endpointId)
    .first<{ baseline_latency_ms: number }>();

  return {
    totalProbes: result?.total_probes || 0,
    successCount: result?.success_count || 0,
    avgLatency: result?.avg_latency || 0,
    baselineLatency: baseline?.baseline_latency_ms || 500,
    errorCount: result?.error_count || 0,
  };
}

async function getIncidentStats(
  db: D1Database,
  endpointId: string,
): Promise<IncidentStats> {
  const now = new Date();
  const days7Ago = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const days30Ago = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const last7 = await db
    .prepare(
      `
    SELECT COUNT(*) as count FROM incidents
    WHERE endpoint_id = ? AND started_at >= ?
  `,
    )
    .bind(endpointId, days7Ago)
    .first<{ count: number }>();

  const last30 = await db
    .prepare(
      `
    SELECT COUNT(*) as count FROM incidents
    WHERE endpoint_id = ? AND started_at >= ?
  `,
    )
    .bind(endpointId, days30Ago)
    .first<{ count: number }>();

  return {
    last7Days: last7?.count || 0,
    last30Days: last30?.count || 0,
  };
}

function calculateUptimeScore(stats: ProbeStats): number {
  if (stats.totalProbes === 0) return 100;
  const uptimePercentage = (stats.successCount / stats.totalProbes) * 100;
  return Math.min(100, Math.max(0, uptimePercentage));
}

function calculateLatencyScore(stats: ProbeStats): number {
  if (stats.avgLatency === 0 || stats.baselineLatency === 0) return 100;

  // Score based on how close to baseline
  const ratio = stats.avgLatency / stats.baselineLatency;

  if (ratio <= 1.0) return 100;
  if (ratio <= 1.2) return 90;
  if (ratio <= 1.5) return 75;
  if (ratio <= 2.0) return 50;
  if (ratio <= 3.0) return 25;
  return 0;
}

function calculateErrorRateScore(stats: ProbeStats): number {
  if (stats.totalProbes === 0) return 100;
  const errorRate = stats.errorCount / stats.totalProbes;

  if (errorRate === 0) return 100;
  if (errorRate <= 0.01) return 90;
  if (errorRate <= 0.05) return 75;
  if (errorRate <= 0.1) return 50;
  if (errorRate <= 0.25) return 25;
  return 0;
}

function calculateIncidentScore(stats: IncidentStats): number {
  // Score based on incident frequency
  const recentWeight = stats.last7Days * 2;
  const olderWeight = (stats.last30Days - stats.last7Days) * 0.5;
  const totalWeight = recentWeight + olderWeight;

  if (totalWeight === 0) return 100;
  if (totalWeight <= 1) return 80;
  if (totalWeight <= 3) return 60;
  if (totalWeight <= 5) return 40;
  return 20;
}

async function getPreviousScore(
  db: D1Database,
  endpointId: string,
): Promise<number | null> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `
    SELECT score FROM reliability_scores
    WHERE endpoint_id = ? AND calculated_at <= ?
    ORDER BY calculated_at DESC
    LIMIT 1
  `,
    )
    .bind(endpointId, yesterday)
    .first<{ score: number }>();

  return result?.score || null;
}

function determineTrend(
  current: number,
  previous: number | null,
): "improving" | "stable" | "declining" {
  if (previous === null) return "stable";

  const diff = current - previous;
  if (diff >= 5) return "improving";
  if (diff <= -5) return "declining";
  return "stable";
}

async function storeScore(
  db: D1Database,
  endpointId: string,
  score: number,
  components: ReliabilityScoreResult["components"],
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO reliability_scores (id, endpoint_id, score, uptime_score, latency_score, error_rate_score, incident_score, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(
      crypto.randomUUID(),
      endpointId,
      score,
      components.uptime,
      components.latency,
      components.errorRate,
      components.incidentHistory,
      new Date().toISOString(),
    )
    .run();
}

// Batch calculate for all endpoints
export async function calculateAllReliabilityScores(
  db: D1Database,
  userId: string,
): Promise<ReliabilityScoreResult[]> {
  const endpoints = await db
    .prepare(
      `
    SELECT id FROM endpoints WHERE user_id = ? AND is_active = 1
  `,
    )
    .bind(userId)
    .all<{ id: string }>();

  const results: ReliabilityScoreResult[] = [];

  for (const endpoint of endpoints.results || []) {
    const score = await calculateReliabilityScore(db, endpoint.id);
    results.push(score);
  }

  return results;
}
