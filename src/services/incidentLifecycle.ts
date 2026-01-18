/**
 * Incident Lifecycle Manager
 *
 * Manages incident state transitions, updates, and resolution
 */

import type { Env } from "../index";
import type {
  Incident,
  IncidentStatus,
  IncidentSeverity,
} from "../models/types";

// Valid status transitions
const VALID_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  active: ["investigating", "identified", "resolved"],
  investigating: ["identified", "monitoring", "resolved"],
  identified: ["monitoring", "resolved"],
  monitoring: ["resolved", "active"], // Can revert if issue recurs
  resolved: ["active"], // Can reopen
};

// Check if status transition is valid
export function isValidTransition(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// Update incident status
export async function updateIncidentStatus(
  db: D1Database,
  incidentId: string,
  newStatus: IncidentStatus,
  message: string,
): Promise<{ success: boolean; error?: string }> {
  // Get current incident
  const incident = await db
    .prepare("SELECT status FROM incidents WHERE id = ?")
    .bind(incidentId)
    .first<{ status: IncidentStatus }>();

  if (!incident) {
    return { success: false, error: "Incident not found" };
  }

  // Validate transition
  if (!isValidTransition(incident.status, newStatus)) {
    return {
      success: false,
      error: `Invalid transition from ${incident.status} to ${newStatus}`,
    };
  }

  const now = new Date().toISOString();
  const resolvedAt = newStatus === "resolved" ? now : null;

  // Update incident
  await db
    .prepare(
      `
    UPDATE incidents 
    SET status = ?, resolved_at = COALESCE(?, resolved_at), updated_at = ?
    WHERE id = ?
  `,
    )
    .bind(newStatus, resolvedAt, now, incidentId)
    .run();

  // Add timeline entry
  await db
    .prepare(
      `
    INSERT INTO incident_timeline (id, incident_id, status, message, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .bind(crypto.randomUUID(), incidentId, newStatus, message, now)
    .run();

  return { success: true };
}

// Update incident severity
export async function updateIncidentSeverity(
  db: D1Database,
  incidentId: string,
  newSeverity: IncidentSeverity,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  const now = new Date().toISOString();

  const result = await db
    .prepare(
      `
    UPDATE incidents 
    SET severity = ?, updated_at = ?
    WHERE id = ? AND status != 'resolved'
  `,
    )
    .bind(newSeverity, now, incidentId)
    .run();

  if (result.meta.changes === 0) {
    return { success: false, error: "Incident not found or already resolved" };
  }

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
      incidentId,
      "identified", // Use 'identified' for severity updates
      `Severity updated to ${newSeverity}: ${reason}`,
      now,
    )
    .run();

  return { success: true };
}

// Get incident with timeline
export async function getIncidentWithTimeline(
  db: D1Database,
  incidentId: string,
): Promise<{ incident: Incident | null; timeline: any[] }> {
  const incident = await db
    .prepare("SELECT * FROM incidents WHERE id = ?")
    .bind(incidentId)
    .first<Incident>();

  if (!incident) {
    return { incident: null, timeline: [] };
  }

  const { results: timeline } = await db
    .prepare(
      `
    SELECT * FROM incident_timeline 
    WHERE incident_id = ? 
    ORDER BY timestamp ASC
  `,
    )
    .bind(incidentId)
    .all();

  return { incident, timeline };
}

// List active incidents for an endpoint
export async function getActiveIncidentsForEndpoint(
  db: D1Database,
  endpointId: string,
): Promise<Incident[]> {
  const { results } = await db
    .prepare(
      `
    SELECT * FROM incidents 
    WHERE endpoint_id = ? AND status != 'resolved'
    ORDER BY started_at DESC
  `,
    )
    .bind(endpointId)
    .all<Incident>();

  return results;
}

// Get all incidents for user with pagination
export async function getIncidentsForUser(
  db: D1Database,
  userId: string,
  options: {
    status?: IncidentStatus;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ incidents: Incident[]; total: number }> {
  const { status, limit = 20, offset = 0 } = options;

  let countQuery = `
    SELECT COUNT(*) as total FROM incidents i
    INNER JOIN endpoints e ON i.endpoint_id = e.id
    WHERE e.user_id = ?
  `;
  let dataQuery = `
    SELECT i.* FROM incidents i
    INNER JOIN endpoints e ON i.endpoint_id = e.id
    WHERE e.user_id = ?
  `;

  const params: any[] = [userId];

  if (status) {
    countQuery += " AND i.status = ?";
    dataQuery += " AND i.status = ?";
    params.push(status);
  }

  dataQuery += " ORDER BY i.started_at DESC LIMIT ? OFFSET ?";

  const countResult = await db
    .prepare(countQuery)
    .bind(...params)
    .first<{ total: number }>();
  const { results } = await db
    .prepare(dataQuery)
    .bind(...params, limit, offset)
    .all<Incident>();

  return {
    incidents: results,
    total: countResult?.total ?? 0,
  };
}

// Calculate incident statistics
export async function getIncidentStats(
  db: D1Database,
  userId: string,
  daysBack: number = 30,
): Promise<{
  total: number;
  active: number;
  resolved: number;
  bySeverity: Record<IncidentSeverity, number>;
  avgResolutionTimeMs: number | null;
}> {
  const stats = await db
    .prepare(
      `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN i.status != 'resolved' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN i.status = 'resolved' THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN i.severity = 'critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN i.severity = 'major' THEN 1 ELSE 0 END) as major,
      SUM(CASE WHEN i.severity = 'minor' THEN 1 ELSE 0 END) as minor,
      AVG(CASE 
        WHEN i.resolved_at IS NOT NULL 
        THEN (julianday(i.resolved_at) - julianday(i.started_at)) * 86400000 
        ELSE NULL 
      END) as avg_resolution_ms
    FROM incidents i
    INNER JOIN endpoints e ON i.endpoint_id = e.id
    WHERE e.user_id = ?
      AND i.created_at >= datetime('now', '-${daysBack} days')
  `,
    )
    .bind(userId)
    .first<any>();

  return {
    total: stats?.total ?? 0,
    active: stats?.active ?? 0,
    resolved: stats?.resolved ?? 0,
    bySeverity: {
      critical: stats?.critical ?? 0,
      major: stats?.major ?? 0,
      minor: stats?.minor ?? 0,
    },
    avgResolutionTimeMs: stats?.avg_resolution_ms ?? null,
  };
}

// Merge duplicate incidents (if multiple detected within timeframe)
export async function mergeIncidents(
  db: D1Database,
  primaryId: string,
  secondaryIds: string[],
): Promise<void> {
  const now = new Date().toISOString();

  // Move timeline entries to primary incident
  for (const secondaryId of secondaryIds) {
    await db
      .prepare(
        `
      UPDATE incident_timeline 
      SET incident_id = ? 
      WHERE incident_id = ?
    `,
      )
      .bind(primaryId, secondaryId)
      .run();

    // Delete secondary incident
    await db
      .prepare("DELETE FROM incidents WHERE id = ?")
      .bind(secondaryId)
      .run();
  }

  // Add merge note to timeline
  await db
    .prepare(
      `
    INSERT INTO incident_timeline (id, incident_id, status, message, timestamp)
    VALUES (?, ?, 'identified', ?, ?)
  `,
    )
    .bind(
      crypto.randomUUID(),
      primaryId,
      `Merged ${secondaryIds.length} related incident(s)`,
      now,
    )
    .run();
}
