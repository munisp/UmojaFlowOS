#!/usr/bin/env node
// Bundle budget gate (perf/slo.yaml → mobile.bundle). Runs after `vite build`
// in CI; exits non-zero if any budget is exceeded. Budgets are gzip bytes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = new URL("../dist/public/assets/", import.meta.url).pathname;
const BUDGETS = {
  initialKb: 170, // entry chunk + vendor-react
  routeChunkKb: 90, // any lazy route chunk
  totalJsKb: 600,
};

const files = readdirSync(DIST).filter((f) => f.endsWith(".js"));
if (files.length === 0) {
  console.error("no JS bundles found — run `pnpm build` first");
  process.exit(2);
}

let total = 0;
let failures = [];
const rows = files
  .map((f) => {
    const gz = gzipSync(readFileSync(join(DIST, f))).length;
    total += gz;
    return { f, kb: gz / 1024 };
  })
  .sort((a, b) => b.kb - a.kb);

for (const { f, kb } of rows) {
  const isEntry = /^(index|main)-/.test(f) || f.includes("vendor-react");
  const budget = isEntry ? BUDGETS.initialKb : BUDGETS.routeChunkKb;
  const mark = kb > budget ? " OVER-BUDGET" : "";
  if (kb > budget && !isEntry) failures.push(`${f}: ${kb.toFixed(1)}KB > ${budget}KB route budget`);
  console.log(`${kb.toFixed(1).padStart(8)}KB gzip  ${f}${mark}`);
}
console.log(`${(total / 1024).toFixed(1).padStart(8)}KB gzip  TOTAL`);

// entry budget applies to entry + vendor-react combined (what first paint pays)
const entryTotal = rows
  .filter(({ f }) => /^(index|main)-/.test(f) || f.includes("vendor-react"))
  .reduce((s, r) => s + r.kb, 0);
if (entryTotal > BUDGETS.initialKb)
  failures.push(`initial JS ${entryTotal.toFixed(1)}KB > ${BUDGETS.initialKb}KB budget`);
if (total / 1024 > BUDGETS.totalJsKb)
  failures.push(`total JS ${(total / 1024).toFixed(1)}KB > ${BUDGETS.totalJsKb}KB budget`);

if (failures.length) {
  console.error("\nBUNDLE BUDGET FAILURES (fail-closed):");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nbundle budgets ok");
