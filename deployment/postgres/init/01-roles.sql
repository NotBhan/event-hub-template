-- Local development bootstrap.
--
-- Mirrors the documented production model: a schema-owning migration account
-- and a least-privilege runtime account. The application never runs DDL with
-- the account it uses to serve requests.
--
-- Runs automatically on first container start via /docker-entrypoint-initdb.d.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'event_app') THEN
    CREATE ROLE event_app LOGIN PASSWORD 'event_app_password';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE event_platform TO event_app;
GRANT USAGE ON SCHEMA public TO event_app;

-- Objects created later by the migration account must be reachable by the
-- runtime account without a manual grant pass.
ALTER DEFAULT PRIVILEGES FOR ROLE event_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO event_app;

ALTER DEFAULT PRIVILEGES FOR ROLE event_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO event_app;

-- Explicitly withhold schema-modification rights.
REVOKE CREATE ON SCHEMA public FROM event_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
