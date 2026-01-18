// Trend Analysis Service
// Aggregates metrics for trend visualization

import { D1Database } from "@cloudflare/workers-types";

interface HourlyMetric {
  hour: string;
  avgLatency: number;
  successRate: number;
  probeCount: number;
}

interface DailyMetric {
  date: string;
  uptimePercentage: number;
  avgLatency: number;
  incidentCount: number;
  probeCount: number;
}

interface TrendData {
  endpointId: string;
  hourly: HourlyMetric[];
  daily: DailyMetric[];
  summary: {
    avgLatency24h: number;
    avgLatency7d: number;
    uptimePercentage24h: number;
    uptimePercentage7d: number;
    latencyTrend: "improving" | "stable" | "declining";
    uptimeTrend: "improving" | "stable" | "declining";
  };
}

export async function getEndpointTrends(
  db: D1Database,
  endpointId: string,
): Promise<TrendData> {
  const hourlyMetrics = await getHourlyMetrics(db, endpointId, 24);
  const dailyMetrics = await getDailyMetrics(db, endpointId, 7);
  const summary = calculateSummary(hourlyMetrics, dailyMetrics);

  return {
    endpointId,
    hourly: hourlyMetrics,
    daily: dailyMetrics,
    summary,
  };
}

async function getHourlyMetrics(
  db: D1Database,
  endpointId: string,
  hours: number,
): Promise<HourlyMetric[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `
    SELECT 
      strftime('%Y-%m-%d %H:00', timestamp) as hour,
      AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) as avg_latency,
      CAST(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100 as success_rate,
      COUNT(*) as probe_count
    FROM probe_results
    WHERE endpoint_id = ? AND timestamp >= ?
    GROUP BY strftime('%Y-%m-%d %H:00', timestamp)
    ORDER BY hour ASC
  `,
    )
    .bind(endpointId, since)
    .all<{
      hour: string;
      avg_latency: number | null;
      success_rate: number;
      probe_count: number;
    }>();

  return (result.results || []).map((row) => ({
    hour: row.hour,
    avgLatency: row.avg_latency || 0,
    successRate: row.success_rate,
    probeCount: row.probe_count,
  }));
}

async function getDailyMetrics(
  db: D1Database,
  endpointId: string,
  days: number,
): Promise<DailyMetric[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const probeMetrics = await db
    .prepare(
      `
    SELECT 
      date(timestamp) as date,
      AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) as avg_latency,
      CAST(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100 as uptime,
      COUNT(*) as probe_count
    FROM probe_results
    WHERE endpoint_id = ? AND timestamp >= ?
    GROUP BY date(timestamp)
    ORDER BY date ASC
  `,
    )
    .bind(endpointId, since)
    .all<{
      date: string;
      avg_latency: number | null;
      uptime: number;
      probe_count: number;
    }>();

  const incidentCounts = await db
    .prepare(
      `
    SELECT 
      date(started_at) as date,
      COUNT(*) as incident_count
    FROM incidents
    WHERE endpoint_id = ? AND started_at >= ?
    GROUP BY date(started_at)
  `,
    )
    .bind(endpointId, since)
    .all<{
      date: string;
      incident_count: number;
    }>();

  const incidentMap = new Map(
    (incidentCounts.results || []).map((r) => [r.date, r.incident_count]),
  );

  return (probeMetrics.results || []).map((row) => ({
    date: row.date,
    uptimePercentage: row.uptime,
    avgLatency: row.avg_latency || 0,
    incidentCount: incidentMap.get(row.date) || 0,
    probeCount: row.probe_count,
  }));
}

