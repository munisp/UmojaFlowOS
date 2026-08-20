import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const runtimeRoots = ["server", "client"];
const allowedExtensions = new Set([".ts", ".tsx", ".mjs", ".json"]);
const forbidden = [
  /\bmysql2\b/i,
  /drizzle-orm\/mysql/i,
  /\bmysql(?:\+|:|_|\b)/i,
  /\btidb\b/i,
  /\bDATABASE_URL\b/,
];
const violations = [];

async function filesUnder(relativePath) {
  const entries = await readdir(resolve(relativePath), { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const child = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) results.push(...await filesUnder(child));
    else if (allowedExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) && !entry.name.includes(".test.")) results.push(child);
  }
  return results;
}

const files = [
  ...(await Promise.all(runtimeRoots.map(filesUnder))).flat(),
  "package.json",
  "vite.config.ts",
];

for (const relativePath of files) {
  const contents = await readFile(resolve(relativePath), "utf8");
  for (const pattern of forbidden) if (pattern.test(contents)) violations.push(`${relativePath} matches ${pattern}`);
}

if (violations.length) throw new Error(`PostgreSQL-only runtime boundary violated: ${violations.join("; ")}`);

process.stdout.write(`${JSON.stringify({
  status: "verified",
  runtimeRoots,
  prohibition: "Deployable UmojaFlowOS runtime accepts only PostgreSQL connection configuration and contains no MySQL/TiDB driver, schema, router, or connection variable.",
}, null, 2)}\n`);
