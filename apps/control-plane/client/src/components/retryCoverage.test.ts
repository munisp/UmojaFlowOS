import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard: a form that can fail must offer recovery.
 *
 * Retry was added form by form, which means the next form added could easily
 * omit it. This asserts the property over the directory rather than over a
 * list, so a new form is covered the moment it exists.
 */
const DIR = join(process.cwd(), "client/src/components");

function formComponents(): Array<{ name: string; source: string }> {
  return readdirSync(DIR)
    .filter(name => name.endsWith(".tsx") && !name.includes(".test."))
    .map(name => ({ name, source: readFileSync(join(DIR, name), "utf8") }))
    .filter(file => file.source.includes("<SubmitFeedback"));
}

describe("retry coverage", () => {
  it("finds the console forms that report submission feedback", () => {
    // Guards against the sweep silently matching nothing.
    expect(formComponents().length).toBeGreaterThanOrEqual(10);
  });

  it("gives every such form a retry handler", () => {
    const missing = formComponents()
      .filter(file => !file.source.includes("onRetry="))
      .map(file => file.name);
    expect(missing).toEqual([]);
  });

  it("captures the submitted payload rather than re-reading the form on retry", () => {
    const missing = formComponents()
      .filter(file => !file.source.includes("useRetryableSubmit"))
      .map(file => file.name);
    // Re-reading the form would resend values the operator edited after the
    // failure, under a button that says "retry".
    expect(missing).toEqual([]);
  });
});