function calculateSummary(
  hourly: HourlyMetric[],
  daily: DailyMetric[],
): TrendData["summary"] {
  // 24h averages
  const avgLatency24h =
    hourly.length > 0
      ? hourly.reduce((sum, h) => sum + h.avgLatency, 0) / hourly.length
      : 0;

  const uptimePercentage24h =
    hourly.length > 0
      ? hourly.reduce((sum, h) => sum + h.successRate, 0) / hourly.length
      : 100;

  // 7d averages
  const avgLatency7d =
    daily.length > 0
      ? daily.reduce((sum, d) => sum + d.avgLatency, 0) / daily.length
      : 0;

  const uptimePercentage7d =
    daily.length > 0
      ? daily.reduce((sum, d) => sum + d.uptimePercentage, 0) / daily.length
      : 100;

  // Calculate trends (compare first half to second half)
  const latencyTrend = calculateTrend(
    hourly.slice(0, Math.floor(hourly.length / 2)).map((h) => h.avgLatency),
    hourly.slice(Math.floor(hourly.length / 2)).map((h) => h.avgLatency),
    true, // Lower is better for latency
  );

  const uptimeTrend = calculateTrend(
    hourly.slice(0, Math.floor(hourly.length / 2)).map((h) => h.successRate),
    hourly.slice(Math.floor(hourly.length / 2)).map((h) => h.successRate),
    false, // Higher is better for uptime
  );

  return {
    avgLatency24h,
    avgLatency7d,
    uptimePercentage24h,
    uptimePercentage7d,
    latencyTrend,
    uptimeTrend,
  };
}

function calculateTrend(
  firstHalf: number[],
  secondHalf: number[],
  lowerIsBetter: boolean,
): "improving" | "stable" | "declining" {
  if (firstHalf.length === 0 || secondHalf.length === 0) return "stable";

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const percentChange = ((avgSecond - avgFirst) / avgFirst) * 100;

  if (Math.abs(percentChange) < 5) return "stable";

  if (lowerIsBetter) {
    return percentChange < 0 ? "improving" : "declining";
  } else {
    return percentChange > 0 ? "improving" : "declining";
  }
}

// Get aggregated trends for dashboard
export async function getDashboardTrends(
  db: D1Database,
  userId: string,
): Promise<{
  overallUptime24h: number;
  overallUptime7d: number;
  avgLatency24h: number;
  totalIncidents7d: number;
}> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get all endpoint IDs for user
  const endpoints = await db
    .prepare(
      `
    SELECT id FROM endpoints WHERE user_id = ? AND is_active = 1
  `,
    )
    .bind(userId)
    .all<{ id: string }>();

  if (!endpoints.results || endpoints.results.length === 0) {
    return {
      overallUptime24h: 100,
      overallUptime7d: 100,
      avgLatency24h: 0,
      totalIncidents7d: 0,
    };
  }

  const endpointIds = endpoints.results.map((e) => e.id);
  const placeholders = endpointIds.map(() => "?").join(",");

  const stats24h = await db
    .prepare(
      `
    SELECT 
      CAST(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100 as uptime,
      AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) as avg_latency
    FROM probe_results
    WHERE endpoint_id IN (${placeholders}) AND timestamp >= ?
  `,
    )
    .bind(...endpointIds, since24h)
    .first<{
      uptime: number;
      avg_latency: number | null;
    }>();

  const stats7d = await db
    .prepare(
      `
    SELECT 
      CAST(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100 as uptime
    FROM probe_results
    WHERE endpoint_id IN (${placeholders}) AND timestamp >= ?
  `,
    )
    .bind(...endpointIds, since7d)
    .first<{ uptime: number }>();

  const incidents = await db
    .prepare(
      `
    SELECT COUNT(*) as count FROM incidents
    WHERE endpoint_id IN (${placeholders}) AND started_at >= ?
  `,
    )
    .bind(...endpointIds, since7d)
    .first<{ count: number }>();

  return {
    overallUptime24h: stats24h?.uptime || 100,
    overallUptime7d: stats7d?.uptime || 100,
    avgLatency24h: stats24h?.avg_latency || 0,
    totalIncidents7d: incidents?.count || 0,
  };
}
