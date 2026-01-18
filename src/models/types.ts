/**
 * TypeScript interfaces for PulseAPI domain models
 */

// HTTP Methods
export type HTTPMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

// Endpoint Status
export type EndpointStatus = "healthy" | "degraded" | "down" | "unknown";

// Endpoint Model (matches D1 schema)
export interface Endpoint {
  id: string;
  user_id: string;
  name: string;
  url: string;
  method: HTTPMethod;
  headers?: string | Record<string, string>;
  body?: string;
  probe_interval_minutes: number;
  timeout_seconds: number;
  expected_status_codes: string | number[];
  is_active: number; // SQLite uses 0/1 for boolean
  created_at: string;
  updated_at: string;
}

// Probe Result Status
export type ProbeResultStatus = "success" | "error" | "timeout";

// Probe Result
export interface ProbeResult {
  id: string;
  endpoint_id: string;
  timestamp: string;
  status: ProbeResultStatus;
  latency_ms?: number;
  status_code?: number;
  error_message?: string;
  region: string;
}

// Baseline
export interface Baseline {
  id: string;
  endpoint_id: string;
  avg_latency_ms: number;
  p50_latency_ms?: number;
  p95_latency_ms?: number;
  p99_latency_ms?: number;
  std_deviation?: number;
  sample_count: number;
  calculated_at: string;
}

// Incident Types
export type IncidentType =
  | "latency_spike"
  | "high_error_rate"
  | "timeout"
  | "complete_outage";
export type IncidentSeverity = "minor" | "major" | "critical";
export type IncidentStatus =
  | "active"
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

// Incident Model
export interface Incident {
  id: string;
  endpoint_id: string;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  started_at: string;
  resolved_at?: string;
  title: string;
  description?: string;
  affected_regions?: string; // JSON array
  created_at: string;
  updated_at: string;
}

// Incident Timeline Entry
export interface IncidentTimelineEntry {
  id: string;
  incident_id: string;
  status: IncidentStatus;
  message: string;
  timestamp: string;
}

// Endpoint Health Summary (for KV cache)
export interface EndpointHealthSummary {
  endpoint_id: string;
  status: EndpointStatus;
  reliability_score: number;
  current_latency_ms?: number;
  baseline_latency_ms?: number;
  error_rate: number;
  last_probe_at?: string;
  last_incident_at?: string;
  uptime_percentage: number;
}

// User Model
export interface User {
  id: string;
  email: string;
  device_token?: string;
  subscription_status: "free" | "pro" | "expired";
  subscription_expires_at?: string;
  created_at: string;
  updated_at: string;
}

// API Response wrapper
export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

// Dashboard Summary
export interface DashboardSummary {
  overallHealth: number;
  endpointCount: number;
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  activeIncidentCount: number;
  endpoints: Array<{
    endpoint: { id: string; name: string };
    health: EndpointHealthSummary | null;
  }>;
  recentIncidents: Incident[];
}
