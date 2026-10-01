#!/bin/sh
set -eu

app_password="$(cat /run/secrets/postgres_app_password)"

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$app_password" <<'SQL'
CREATE ROLE quefa_app
  LOGIN
  NOINHERIT
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD :'app_password';

REVOKE ALL ON DATABASE quefa FROM PUBLIC;
GRANT CONNECT ON DATABASE quefa TO quefa_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO quefa_app;

ALTER DEFAULT PRIVILEGES FOR ROLE quefa_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO quefa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE quefa_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO quefa_app;
SQL

unset app_password
