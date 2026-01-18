/**
 * Degradation Detection Service
 *
 * Detects API degradation and creates incidents
 */

import type { Env } from "../index";
import type {
  Incident,
  IncidentType,
  IncidentSeverity,
  EndpointHealthSummary,
} from "../models/types";

interface DegradationThresholds {
  latencyMultiplier: number; // Alert if latency > baseline * multiplier
  errorRateThreshold: number; // Alert if error rate > threshold (0-1)
  consecutiveFailures: number; // Alert after N consecutive failures
}

const DEFAULT_THRESHOLDS: DegradationThresholds = {
  latencyMultiplier: 2.0, // 2x baseline latency
  errorRateThreshold: 0.1, // 10% error rate
  consecutiveFailures: 3, // 3 consecutive failures
};

// Determine incident severity based on metrics
function determineSeverity(
  errorRate: number,
  latencyRatio: number,
  consecutiveFailures: number,
): IncidentSeverity {
  if (errorRate >= 0.9 || consecutiveFailures >= 5) {
    return "critical";
  } else if (errorRate >= 0.5 || latencyRatio >= 3) {
    return "major";
  } else {
    return "minor";
  }
}

// Determine incident type
function determineIncidentType(
  errorRate: number,
  latencyRatio: number,
  hasTimeouts: boolean,
): IncidentType {
  if (errorRate >= 0.9) {
    return "complete_outage";
  } else if (hasTimeouts && errorRate > 0.3) {
    return "timeout";
  } else if (errorRate > 0.1) {
    return "high_error_rate";
  } else {
    return "latency_spike";
  }
}

