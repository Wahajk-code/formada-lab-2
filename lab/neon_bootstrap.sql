-- Run ONCE on the Neon database (SQL editor, as the project owner role), before the first deploy.
-- Creates the three application roles. None is superuser or has BYPASSRLS, so row level security
-- always applies. Replace the three passwords, and keep them for Render's environment variables.
CREATE ROLE app_owner   LOGIN PASSWORD 'CHANGE_ME_OWNER'   NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE app_user    LOGIN PASSWORD 'CHANGE_ME_USER'    NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE app_service LOGIN PASSWORD 'CHANGE_ME_SERVICE' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;

-- Replace neondb with your database name if it differs.
GRANT CONNECT, TEMPORARY ON DATABASE neondb TO app_owner, app_user, app_service;
GRANT CREATE, USAGE ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user, app_service;
ALTER SCHEMA public OWNER TO app_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, app_service;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, app_service;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_user, app_service;
