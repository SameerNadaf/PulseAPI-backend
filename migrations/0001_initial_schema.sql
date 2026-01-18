-- PulseAPI Database Schema
-- D1 Migration: Initial Setup

-- Enable foreign key constraints
PRAGMA foreign_keys = ON;

-- ============================================
-- USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    device_token TEXT,
    subscription_status TEXT DEFAULT 'free' CHECK(subscription_status IN ('free', 'pro', 'expired')),
    subscription_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_device_token ON users(device_token);

-- ============================================
-- ENDPOINTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT DEFAULT 'GET' CHECK(method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD')),
    headers TEXT, -- JSON string
    body TEXT,
    probe_interval_minutes INTEGER DEFAULT 5,
    timeout_seconds INTEGER DEFAULT 10,
    expected_status_codes TEXT DEFAULT '[200, 201, 204]', -- JSON array
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_endpoints_user_id ON endpoints(user_id);
CREATE INDEX idx_endpoints_is_active ON endpoints(is_active);

-- ============================================
-- PROBE RESULTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS probe_results (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout')),
    latency_ms REAL,
    status_code INTEGER,
    error_message TEXT,
    region TEXT NOT NULL,
    FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
);

CREATE INDEX idx_probe_results_endpoint_id ON probe_results(endpoint_id);
CREATE INDEX idx_probe_results_timestamp ON probe_results(timestamp);
CREATE INDEX idx_probe_results_endpoint_timestamp ON probe_results(endpoint_id, timestamp);

-- ============================================
-- BASELINES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS baselines (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT UNIQUE NOT NULL,
    avg_latency_ms REAL NOT NULL,
    p50_latency_ms REAL,
    p95_latency_ms REAL,
    p99_latency_ms REAL,
    std_deviation REAL,
    sample_count INTEGER NOT NULL,
    calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
);

CREATE INDEX idx_baselines_endpoint_id ON baselines(endpoint_id);

-- ============================================
-- INCIDENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('latency_spike', 'high_error_rate', 'timeout', 'complete_outage')),
    severity TEXT NOT NULL CHECK(severity IN ('minor', 'major', 'critical')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'investigating', 'identified', 'monitoring', 'resolved')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    title TEXT NOT NULL,
    description TEXT,
    affected_regions TEXT, -- JSON array
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
);

CREATE INDEX idx_incidents_endpoint_id ON incidents(endpoint_id);
CREATE INDEX idx_incidents_status ON incidents(status);
CREATE INDEX idx_incidents_started_at ON incidents(started_at);

-- ============================================
-- INCIDENT TIMELINE TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS incident_timeline (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);

CREATE INDEX idx_incident_timeline_incident_id ON incident_timeline(incident_id);

-- ============================================
-- NOTIFICATION LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notification_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    incident_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('incident_alert', 'recovery', 'degradation', 'test')),
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    success INTEGER DEFAULT 1,
    error_message TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE SET NULL
);

CREATE INDEX idx_notification_logs_user_id ON notification_logs(user_id);
CREATE INDEX idx_notification_logs_sent_at ON notification_logs(sent_at);
