import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A structural guard, not a behavioural one.
 *
 * Every console component that renders a form writes canonical records, so each
 * must have DOM coverage. Without this check the coverage gap is invisible:
 * adding a new form and forgetting its test leaves a green suite, which is
 * exactly how five of the existing forms went untested until they were audited.
 */

const COMPONENTS_DIR = join(process.cwd(), "client", "src", "components");

/** Template-provided components that are not part of the operator console. */
const TEMPLATE_COMPONENTS = new Set([
  "AIChatBox.tsx",
  "DashboardLayout.tsx",
  "DashboardLayoutSkeleton.tsx",
  "ErrorBoundary.tsx",
  "Map.tsx",
]);

describe("console form coverage", () => {
  it("has a DOM regression file for every console component that renders a form", () => {
    const sources = readdirSync(COMPONENTS_DIR).filter(
      entry => entry.endsWith(".tsx") && !entry.includes(".test.") && !TEMPLATE_COMPONENTS.has(entry),
    );

    // Guard against the check silently covering nothing.
    expect(sources.length).toBeGreaterThan(8);

    const uncovered: string[] = [];
    for (const source of sources) {
      const contents = readFileSync(join(COMPONENTS_DIR, source), "utf8");
      const rendersForm = contents.includes("<form") || contents.includes("onSubmit");
      if (!rendersForm) continue;

      const own = join(COMPONENTS_DIR, source.replace(/\.tsx$/, ".test.tsx"));
      if (existsSync(own)) continue;

      // A component may instead be covered by a grouped regression file that
      // imports it by name.
      const coveredElsewhere = readdirSync(COMPONENTS_DIR)
        .filter(entry => entry.endsWith(".test.tsx"))
        .some(entry => readFileSync(join(COMPONENTS_DIR, entry), "utf8").includes(source.replace(/\.tsx$/, "")));

      if (!coveredElsewhere) uncovered.push(source);
    }

    expect(uncovered, `console forms without DOM coverage: ${uncovered.join(", ")}`).toEqual([]);
  });
});
