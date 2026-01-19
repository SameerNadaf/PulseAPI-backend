/**
 * API Route Handlers
 *
 * Organized by resource: endpoints, incidents, probes, users
 */

import { Hono } from "hono";
import type { Env } from "../index";

// Create routes
export const endpointsRoutes = new Hono<{ Bindings: Env }>();
export const incidentsRoutes = new Hono<{ Bindings: Env }>();
export const probesRoutes = new Hono<{ Bindings: Env }>();
export const usersRoutes = new Hono<{ Bindings: Env }>();

// ============================================
// ENDPOINTS ROUTES
// ============================================

// List all endpoints for a user
endpointsRoutes.get("/", async (c) => {
  const userId = c.req.header("X-User-ID");
  if (!userId) {
    return c.json({ success: false, error: "User ID required" }, 401);
  }

  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM endpoints WHERE user_id = ? ORDER BY created_at DESC",
    )
      .bind(userId)
      .all();

    return c.json({
      success: true,
      data: results,
      meta: { total: results.length },
    });
  } catch (error) {
    console.error("Error fetching endpoints:", error);
    return c.json({ success: false, error: "Failed to fetch endpoints" }, 500);
  }
});

// Get single endpoint with health summary
endpointsRoutes.get("/:id", async (c) => {
  const endpointId = c.req.param("id");
  const userId = c.req.header("X-User-ID");

  try {
    const endpoint = await c.env.DB.prepare(
      "SELECT * FROM endpoints WHERE id = ? AND user_id = ?",
    )
      .bind(endpointId, userId)
      .first<any>();

    if (!endpoint) {
      return c.json({ success: false, error: "Endpoint not found" }, 404);
    }

    // Transform to camelCase for iOS
    return c.json({
      success: true,
      data: {
        id: endpoint.id,
        userId: endpoint.user_id,
        name: endpoint.name,
        url: endpoint.url,
        method: endpoint.method,
        headers: endpoint.headers,
        body: endpoint.body,
        probeIntervalMinutes: endpoint.probe_interval_minutes,
        timeoutSeconds: endpoint.timeout_seconds,
        expectedStatusCodes: endpoint.expected_status_codes,
        isActive: endpoint.is_active,
        createdAt: endpoint.created_at,
        updatedAt: endpoint.updated_at,
      },
    });
  } catch (error) {
    console.error("Error fetching endpoint:", error);
    return c.json({ success: false, error: "Failed to fetch endpoint" }, 500);
  }
});

// Get endpoint health summary
endpointsRoutes.get("/:id/health", async (c) => {
  const endpointId = c.req.param("id");
  const userId = c.req.header("X-User-ID");

  try {
    // Verify endpoint exists and belongs to user
    const endpoint = await c.env.DB.prepare(
      "SELECT id FROM endpoints WHERE id = ? AND user_id = ?",
    )
      .bind(endpointId, userId)
      .first();

    if (!endpoint) {
      return c.json({ success: false, error: "Endpoint not found" }, 404);
    }

    // Get recent probe stats (last 24 hours)
    const stats = await c.env.DB.prepare(
      `
      SELECT 
        COUNT(*) as total_probes,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        AVG(latency_ms) as avg_latency_ms,
        MAX(timestamp) as last_probe_at
      FROM probe_results
      WHERE endpoint_id = ?
        AND timestamp >= datetime('now', '-24 hours')
    `,
    )
      .bind(endpointId)
      .first<any>();

    // Get 30-day uptime stats
    const uptimeStats = await c.env.DB.prepare(
      `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
      FROM probe_results
      WHERE endpoint_id = ?
        AND timestamp >= datetime('now', '-30 days')
    `,
    )
      .bind(endpointId)
      .first<any>();

    // Get last incident
    const lastIncident = await c.env.DB.prepare(
      `
      SELECT started_at FROM incidents 
      WHERE endpoint_id = ? 
      ORDER BY started_at DESC 
      LIMIT 1
    `,
    )
      .bind(endpointId)
      .first<any>();

    // Calculate metrics
    const totalProbes = stats?.total_probes || 0;
    const successCount = stats?.success_count || 0;
    const errorRate =
      totalProbes > 0 ? (totalProbes - successCount) / totalProbes : 0;
    const uptimeTotal = uptimeStats?.total || 0;
    const uptimeSuccess = uptimeStats?.success || 0;
    const uptimePercentage =
      uptimeTotal > 0 ? (uptimeSuccess / uptimeTotal) * 100 : 100;

    // Reliability score (weighted: 60% uptime, 30% error rate, 10% latency)
    const reliabilityScore = Math.max(
      0,
      Math.min(
        100,
        uptimePercentage * 0.6 +
          (1 - errorRate) * 100 * 0.3 +
          (stats?.avg_latency_ms
            ? Math.max(0, 100 - stats.avg_latency_ms / 10)
            : 100) *
            0.1,
      ),
    );

    // Determine status
    let status = "healthy";
    if (errorRate > 0.5 || uptimePercentage < 50) {
      status = "down";
    } else if (errorRate > 0.1 || uptimePercentage < 95) {
      status = "degraded";
    }

    return c.json({
      success: true,
      data: {
        endpointId,
        status,
        reliabilityScore: Math.round(reliabilityScore * 10) / 10,
        currentLatencyMs: stats?.avg_latency_ms || null,
        baselineLatencyMs: null, // Would come from baselines table
        errorRate: Math.round(errorRate * 1000) / 1000,
        lastProbeAt: stats?.last_probe_at || null,
        lastIncidentAt: lastIncident?.started_at || null,
        uptimePercentage: Math.round(uptimePercentage * 100) / 100,
      },
    });
  } catch (error) {
    console.error("Error fetching endpoint health:", error);
    return c.json({ success: false, error: "Failed to fetch health" }, 500);
  }
});

