#!/bin/sh
set -eu

: "${UMOJA_APP_DB_USER:?missing UMOJA_APP_DB_USER}"
: "${UMOJA_APP_DB_PASSWORD:?missing UMOJA_APP_DB_PASSWORD}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_user="$UMOJA_APP_DB_USER" \
  --set=app_password="$UMOJA_APP_DB_PASSWORD" \
  --set=db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
SQL
