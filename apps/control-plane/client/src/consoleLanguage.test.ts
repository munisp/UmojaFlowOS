import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps implementation vocabulary out of the console.
 *
 * The audience for this console is a treasury operator, a compliance officer,
 * and an auditor — none of whom should have to know which database the
 * platform uses in order to read a screen. This asserts over rendered text
 * only: identifiers like `trpc.postgres.*`, imports, and code comments are
 * untouched, because they are not user-facing and renaming them would create
 * churn without benefit.
 *
 * Domain terms of art are deliberately NOT banned. "SAR/STR", "corridor",
 * "reconciliation", "CBN/CBK/SARB", and "settlement" are the words these
 * stakeholders use; replacing them would make the console vaguer, not clearer.
 */
const ROOT = join(process.cwd(), "client/src");

/** Storage and transport vocabulary that carries no meaning for a stakeholder. */
const BANNED = [
  "PostgreSQL",
  "Postgres",
  "tRPC",
  "UUID",
  "cutover",
  "canonical",
  "idempotency",
  "idempotent",
  "payload",
  "schema",
  "envelope",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // shadcn primitives are vendored and carry no product copy.
      if (name === "ui") continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(path);
  }
  return out;
}

/**
 * Extracts text a user can actually read: JSX text nodes, visible attributes,
 * and toast messages. Everything else in the file is implementation.
 */
function renderedCopy(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  const texts = Array.from(stripped.matchAll(/>([^<>{}\n]{6,})</g)).map(m => m[1]);
  const attrs = Array.from(
    stripped.matchAll(/(?:placeholder|title|aria-label|label)="([^"]{4,})"/g),
  ).map(m => m[1]);
  const toasts = Array.from(stripped.matchAll(/toast\.[a-z]+\("([^"]{4,})"/g)).map(m => m[1]);
  return [...texts, ...attrs, ...toasts];
}

describe("console language", () => {
  it("reads the console source", () => {
    // Guards against the sweep matching nothing and passing vacuously.
    expect(sourceFiles(ROOT).length).toBeGreaterThanOrEqual(20);
  });

  it("uses no storage or transport vocabulary in rendered copy", () => {
    const offences: string[] = [];
    for (const path of sourceFiles(ROOT)) {
      const source = readFileSync(path, "utf8");
      for (const chunk of renderedCopy(source)) {
        for (const word of BANNED) {
          if (chunk.toLowerCase().includes(word.toLowerCase())) {
            offences.push(`${path.split("/").pop()}: "${chunk.trim().slice(0, 80)}" (${word})`);
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps the domain terms stakeholders actually use", () => {
    // The counterpart to the ban list: this fails if a future cleanup strips
    // meaningful regulatory vocabulary in pursuit of "plain language".
    const all = sourceFiles(ROOT).map(p => readFileSync(p, "utf8")).join("\n");
    for (const term of ["SAR/STR", "Corridor", "CBN", "CBK", "SARB", "KYC"]) {
      expect(all, term).toContain(term);
    }
  });
});
