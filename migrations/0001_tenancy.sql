-- R1 tenancy: tenant -> agent -> channel.
--
-- Apply with:
--   wrangler d1 migrations apply <database> --remote
--
-- The Worker treats the D1 binding as optional. Until it is bound and a
-- channel row exists, Slack routing stays in the legacy single-tenant form.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  slack_team_id TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  workspace_repo   TEXT,
  workspace_branch TEXT,
  model            TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agents_tenant ON agents(tenant_id);

CREATE TABLE IF NOT EXISTS channel_bindings (
  slack_team_id TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (slack_team_id, channel_id)
);

CREATE INDEX IF NOT EXISTS channel_bindings_agent ON channel_bindings(agent_id);
