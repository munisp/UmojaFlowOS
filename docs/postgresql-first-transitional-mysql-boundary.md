# PostgreSQL-First Control-Plane Boundary

PostgreSQL is the canonical control-plane store for UmojaFlowOS. The legacy MySQL/TiDB schema is retained only for transition reads, controlled cutover preflight, and snapshot-pinned migration tooling. It must not receive new canonical domain-model changes.

The executable `pnpm postgres:boundary` guard rejects MySQL driver, MySQL Drizzle, and `DATABASE_URL` references in the canonical PostgreSQL repository, root router, and service-contract boundary. The only approved transitional locations are `server/db.ts`, `server/routers/umojaflowos.ts`, `drizzle/`, and `scripts/postgres/`.

> Monetary truth remains in TigerBeetle after activation; PostgreSQL retains control-plane state and projections. Neither system is activated by this guard.
