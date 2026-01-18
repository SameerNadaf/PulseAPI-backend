/**
 * PulseAPI Backend - Cloudflare Worker Entry Point
 *
 * API Reliability Monitor for Developers
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  endpointsRoutes,
  incidentsRoutes,
  probesRoutes,
  usersRoutes,
} from "./routes/api";
import { runProbeEngine, cleanupOldProbes } from "./services/probeEngine";

// Environment bindings
export interface Env {
  DB: D1Database;
  STATUS_KV: KVNamespace;
  ENVIRONMENT: string;
  API_VERSION: string;
  // APNs secrets (set via wrangler secret)
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
}

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use("/*", logger());
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization", "X-User-ID"],
  }),
);

// Health check endpoint
app.get("/", (c) => {
  return c.json({
    name: "PulseAPI Backend",
    version: c.env.API_VERSION,
    environment: c.env.ENVIRONMENT,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// API v1 health
app.get("/v1/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Mount API routes
app.route("/v1/endpoints", endpointsRoutes);
app.route("/v1/incidents", incidentsRoutes);
app.route("/v1/probes", probesRoutes);
app.route("/v1/users", usersRoutes);

// Dashboard summary endpoint
app.get("/v1/dashboard", async (c) => {
  const userId = c.req.header("X-User-ID");
  if (!userId) {
    return c.json({ success: false, error: "User ID required" }, 401);
  }

  try {
    // Get all endpoints for user
    const { results: endpoints } = await c.env.DB.prepare(
      "SELECT id, name FROM endpoints WHERE user_id = ?",
    )
      .bind(userId)
      .all();

    // Get health summaries from KV
    const healthSummaries = await Promise.all(
      endpoints.map(async (ep: any) => {
        const health = await c.env.STATUS_KV.get(`health:${ep.id}`, "json");
        return { endpoint: ep, health };
      }),
    );

    // Get active incidents
    const { results: activeIncidents } = await c.env.DB.prepare(
      `
      SELECT i.* FROM incidents i
      INNER JOIN endpoints e ON i.endpoint_id = e.id
      WHERE e.user_id = ? AND i.status != 'resolved'
      ORDER BY i.started_at DESC
      LIMIT 10
    `,
    )
      .bind(userId)
      .all();

    // Calculate overall health
    const healthyCount = healthSummaries.filter(
      (s: any) => s.health?.status === "healthy",
    ).length;
    const totalCount = healthSummaries.length;
    const overallHealth =
      totalCount > 0 ? (healthyCount / totalCount) * 100 : 100;

    return c.json({
      success: true,
      data: {
        overallHealth: Math.round(overallHealth),
        endpointCount: totalCount,
        healthyCount,
        degradedCount: healthSummaries.filter(
          (s: any) => s.health?.status === "degraded",
        ).length,
        downCount: healthSummaries.filter(
          (s: any) => s.health?.status === "down",
        ).length,
        activeIncidentCount: activeIncidents.length,
        endpoints: healthSummaries,
        recentIncidents: activeIncidents.slice(0, 5),
      },
    });
  } catch (error) {
    console.error("Error fetching dashboard:", error);
    return c.json({ success: false, error: "Failed to fetch dashboard" }, 500);
  }
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: "Not Found",
      path: c.req.path,
    },
    404,
  );
});

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      success: false,
      error:
        c.env.ENVIRONMENT === "production"
          ? "Internal Server Error"
          : err.message,
    },
    500,
  );
});

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,

  // Scheduled handler for cron-triggered probes
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(
      `Cron triggered at ${new Date(event.scheduledTime).toISOString()}`,
    );

    // Run probe engine
    ctx.waitUntil(runProbeEngine(env));

    // Cleanup old data (run once daily at midnight)
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (hour === 0) {
      ctx.waitUntil(cleanupOldProbes(env, 30));
    }
  },
};
