/**
 * Probe Engine Service
 *
 * Handles scheduled API probing and health checks
 */

import type { Env } from "../index";
import type {
  Endpoint,
  ProbeResult,
  EndpointHealthSummary,
} from "../models/types";

interface ProbeConfig {
  timeout: number;
  region: string;
}

// Perform a single probe on an endpoint
async function probeEndpoint(
  endpoint: Endpoint,
  config: ProbeConfig,
): Promise<ProbeResult> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout * 1000);

  try {
    const startTime = performance.now();

    const headers: HeadersInit = {
      "User-Agent": "PulseAPI-Probe/1.0",
    };

    // Add custom headers if defined
    if (endpoint.headers) {
      const customHeaders =
        typeof endpoint.headers === "string"
          ? JSON.parse(endpoint.headers)
          : endpoint.headers;
      Object.assign(headers, customHeaders);
    }

    const response = await fetch(endpoint.url, {
      method: endpoint.method,
      headers,
      body:
        endpoint.method !== "GET" && endpoint.method !== "HEAD"
          ? endpoint.body
          : undefined,
      signal: controller.signal,
    });

    const endTime = performance.now();
    const latencyMs = endTime - startTime;

    clearTimeout(timeoutId);

    // Parse expected status codes
    const expectedCodes =
      typeof endpoint.expected_status_codes === "string"
        ? JSON.parse(endpoint.expected_status_codes)
        : endpoint.expected_status_codes || [200, 201, 204];

    const isSuccess = expectedCodes.includes(response.status);

    return {
      id,
      endpoint_id: endpoint.id,
      timestamp,
      status: isSuccess ? "success" : "error",
      latency_ms: latencyMs,
      status_code: response.status,
      error_message: isSuccess
        ? undefined
        : `Unexpected status: ${response.status}`,
      region: config.region,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);

    const isTimeout = error.name === "AbortError";

    return {
      id,
      endpoint_id: endpoint.id,
      timestamp,
      status: isTimeout ? "timeout" : "error",
      latency_ms: undefined,
      status_code: undefined,
      error_message: isTimeout ? "Request timed out" : error.message,
      region: config.region,
    };
  }
}

// Store probe result in D1
async function storeProbeResult(
  db: D1Database,
  result: ProbeResult,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO probe_results (id, endpoint_id, timestamp, status, latency_ms, status_code, error_message, region)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(
      result.id,
      result.endpoint_id,
      result.timestamp,
      result.status,
      result.latency_ms ?? null,
      result.status_code ?? null,
      result.error_message ?? null,
      result.region,
    )
    .run();
}

// Calculate and update health summary in KV
async function updateHealthSummary(
  db: D1Database,
  kv: KVNamespace,
  endpointId: string,
  latestResult: ProbeResult,
): Promise<void> {
  // Get recent probe stats (last 24 hours)
  const stats = await db
    .prepare(
      `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
      AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) as avg_latency
    FROM probe_results
    WHERE endpoint_id = ?
      AND timestamp >= datetime('now', '-24 hours')
  `,
    )
    .bind(endpointId)
    .first<{ total: number; success: number; avg_latency: number | null }>();

  // Get baseline
  const baseline = await db
    .prepare(
      "SELECT avg_latency_ms, p95_latency_ms FROM baselines WHERE endpoint_id = ?",
    )
    .bind(endpointId)
    .first<{ avg_latency_ms: number; p95_latency_ms: number }>();

  // Calculate status
  let status: "healthy" | "degraded" | "down" | "unknown" = "unknown";

  if (stats && stats.total > 0) {
    const successRate = stats.success / stats.total;

    if (successRate < 0.5) {
      status = "down";
    } else if (successRate < 0.95) {
      status = "degraded";
    } else if (
      baseline &&
      stats.avg_latency &&
      stats.avg_latency > baseline.p95_latency_ms
    ) {
      status = "degraded";
    } else {
      status = "healthy";
    }
  }

  // Calculate reliability score (0-100)
  const successRate =
    stats && stats.total > 0 ? stats.success / stats.total : 0;
  const reliabilityScore = Math.round(successRate * 100);

  const healthSummary: EndpointHealthSummary = {
    endpoint_id: endpointId,
    status,
    reliability_score: reliabilityScore,
    current_latency_ms: latestResult.latency_ms,
    baseline_latency_ms: baseline?.avg_latency_ms,
    error_rate: stats ? 1 - stats.success / stats.total : 0,
    last_probe_at: latestResult.timestamp,
    last_incident_at: undefined, // TODO: Query incidents
    uptime_percentage: reliabilityScore,
  };

  // Store in KV with 5 minute TTL
  await kv.put(`health:${endpointId}`, JSON.stringify(healthSummary), {
    expirationTtl: 300,
  });
}

// Main probe engine - called by cron trigger
export async function runProbeEngine(
  env: Env,
): Promise<{ probed: number; errors: number }> {
  console.log("Probe engine starting...");

  let probed = 0;
  let errors = 0;

  try {
    // Get all active endpoints
    const { results: endpoints } = await env.DB.prepare(
      "SELECT * FROM endpoints WHERE is_active = 1",
    ).all<Endpoint>();

    console.log(`Found ${endpoints.length} active endpoints`);

    // Get Cloudflare region (colo)
    const region = "global"; // In production, use cf.colo from request

    // Probe each endpoint
    for (const endpoint of endpoints) {
      try {
        const result = await probeEndpoint(endpoint, {
          timeout: endpoint.timeout_seconds || 10,
          region,
        });

        await storeProbeResult(env.DB, result);
        await updateHealthSummary(env.DB, env.STATUS_KV, endpoint.id, result);

        probed++;
        console.log(
          `Probed ${endpoint.name}: ${result.status} (${result.latency_ms?.toFixed(0)}ms)`,
        );
      } catch (error) {
        errors++;
        console.error(`Error probing ${endpoint.name}:`, error);
      }
    }

    console.log(`Probe engine complete. Probed: ${probed}, Errors: ${errors}`);
  } catch (error) {
    console.error("Probe engine failed:", error);
  }

  return { probed, errors };
}

// Clean up old probe data (retention policy)
export async function cleanupOldProbes(
  env: Env,
  retentionDays: number = 30,
): Promise<number> {
  const result = await env.DB.prepare(
    `
    DELETE FROM probe_results 
    WHERE timestamp < datetime('now', '-${retentionDays} days')
  `,
  ).run();

  console.log(`Cleaned up ${result.meta.changes} old probe records`);
  return result.meta.changes;
}