// Create new endpoint
endpointsRoutes.post("/", async (c) => {
  const userId = c.req.header("X-User-ID");
  if (!userId) {
    return c.json({ success: false, error: "User ID required" }, 401);
  }

  try {
    const body = await c.req.json();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Auto-create user if not exists (for Firebase Auth users)
    const existingUser = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ?",
    )
      .bind(userId)
      .first();

    if (!existingUser) {
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
        .bind(userId, `${userId}@firebase.user`, now, now)
        .run();
    }

    await c.env.DB.prepare(
      `
      INSERT INTO endpoints (id, user_id, name, url, method, headers, body, probe_interval_minutes, timeout_seconds, expected_status_codes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `,
    )
      .bind(
        id,
        userId,
        body.name,
        body.url,
        body.method || "GET",
        body.headers ? JSON.stringify(body.headers) : null,
        body.body || null,
        body.probeIntervalMinutes || 5,
        body.timeoutSeconds || 10,
        JSON.stringify(body.expectedStatusCodes || [200, 201, 204]),
        now,
        now,
      )
      .run();

    return c.json(
      {
        success: true,
        data: {
          id,
          userId,
          name: body.name,
          url: body.url,
          method: body.method || "GET",
          headers: body.headers ? JSON.stringify(body.headers) : null,
          body: body.body || null,
          probeIntervalMinutes: body.probeIntervalMinutes || 5,
          timeoutSeconds: body.timeoutSeconds || 10,
          expectedStatusCodes: JSON.stringify(
            body.expectedStatusCodes || [200, 201, 204],
          ),
          isActive: 1,
          createdAt: now,
          updatedAt: now,
        },
      },
      201,
    );
  } catch (error) {
    console.error("Error creating endpoint:", error);
    return c.json({ success: false, error: "Failed to create endpoint" }, 500);
  }
});

