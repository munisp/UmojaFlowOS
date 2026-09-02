\set ON_ERROR_STOP on

\echo '== roles =='
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin
FROM pg_roles
WHERE rolname IN ('umoja_app', 'assurance_schema_owner')
ORDER BY rolname;

\echo '== database =='
SELECT datname, pg_get_userbyid(datdba) AS owner,
       has_database_privilege('umoja_app', datname, 'CONNECT') AS app_connect,
       has_database_privilege('umoja_app', datname, 'CREATE') AS app_database_create
FROM pg_database
WHERE datname = 'umoja_test';

\echo '== role memberships =='
SELECT member.rolname AS member, parent.rolname AS granted_role
FROM pg_auth_members AS m
JOIN pg_roles AS member ON member.oid = m.member
JOIN pg_roles AS parent ON parent.oid = m.roleid
WHERE member.rolname IN ('umoja_app', 'assurance_schema_owner')
ORDER BY member.rolname, parent.rolname;

\echo '== public schema privileges =='
SELECT has_schema_privilege('umoja_app', 'public', 'USAGE') AS app_usage,
       has_schema_privilege('umoja_app', 'public', 'CREATE') AS app_create,
       has_schema_privilege('assurance_schema_owner', 'public', 'CREATE') AS owner_create;

\echo '== app table grants =='
SELECT table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'umoja_app'
ORDER BY table_schema, table_name, privilege_type;

\echo '== objects owned by app =='
SELECT n.nspname AS schema_name, c.relname AS object_name,
       c.relkind, pg_get_userbyid(c.relowner) AS owner
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'umoja_app'
ORDER BY c.relname;

\echo '== app default privileges =='
SELECT defaclrole::regrole AS grantor,
       defaclnamespace::regnamespace AS schema_name,
       defaclobjtype, defaclacl
FROM pg_default_acl
WHERE defaclrole = 'umoja_app'::regrole;
