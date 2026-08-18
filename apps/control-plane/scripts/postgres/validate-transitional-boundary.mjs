import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const canonicalFiles = [
  "server/postgres.ts",
  "server/routers.ts",
  "server/contracts/events.ts",
];
const forbidden = [/\bmysql2\b/i, /drizzle-orm\/mysql/i, /\bDATABASE_URL\b/];
const violations = [];
const baseline = JSON.parse(await readFile(resolve("scripts/postgres/transitional-mysql-baseline.json"), "utf8"));
const digest = input => createHash("sha256").update(input).digest("hex");
const migrationFiles = (await readdir(resolve("drizzle/migrations"), { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name !== ".gitkeep")
  .map(entry => `drizzle/migrations/${entry.name}`)
  .sort();

for (const relativePath of canonicalFiles) {
  const contents = await readFile(resolve(relativePath), "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(contents)) violations.push(`${relativePath} matches ${pattern}`);
  }
}

for (const [relativePath, expectedDigest] of Object.entries(baseline.files)) {
  const actualDigest = digest(await readFile(resolve(relativePath)));
  if (actualDigest !== expectedDigest) violations.push(`${relativePath} changed from its approved transitional MySQL/TiDB baseline`);
}
if (JSON.stringify(migrationFiles) !== JSON.stringify(baseline.migrationFiles)) violations.push("drizzle/migrations changed from its approved transitional MySQL/TiDB baseline");

if (violations.length) {
  throw new Error(`Canonical PostgreSQL boundary violated: ${violations.join("; ")}`);
}

process.stdout.write(`${JSON.stringify({
  status: "verified",
  canonicalFiles,
  transitionalBoundary: ["server/db.ts", "server/routers/umojaflowos.ts", "drizzle/", "scripts/postgres/"],
  frozenTransitionalFiles: Object.keys(baseline.files),
  frozenTransitionalMigrationFiles: baseline.migrationFiles,
  prohibition: "Canonical PostgreSQL repositories, routers, and service contracts must not add MySQL/TiDB driver or DATABASE_URL references.",
}, null, 2)}\n`);
