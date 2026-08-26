import { describe, expect, it } from "vitest";

import { assertBeneficiaryScreeningClear } from "./paymentWorkflow";

describe("payment beneficiary screening gate", () => {
  it("allows only an explicit clear decision into payment drafting", () => {
    expect(() => assertBeneficiaryScreeningClear("clear")).not.toThrow();
  });

  it.each(["not_run", "potential_match", "confirmed_match", "source_unavailable", "unknown"]) (
    "fails closed for %s",
    screeningState => {
      expect(() => assertBeneficiaryScreeningClear(screeningState)).toThrow(
        /screening must be clear before drafting/i,
      );
    },
  );
});