// Check for degradation on a single endpoint
export async function checkForDegradation(
  db: D1Database,
  endpointId: string,
  endpointName: string,
  thresholds: DegradationThresholds = DEFAULT_THRESHOLDS,
): Promise<Incident | null> {
  // Get baseline
  const baseline = await db
    .prepare(
      "SELECT avg_latency_ms, p95_latency_ms FROM baselines WHERE endpoint_id = ?",
    )
    .bind(endpointId)
    .first<{ avg_latency_ms: number; p95_latency_ms: number }>();

  if (!baseline) {
    return null; // No baseline, can't detect degradation
  }

  // Get recent probe results (last 15 minutes)
  const { results: recentProbes } = await db
    .prepare(
      `
    SELECT status, latency_ms FROM probe_results
    WHERE endpoint_id = ?
      AND timestamp >= datetime('now', '-15 minutes')
    ORDER BY timestamp DESC
  `,
    )
    .bind(endpointId)
    .all<{ status: string; latency_ms: number | null }>();

  if (recentProbes.length === 0) {
    return null; // No recent probes
  }

  // Calculate metrics
  const totalProbes = recentProbes.length;
  const failures = recentProbes.filter((p) => p.status !== "success").length;
  const timeouts = recentProbes.filter((p) => p.status === "timeout").length;
  const errorRate = failures / totalProbes;

  const successfulLatencies = recentProbes
    .filter((p) => p.status === "success" && p.latency_ms)
    .map((p) => p.latency_ms!);

  const avgLatency =
    successfulLatencies.length > 0
      ? successfulLatencies.reduce((a, b) => a + b, 0) /
        successfulLatencies.length
      : 0;

  const latencyRatio =
    baseline.avg_latency_ms > 0 ? avgLatency / baseline.avg_latency_ms : 1;

  // Count consecutive failures from the start
  let consecutiveFailures = 0;
  for (const probe of recentProbes) {
    if (probe.status !== "success") {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  // Check thresholds
  const hasLatencySpike = latencyRatio >= thresholds.latencyMultiplier;
  const hasHighErrorRate = errorRate >= thresholds.errorRateThreshold;
  const hasConsecutiveFailures =
    consecutiveFailures >= thresholds.consecutiveFailures;

  if (!hasLatencySpike && !hasHighErrorRate && !hasConsecutiveFailures) {
    return null; // No degradation detected
  }

  // Check if there's already an active incident for this endpoint
  const existingIncident = await db
    .prepare(
      `
    SELECT id FROM incidents 
    WHERE endpoint_id = ? AND status != 'resolved'
    LIMIT 1
  `,
    )
    .bind(endpointId)
    .first();

  if (existingIncident) {
    return null; // Already have an active incident
  }

  // Create incident
  const incidentType = determineIncidentType(
    errorRate,
    latencyRatio,
    timeouts > 0,
  );
  const severity = determineSeverity(
    errorRate,
    latencyRatio,
    consecutiveFailures,
  );

  const incident: Incident = {
    id: crypto.randomUUID(),
    endpoint_id: endpointId,
    type: incidentType,
    severity,
    status: "active",
    started_at: new Date().toISOString(),
    resolved_at: undefined,
    title: generateIncidentTitle(endpointName, incidentType),
    description: generateIncidentDescription(
      incidentType,
      errorRate,
      latencyRatio,
      baseline.avg_latency_ms,
      avgLatency,
    ),
    affected_regions: undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  return incident;
}

// Generate incident title
function generateIncidentTitle(
  endpointName: string,
  type: IncidentType,
): string {
  switch (type) {
    case "complete_outage":
      return `${endpointName} is down`;
    case "timeout":
      return `${endpointName} experiencing timeouts`;
    case "high_error_rate":
      return `${endpointName} has high error rate`;
    case "latency_spike":
      return `${endpointName} latency spike detected`;
  }
}

// Generate incident description
function generateIncidentDescription(
  type: IncidentType,
  errorRate: number,
  latencyRatio: number,
  baselineLatency: number,
  currentLatency: number,
): string {
  const errorPct = (errorRate * 100).toFixed(1);
  const baselineMs = baselineLatency.toFixed(0);
  const currentMs = currentLatency.toFixed(0);

  switch (type) {
    case "complete_outage":
      return `All requests are failing. Error rate: ${errorPct}%`;
    case "timeout":
      return `Requests are timing out. Error rate: ${errorPct}%`;
    case "high_error_rate":
      return `Error rate has increased to ${errorPct}%`;
    case "latency_spike":
      return `Latency increased from ${baselineMs}ms to ${currentMs}ms (${latencyRatio.toFixed(1)}x baseline)`;
  }
}

// Store incident in database
export async function createIncident(
  db: D1Database,
  incident: Incident,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO incidents (id, endpoint_id, type, severity, status, started_at, resolved_at, title, description, affected_regions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(
      incident.id,
      incident.endpoint_id,
      incident.type,
      incident.severity,
      incident.status,
      incident.started_at,
      incident.resolved_at ?? null,
      incident.title,
      incident.description ?? null,
      incident.affected_regions ?? null,
      incident.created_at,
      incident.updated_at,
    )
    .run();

  // Create initial timeline entry
  await db
    .prepare(
      `
    INSERT INTO incident_timeline (id, incident_id, status, message, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .bind(
      crypto.randomUUID(),
      incident.id,
      "active",
      "Incident detected automatically",
      incident.created_at,
    )
    .run();
}

// Check and auto-resolve incidents
export async function checkForRecovery(
  db: D1Database,
  endpointId: string,
): Promise<boolean> {
  // Get active incident
  const activeIncident = await db
    .prepare(
      `
    SELECT id FROM incidents 
    WHERE endpoint_id = ? AND status != 'resolved'
    LIMIT 1
  `,
    )
    .bind(endpointId)
    .first<{ id: string }>();

  if (!activeIncident) {
    return false; // No active incident
  }

  // Check if last 5 probes are all successful
  const { results: recentProbes } = await db
    .prepare(
      `
    SELECT status FROM probe_results
    WHERE endpoint_id = ?
    ORDER BY timestamp DESC
    LIMIT 5
  `,
    )
    .bind(endpointId)
    .all<{ status: string }>();

  const allSuccessful =
    recentProbes.length >= 5 &&
    recentProbes.every((p) => p.status === "success");

  if (allSuccessful) {
    const now = new Date().toISOString();

    // Resolve incident
    await db
      .prepare(
        `
      UPDATE incidents 
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .bind(now, now, activeIncident.id)
      .run();

    // Add timeline entry
    await db
      .prepare(
        `
      INSERT INTO incident_timeline (id, incident_id, status, message, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .bind(
        crypto.randomUUID(),
        activeIncident.id,
        "resolved",
        "Endpoint has recovered. All recent probes successful.",
        now,
      )
      .run();

    return true;
  }

  return false;
}