// Update endpoint
endpointsRoutes.put("/:id", async (c) => {
  const endpointId = c.req.param("id");
  const userId = c.req.header("X-User-ID");

  try {
    const body = await c.req.json();
    const now = new Date().toISOString();

    const result = await c.env.DB.prepare(
      `
      UPDATE endpoints 
      SET name = ?, url = ?, method = ?, headers = ?, body = ?, 
          probe_interval_minutes = ?, timeout_seconds = ?, 
          expected_status_codes = ?, is_active = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    )
      .bind(
        body.name,
        body.url,
        body.method || "GET",
        body.headers ? JSON.stringify(body.headers) : null,
        body.body || null,
        body.probeIntervalMinutes || 5,
        body.timeoutSeconds || 10,
        JSON.stringify(body.expectedStatusCodes || [200, 201, 204]),
        body.isActive ? 1 : 0,
        now,
        endpointId,
        userId,
      )
      .run();

    if (result.meta.changes === 0) {
      return c.json({ success: false, error: "Endpoint not found" }, 404);
    }

    return c.json({
      success: true,
      data: { id: endpointId, ...body, updatedAt: now },
    });
  } catch (error) {
    console.error("Error updating endpoint:", error);
    return c.json({ success: false, error: "Failed to update endpoint" }, 500);
  }
});

// Delete endpoint
endpointsRoutes.delete("/:id", async (c) => {
  const endpointId = c.req.param("id");
  const userId = c.req.header("X-User-ID");

  try {
    const result = await c.env.DB.prepare(
      "DELETE FROM endpoints WHERE id = ? AND user_id = ?",
    )
      .bind(endpointId, userId)
      .run();

    if (result.meta.changes === 0) {
      return c.json({ success: false, error: "Endpoint not found" }, 404);
    }

    // Clear KV cache
    await c.env.STATUS_KV.delete(`health:${endpointId}`);

    return c.json({ success: true, data: { deleted: true } });
  } catch (error) {
    console.error("Error deleting endpoint:", error);
    return c.json({ success: false, error: "Failed to delete endpoint" }, 500);
  }
});

// ============================================
// INCIDENTS ROUTES
// ============================================

// List incidents
incidentsRoutes.get("/", async (c) => {
  const userId = c.req.header("X-User-ID");
  const status = c.req.query("status"); // Filter by status
  const limit = parseInt(c.req.query("limit") || "50");

  try {
    let query = `
      SELECT i.* FROM incidents i
      INNER JOIN endpoints e ON i.endpoint_id = e.id
      WHERE e.user_id = ?
    `;
    const params: any[] = [userId];

    if (status) {
      query += " AND i.status = ?";
      params.push(status);
    }

    query += " ORDER BY i.started_at DESC LIMIT ?";
    params.push(limit);

    const stmt = c.env.DB.prepare(query);
    const { results } = await stmt.bind(...params).all();

    return c.json({
      success: true,
      data: results,
      meta: { total: results.length },
    });
  } catch (error) {
    console.error("Error fetching incidents:", error);
    return c.json({ success: false, error: "Failed to fetch incidents" }, 500);
  }
});

// Get incident with timeline
incidentsRoutes.get("/:id", async (c) => {
  const incidentId = c.req.param("id");

  try {
    const incident = await c.env.DB.prepare(
      "SELECT * FROM incidents WHERE id = ?",
    )
      .bind(incidentId)
      .first();

    if (!incident) {
      return c.json({ success: false, error: "Incident not found" }, 404);
    }

    const { results: timeline } = await c.env.DB.prepare(
      "SELECT * FROM incident_timeline WHERE incident_id = ? ORDER BY timestamp ASC",
    )
      .bind(incidentId)
      .all();

    return c.json({
      success: true,
      data: { incident, timeline },
    });
  } catch (error) {
    console.error("Error fetching incident:", error);
    return c.json({ success: false, error: "Failed to fetch incident" }, 500);
  }
});

// Update incident status
incidentsRoutes.patch("/:id/status", async (c) => {
  const incidentId = c.req.param("id");

  try {
    const { status, message } = await c.req.json<{
      status: string;
      message: string;
    }>();

    // Validate status
    const validStatuses = [
      "active",
      "investigating",
      "identified",
      "monitoring",
      "resolved",
    ];
    if (!validStatuses.includes(status)) {
      return c.json({ success: false, error: "Invalid status" }, 400);
    }

    // Get current incident
    const incident = await c.env.DB.prepare(
      "SELECT status FROM incidents WHERE id = ?",
    )
      .bind(incidentId)
      .first<{ status: string }>();

    if (!incident) {
      return c.json({ success: false, error: "Incident not found" }, 404);
    }

    const now = new Date().toISOString();
    const resolvedAt = status === "resolved" ? now : null;

    // Update incident
    await c.env.DB.prepare(
      `
      UPDATE incidents 
      SET status = ?, resolved_at = COALESCE(?, resolved_at), updated_at = ?
      WHERE id = ?
    `,
    )
      .bind(status, resolvedAt, now, incidentId)
      .run();

    // Add timeline entry
    await c.env.DB.prepare(
      `
      INSERT INTO incident_timeline (id, incident_id, status, message, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
      .bind(crypto.randomUUID(), incidentId, status, message, now)
      .run();

    return c.json({
      success: true,
      data: { status, updatedAt: now },
    });
  } catch (error) {
    console.error("Error updating incident status:", error);
    return c.json({ success: false, error: "Failed to update status" }, 500);
  }
});

// Get incident statistics
incidentsRoutes.get("/stats/summary", async (c) => {
  const userId = c.req.header("X-User-ID");
  if (!userId) {
    return c.json({ success: false, error: "User ID required" }, 401);
  }

  try {
    const stats = await c.env.DB.prepare(
      `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN i.status != 'resolved' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN i.status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN i.severity = 'critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN i.severity = 'major' THEN 1 ELSE 0 END) as major,
        SUM(CASE WHEN i.severity = 'minor' THEN 1 ELSE 0 END) as minor
      FROM incidents i
      INNER JOIN endpoints e ON i.endpoint_id = e.id
      WHERE e.user_id = ?
        AND i.created_at >= datetime('now', '-30 days')
    `,
    )
      .bind(userId)
      .first();

    return c.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Error fetching incident stats:", error);
    return c.json({ success: false, error: "Failed to fetch stats" }, 500);
  }
});

// ============================================
// PROBES ROUTES
// ============================================

// Get probe history for endpoint
probesRoutes.get("/history/:endpointId", async (c) => {
  const endpointId = c.req.param("endpointId");
  const hours = parseInt(c.req.query("hours") || "24");
  const limit = parseInt(c.req.query("limit") || "100");

  try {
    const { results } = await c.env.DB.prepare(
      `
      SELECT * FROM probe_results 
      WHERE endpoint_id = ? 
        AND timestamp >= datetime('now', '-${hours} hours')
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    )
      .bind(endpointId, limit)
      .all<any>();

    // Transform to camelCase for iOS
    const transformedResults = results.map((r: any) => ({
      id: r.id,
      endpointId: r.endpoint_id,
      timestamp: r.timestamp,
      status: r.status,
      latencyMs: r.latency_ms,
      statusCode: r.status_code,
      errorMessage: r.error_message,
      region: r.region,
    }));

    return c.json({
      success: true,
      data: transformedResults,
      meta: { total: results.length, hours },
    });
  } catch (error) {
    console.error("Error fetching probe history:", error);
    return c.json(
      { success: false, error: "Failed to fetch probe history" },
      500,
    );
  }
});

// Get probe statistics
probesRoutes.get("/stats/:endpointId", async (c) => {
  const endpointId = c.req.param("endpointId");
  const hours = parseInt(c.req.query("hours") || "24");

  try {
    const stats = await c.env.DB.prepare(
      `
      SELECT 
        COUNT(*) as total_probes,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeout_count,
        AVG(latency_ms) as avg_latency_ms,
        MIN(latency_ms) as min_latency_ms,
        MAX(latency_ms) as max_latency_ms
      FROM probe_results
      WHERE endpoint_id = ?
        AND timestamp >= datetime('now', '-${hours} hours')
    `,
    )
      .bind(endpointId)
      .first<any>();

    // Transform to camelCase for iOS
    return c.json({
      success: true,
      data: stats
        ? {
            totalProbes: stats.total_probes,
            successCount: stats.success_count,
            errorCount: stats.error_count,
            timeoutCount: stats.timeout_count,
            avgLatencyMs: stats.avg_latency_ms,
            minLatencyMs: stats.min_latency_ms,
            maxLatencyMs: stats.max_latency_ms,
          }
        : null,
    });
  } catch (error) {
    console.error("Error fetching probe stats:", error);
    return c.json(
      { success: false, error: "Failed to fetch probe stats" },
      500,
    );
  }
});

// ============================================
// USERS ROUTES
// ============================================

// Register device token for push notifications
usersRoutes.post("/device-token", async (c) => {
  const userId = c.req.header("X-User-ID");
  if (!userId) {
    return c.json({ success: false, error: "User ID required" }, 401);
  }

  try {
    const { deviceToken } = await c.req.json();
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      `
      UPDATE users SET device_token = ?, updated_at = ? WHERE id = ?
    `,
    )
      .bind(deviceToken, now, userId)
      .run();

    return c.json({ success: true, data: { registered: true } });
  } catch (error) {
    console.error("Error registering device token:", error);
    return c.json(
      { success: false, error: "Failed to register device token" },
      500,
    );
  }
});

// Get user profile
usersRoutes.get("/me", async (c) => {
  const userId = c.req.header("X-User-ID");
  if (!userId) {
    return c.json({ success: false, error: "User ID required" }, 401);
  }

  try {
    const user = await c.env.DB.prepare(
      "SELECT id, email, subscription_status, subscription_expires_at, created_at FROM users WHERE id = ?",
    )
      .bind(userId)
      .first();

    if (!user) {
      return c.json({ success: false, error: "User not found" }, 404);
    }

    // Get endpoint count
    const endpointCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM endpoints WHERE user_id = ?",
    )
      .bind(userId)
      .first();

    return c.json({
      success: true,
      data: {
        ...user,
        endpointCount: endpointCount?.count || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    return c.json({ success: false, error: "Failed to fetch user" }, 500);
  }
});
