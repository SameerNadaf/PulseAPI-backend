/**
 * PulseAPI Backend - Cloudflare Worker Entry Point
 *
 * API Reliability Monitor for Developers
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

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

// CORS middleware
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization"],
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

// API v1 routes placeholder
app.get("/v1/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Endpoints routes (placeholder)
app.get("/v1/endpoints", async (c) => {
  // TODO: Implement in Phase 1
  return c.json({ endpoints: [], message: "Not implemented yet" });
});

// Incidents routes (placeholder)
app.get("/v1/incidents", async (c) => {
  // TODO: Implement in Phase 1
  return c.json({ incidents: [], message: "Not implemented yet" });
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found", path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,

  // Scheduled handler for cron-triggered probes
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(
      `Cron triggered at ${new Date(event.scheduledTime).toISOString()}`,
    );
    // TODO: Implement probe engine in Phase 1
  },
};
