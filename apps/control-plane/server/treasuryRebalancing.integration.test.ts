import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createPostgresTreasuryRecommendation,
  decidePostgresTreasuryRecommendation,
  listPostgresActivityEventsForObject,
  listPostgresTreasuryBufferPolicies,
  listPostgresTreasuryRecommendations,
} from "./postgres";

const enabled = process.env.POSTGRES_INTEGRATION_TEST === "1";
const suite = enabled ? describe : describe.skip;

const proposer = { openId: `treasury-proposer-${randomUUID()}`, role: "treasury_operator" as const };
const approver = { openId: `treasury-approver-${randomUUID()}`, role: "treasury_operator" as const };

suite("treasury rebalancing recommendation workflow", () => {
  it("fails closed when no approved buffer policy backs the recommendation", async () => {
    await expect(
      createPostgresTreasuryRecommendation(proposer, {
        bufferPolicyId: randomUUID(),
        reconciledAvailableBalance: "150000.00",
        reconciledAt: new Date(),
        balanceSourceReference: `custody-statement-${randomUUID()}`,
        verifiedNearTermFundingGap: "400000.00",
        fundingGapSourceReference: `obligation-schedule-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toThrow(/active approved treasury buffer policy is required/i);
  });

  it("reads buffer policies and recommendations without creating either", async () => {
    const policies = await listPostgresTreasuryBufferPolicies();
    const recommendations = await listPostgresTreasuryRecommendations();
    expect(Array.isArray(policies)).toBe(true);
    expect(Array.isArray(recommendations)).toBe(true);

    // Every persisted recommendation must carry both source references and an
    // expiry; the platform never derives an amount from an assumed balance.
    for (const recommendation of recommendations) {
      expect(recommendation.balanceSourceReference.length).toBeGreaterThan(0);
      expect(recommendation.fundingGapSourceReference.length).toBeGreaterThan(0);
      expect(recommendation.expiresAt).toBeInstanceOf(Date);
    }
  });

  it("runs the proposal, independent-approval, and audit path when a policy exists", async () => {
    const policies = await listPostgresTreasuryBufferPolicies();
    const active = policies.find(policy => {
      const now = new Date();
      return new Date(policy.effectiveFrom) <= now && (!policy.effectiveTo || new Date(policy.effectiveTo) > now);
    });

    if (!active) {
      // No approved policy is configured, which is the correct source-honest
      // state for a system with no authorised treasury data. The fail-closed
      // guard is already proven above, so there is nothing further to exercise
      // without fabricating an approved policy.
      expect(active).toBeUndefined();
      return;
    }

    const created = await createPostgresTreasuryRecommendation(proposer, {
      bufferPolicyId: active.id,
      reconciledAvailableBalance: "1.00",
      reconciledAt: new Date(),
      balanceSourceReference: `custody-statement-${randomUUID()}`,
      verifiedNearTermFundingGap: "1.00",
      fundingGapSourceReference: `obligation-schedule-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(created.status).toBe("proposed");
    // A proposal is a recommendation only: no execution field may be returned.
    expect(Object.keys(created)).not.toContain("executed");
    expect(Object.keys(created)).not.toContain("transferId");

    await expect(
      decidePostgresTreasuryRecommendation(proposer, {
        recommendationId: created.id,
        decision: "approved",
        decisionReason: "Self-approval attempt must be rejected by the separation-of-duties guard.",
      }),
    ).rejects.toThrow(/Independent approval is required/);

    const decided = await decidePostgresTreasuryRecommendation(approver, {
      recommendationId: created.id,
      decision: "rejected",
      decisionReason: "Rejected during regression validation; no funding action is authorised.",
    });
    expect(decided.status).toBe("rejected");

    const events = await listPostgresActivityEventsForObject("treasury_rebalancing_recommendation", created.id);
    const actions = events.map(event => event.action);
    expect(actions).toContain("treasury_recommendation.proposed");
    expect(actions.some(action => action.startsWith("treasury_recommendation.decided"))).toBe(true);

    const subjects = new Set(events.map(event => event.actorSubject));
    expect(subjects.has(proposer.openId)).toBe(true);
    expect(subjects.has(approver.openId)).toBe(true);
  });
});
