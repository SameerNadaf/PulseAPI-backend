/**
 * APNs Push Notification Service
 *
 * Sends push notifications to iOS devices using Apple Push Notification service
 */

import type { Env } from "../index";
import type { Incident, IncidentSeverity } from "../models/types";

// APNs token payload
interface APNsPayload {
  aps: {
    alert: {
      title: string;
      subtitle?: string;
      body: string;
    };
    sound?: string;
    badge?: number;
    "thread-id"?: string;
    "interruption-level"?: "passive" | "active" | "time-sensitive" | "critical";
    "relevance-score"?: number;
  };
  // Custom data
  incidentId?: string;
  endpointId?: string;
  type?: string;
}

// JWT Header for APNs
interface JWTHeader {
  alg: string;
  kid: string;
}

// JWT Payload for APNs
interface JWTPayload {
  iss: string;
  iat: number;
}

// Base64URL encode
function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Generate JWT token for APNs authentication
async function generateAPNsToken(
  keyId: string,
  teamId: string,
  privateKey: string,
): Promise<string> {
  const header: JWTHeader = {
    alg: "ES256",
    kid: keyId,
  };

  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    iss: teamId,
    iat: now,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const message = `${headerB64}.${payloadB64}`;

  // Import the private key
  const keyData = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  // Sign the message
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(message),
  );

  const signatureB64 = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature)),
  );

  return `${message}.${signatureB64}`;
}

// Send push notification to a single device
export async function sendPushNotification(
  env: Env,
  deviceToken: string,
  payload: APNsPayload,
  options: {
    production?: boolean;
    priority?: 5 | 10;
    expiration?: number;
    collapseId?: string;
  } = {},
): Promise<{ success: boolean; error?: string }> {
  // Check for required secrets
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
    console.error("APNs credentials not configured");
    return { success: false, error: "APNs not configured" };
  }

  try {
    // Generate JWT token
    const token = await generateAPNsToken(
      env.APNS_KEY_ID,
      env.APNS_TEAM_ID,
      env.APNS_PRIVATE_KEY,
    );

    // Determine APNs host
    const host = options.production
      ? "api.push.apple.com"
      : "api.sandbox.push.apple.com";

    const bundleId = "com.pulseapi.PulseAPI";

    // Send request to APNs
    const response = await fetch(`https://${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "apns-topic": bundleId,
        "apns-push-type": "alert",
        "apns-priority": String(options.priority ?? 10),
        ...(options.expiration && {
          "apns-expiration": String(options.expiration),
        }),
        ...(options.collapseId && { "apns-collapse-id": options.collapseId }),
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return { success: true };
    }

    const errorBody = await response.json().catch(() => ({}));
    console.error("APNs error:", response.status, errorBody);

    return {
      success: false,
      error: (errorBody as any).reason || `HTTP ${response.status}`,
    };
  } catch (error: any) {
    console.error("APNs request failed:", error);
    return { success: false, error: error.message };
  }
}

// Send incident alert notification
export async function sendIncidentAlert(
  env: Env,
  deviceToken: string,
  incident: Incident,
  endpointName: string,
): Promise<{ success: boolean; error?: string }> {
  const interruptionLevel = getInterruptionLevel(incident.severity);

  const payload: APNsPayload = {
    aps: {
      alert: {
        title: getAlertTitle(incident.severity),
        subtitle: endpointName,
        body: incident.title,
      },
      sound: incident.severity === "critical" ? "critical.caf" : "default",
      "thread-id": `incident-${incident.endpoint_id}`,
      "interruption-level": interruptionLevel,
      "relevance-score": getRelevanceScore(incident.severity),
    },
    incidentId: incident.id,
    endpointId: incident.endpoint_id,
    type: "incident_alert",
  };

  const result = await sendPushNotification(env, deviceToken, payload, {
    collapseId: `incident-${incident.id}`,
    priority: incident.severity === "critical" ? 10 : 5,
  });

  // Log notification
  await logNotification(
    env.DB,
    incident.endpoint_id, // Using endpoint's user lookup
    incident.id,
    "incident_alert",
    result.success,
    result.error,
  );

  return result;
}

// Send recovery notification
export async function sendRecoveryNotification(
  env: Env,
  deviceToken: string,
  incident: Incident,
  endpointName: string,
): Promise<{ success: boolean; error?: string }> {
  const payload: APNsPayload = {
    aps: {
      alert: {
        title: "✅ Recovered",
        subtitle: endpointName,
        body: `${incident.title} has been resolved`,
      },
      sound: "default",
      "thread-id": `incident-${incident.endpoint_id}`,
      "interruption-level": "passive",
    },
    incidentId: incident.id,
    endpointId: incident.endpoint_id,
    type: "recovery",
  };

  const result = await sendPushNotification(env, deviceToken, payload, {
    collapseId: `incident-${incident.id}`,
    priority: 5,
  });

  // Log notification
  await logNotification(
    env.DB,
    incident.endpoint_id,
    incident.id,
    "recovery",
    result.success,
    result.error,
  );

  return result;
}

// Get alert title based on severity
function getAlertTitle(severity: IncidentSeverity): string {
  switch (severity) {
    case "critical":
      return "🚨 Critical Alert";
    case "major":
      return "⚠️ Major Issue";
    case "minor":
      return "📢 Minor Issue";
  }
}

// Get iOS interruption level based on severity
function getInterruptionLevel(
  severity: IncidentSeverity,
): "passive" | "active" | "time-sensitive" | "critical" {
  switch (severity) {
    case "critical":
      return "critical";
    case "major":
      return "time-sensitive";
    case "minor":
      return "active";
  }
}

// Get relevance score (0-1) based on severity
function getRelevanceScore(severity: IncidentSeverity): number {
  switch (severity) {
    case "critical":
      return 1.0;
    case "major":
      return 0.8;
    case "minor":
      return 0.5;
  }
}

// Log notification to database
async function logNotification(
  db: D1Database,
  userId: string,
  incidentId: string | null,
  type: string,
  success: boolean,
  errorMessage?: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `
      INSERT INTO notification_logs (id, user_id, incident_id, type, sent_at, success, error_message)
      VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
    `,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        incidentId,
        type,
        success ? 1 : 0,
        errorMessage ?? null,
      )
      .run();
  } catch (error) {
    console.error("Failed to log notification:", error);
  }
}

// Send notifications to all users monitoring an endpoint
export async function notifyEndpointUsers(
  env: Env,
  endpointId: string,
  incident: Incident,
  type: "alert" | "recovery",
): Promise<{ sent: number; failed: number }> {
  // Get endpoint with user info
  const endpoint = await env.DB.prepare(
    `
    SELECT e.name, u.device_token, u.id as user_id
    FROM endpoints e
    INNER JOIN users u ON e.user_id = u.id
    WHERE e.id = ? AND u.device_token IS NOT NULL
  `,
  )
    .bind(endpointId)
    .first<{
      name: string;
      device_token: string;
      user_id: string;
    }>();

  if (!endpoint || !endpoint.device_token) {
    return { sent: 0, failed: 0 };
  }

  const result =
    type === "alert"
      ? await sendIncidentAlert(
          env,
          endpoint.device_token,
          incident,
          endpoint.name,
        )
      : await sendRecoveryNotification(
          env,
          endpoint.device_token,
          incident,
          endpoint.name,
        );

  return {
    sent: result.success ? 1 : 0,
    failed: result.success ? 0 : 1,
  };
}
