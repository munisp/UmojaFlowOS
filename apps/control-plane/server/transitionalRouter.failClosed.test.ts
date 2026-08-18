import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "server/routers/umojaflowos.ts"), "utf8");

/**
 * The transitional MySQL/TiDB schema is frozen. Every mutation on the
 * transitional router must therefore either delegate to the canonical
 * PostgreSQL repository or fail closed; no mutation may write through the
 * transitional `db` module. Reads stay available so historical records remain
 * inspectable during cutover.
 */
describe("transitional router fail-closed boundary", () => {
  /**
   * Extracts each mutation body by balancing parentheses from the `.mutation(`
   * call site. Canonical delegations may span many lines (for example the
   * scheduler-backed reminder job), so a fixed-width regex would truncate them
   * and produce false positives.
   */
  const mutationBlocks: string[] = [];
  for (let index = source.indexOf(".mutation("); index !== -1; index = source.indexOf(".mutation(", index + 1)) {
    let depth = 0;
    const start = index + ".mutation(".length;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === "(") depth += 1;
      else if (character === ")") {
        if (depth === 0) {
          mutationBlocks.push(source.slice(start, cursor));
          break;
        }
        depth -= 1;
      }
    }
  }

  it("finds transitional mutations to evaluate", () => {
    expect(mutationBlocks.length).toBeGreaterThan(10);
  });

  it("routes no mutation through the transitional MySQL/TiDB module", () => {
    const offenders = mutationBlocks.filter(block => /\bdb\.\w+\(/.test(block));
    expect(offenders).toEqual([]);
  });

  it("makes every non-canonical mutation fail closed with an explicit precondition error", () => {
    const offenders = mutationBlocks.filter(block => !/postgres\.\w+\(/.test(block) && !/PRECONDITION_FAILED/.test(block));
    expect(offenders).toEqual([]);
  });

  it("keeps transitional reads available for cutover inspection", () => {
    expect(source).toMatch(/\.query\(/);
    expect(source).toMatch(/db\.list\w+/);
  });
});
