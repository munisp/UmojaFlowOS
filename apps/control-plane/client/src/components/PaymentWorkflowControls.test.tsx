import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  availablePaymentTransitions,
  canOperatePayments,
  internalPaymentTransitions,
  liveRateLocks,
  PaymentLegForm,
  PaymentLegLedger,
  PaymentOrderForm,
  PaymentOrderLedger,
  providerDependentPaymentStates,
  RateLockExpiryControl,
  type BeneficiaryOption,
  type CounterpartyOption,
  type CustomerOption,
  type LiveRateLock,
  type PaymentLegRow,
  type PaymentOrderRow,
} from "./PaymentWorkflowControls";

afterEach(cleanup);

const NOW = new Date("2026-08-18T12:00:00Z");

const customers: CustomerOption[] = [{ id: "cust-1", legalName: "Registered Customer" }];
const beneficiaries: BeneficiaryOption[] = [
  { id: "ben-1", customerId: "cust-1", legalName: "Registered Beneficiary", screeningState: "pending_screening" },
];
const liveLock: LiveRateLock = {
  id: "lock-1",
  corridor: "NIGERIA_NGN",
  baseAsset: "USD",
  quoteAsset: "NGN",
  lockedRate: "1650.25000000",
  status: "locked",
  expiresAt: new Date("2026-08-18T13:00:00Z"),
};

function order(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id: "order-1",
    idempotencyKey: "instruction-key-0001",
    corridor: "NIGERIA_NGN",
    customerLegalName: "Registered Customer",
    beneficiaryLegalName: "Registered Beneficiary",
    sourceCurrency: "USD",
    sourceAmount: "1000.00",
    targetCurrency: "NGN",
    targetAmount: "1650250.00000000",
    status: "draft",
    providerFinalityReference: null,
    createdBy: "treasury-operator",
    createdAt: new Date("2026-08-18T11:00:00Z"),
    ...overrides,
  };
}

describe("payment workflow boundaries", () => {
  it("restricts payment operation to treasury operators and administrators", () => {
    expect(canOperatePayments("treasury_operator")).toBe(true);
    expect(canOperatePayments("admin")).toBe(true);
    expect(canOperatePayments("compliance_officer")).toBe(false);
    expect(canOperatePayments("auditor")).toBe(false);
    expect(canOperatePayments(undefined)).toBe(false);
  });

  it("never offers a provider-dependent execution state as a transition", () => {
    const offered = new Set<string>(Object.values(internalPaymentTransitions).flat());
    for (const state of providerDependentPaymentStates) {
      expect(offered.has(state)).toBe(false);
    }
  });

  it("offers no transition out of a terminal cancelled state", () => {
    expect(availablePaymentTransitions("cancelled")).toEqual([]);
    expect(availablePaymentTransitions("completed")).toEqual([]);
  });

  it("treats an elapsed or cancelled lock as not live", () => {
    const elapsed = { ...liveLock, id: "lock-2", expiresAt: new Date("2026-08-18T11:00:00Z") };
    const cancelled = { ...liveLock, id: "lock-3", status: "cancelled" };
    expect(liveRateLocks([liveLock, elapsed, cancelled], NOW).map(lock => lock.id)).toEqual(["lock-1"]);
  });
});

describe("payment workflow console rendering", () => {
  const legs: PaymentLegRow[] = [
    {
      id: "leg-1",
      paymentOrderId: "order-1",
      sequenceNumber: 1,
      legKind: "payout",
      counterpartyLegalName: "Authorised Correspondent",
      status: "draft",
      providerInstructionReference: null,
      providerFinalityReference: null,
    },
  ];
  const counterparties: CounterpartyOption[] = [{ id: "cp-1", legalName: "Authorised Correspondent" }];

  it("offers leg lifecycle controls to treasury operators but not auditors", () => {
    const { unmount } = render(
      <PaymentLegLedger legs={legs} loading={false} role="treasury_operator" pending={false} transition={() => undefined} />,
    );
    expect(screen.getByTestId("payment-leg-transition-form-leg-1")).toBeTruthy();
    unmount();

    render(<PaymentLegLedger legs={legs} loading={false} role="auditor" pending={false} transition={() => undefined} />);
    expect(screen.queryByTestId("payment-leg-transition-form-leg-1")).toBeNull();
  });

  it("offers no leg transition once the leg is cancelled", () => {
    render(
      <PaymentLegLedger
        legs={[{ ...legs[0]!, status: "cancelled" }]}
        loading={false}
        role="treasury_operator"
        pending={false}
        transition={() => undefined}
      />,
    );
    expect(screen.queryByTestId("payment-leg-transition-form-leg-1")).toBeNull();
  });

  it("withholds leg creation until a draft order and authorised counterparty exist", () => {
    const { unmount } = render(<PaymentLegForm orders={[]} counterparties={[]} pending={false} submit={() => undefined} />);
    expect(screen.getByTestId("payment-leg-form-unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    const noCounterparty = render(
      <PaymentLegForm orders={[order()]} counterparties={[]} pending={false} submit={() => undefined} />,
    );
    expect(screen.getByTestId("payment-leg-form-unavailable")).toBeTruthy();
    noCounterparty.unmount();

    render(<PaymentLegForm orders={[order()]} counterparties={counterparties} pending={false} submit={() => undefined} />);
    expect(screen.getByTestId("payment-leg-form")).toBeTruthy();
    expect(screen.getByText(/currently verified licence authorisation/)).toBeTruthy();
  });

  it("offers leg creation only against a draft order", () => {
    render(
      <PaymentLegForm
        orders={[order({ status: "approved" })]}
        counterparties={counterparties}
        pending={false}
        submit={() => undefined}
      />,
    );
    expect(screen.getByTestId("payment-leg-form-unavailable")).toBeTruthy();
  });

  it("withholds drafting until a customer, beneficiary, and live lock all exist", () => {
    const { unmount } = render(
      <PaymentOrderForm customers={[]} beneficiaries={[]} rateLocks={[]} pending={false} submit={() => undefined} now={NOW} />,
    );
    expect(screen.getByTestId("payment-draft-unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    const partial = render(
      <PaymentOrderForm customers={customers} beneficiaries={beneficiaries} rateLocks={[]} pending={false} submit={() => undefined} now={NOW} />,
    );
    expect(screen.getByTestId("payment-draft-unavailable")).toBeTruthy();
    partial.unmount();

    render(
      <PaymentOrderForm customers={customers} beneficiaries={beneficiaries} rateLocks={[liveLock]} pending={false} submit={() => undefined} now={NOW} />,
    );
    expect(screen.getByTestId("payment-draft-form")).toBeTruthy();
    expect(screen.getByText(/contacts no payment provider/)).toBeTruthy();
  });

  it("shows the derived target amount and the absence of a finality reference", () => {
    render(
      <PaymentOrderLedger orders={[order()]} loading={false} role="auditor" pending={false} transition={() => undefined} />,
    );
    expect(screen.getByText("1650250.00000000 NGN")).toBeTruthy();
    expect(screen.getByTestId("payment-order-no-finality-order-1")).toBeTruthy();
  });

  it("offers lifecycle transitions to treasury operators but not auditors", () => {
    const { unmount } = render(
      <PaymentOrderLedger orders={[order()]} loading={false} role="treasury_operator" pending={false} transition={() => undefined} />,
    );
    expect(screen.getByTestId("payment-transition-form-order-1")).toBeTruthy();
    unmount();

    render(
      <PaymentOrderLedger orders={[order()]} loading={false} role="auditor" pending={false} transition={() => undefined} />,
    );
    expect(screen.queryByTestId("payment-transition-form-order-1")).toBeNull();
  });

  it("offers no transition control on a cancelled order even for treasury", () => {
    render(
      <PaymentOrderLedger orders={[order({ status: "cancelled" })]} loading={false} role="treasury_operator" pending={false} transition={() => undefined} />,
    );
    expect(screen.queryByTestId("payment-transition-form-order-1")).toBeNull();
  });

  it("explains the empty order and leg states without implying settlement", () => {
    const { unmount } = render(
      <PaymentOrderLedger orders={[]} loading={false} role="treasury_operator" pending={false} transition={() => undefined} />,
    );
    expect(screen.getByTestId("payment-orders-empty")).toBeTruthy();
    expect(screen.getByText(/No order, amount, or settlement state is simulated/)).toBeTruthy();
    unmount();

    render(<PaymentLegLedger legs={[]} loading={false} />);
    expect(screen.getByTestId("payment-legs-empty")).toBeTruthy();
    expect(screen.getByText(/currently verified licence authorisation/)).toBeTruthy();
  });

  it("renders leg provider references as explicitly absent when unset", () => {
    const legs: PaymentLegRow[] = [
      {
        id: "leg-1",
        paymentOrderId: "order-1",
        sequenceNumber: 1,
        legKind: "payout",
        counterpartyLegalName: "Authorised Correspondent",
        status: "draft",
        providerInstructionReference: null,
        providerFinalityReference: null,
      },
    ];
    render(<PaymentLegLedger legs={legs} loading={false} />);
    expect(screen.getByText(/Provider instruction \/ finality: none \/ none/)).toBeTruthy();
    expect(screen.getByText("Authorised Correspondent")).toBeTruthy();
  });

  it("gates rate-lock expiry evaluation to treasury roles", () => {
    const { unmount } = render(<RateLockExpiryControl role="auditor" pending={false} expire={() => undefined} />);
    expect(screen.getByTestId("rate-lock-expiry-unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    render(<RateLockExpiryControl role="treasury_operator" pending={false} expire={() => undefined} />);
    expect(screen.getByTestId("rate-lock-expiry-control")).toBeTruthy();
    expect(screen.getByText(/Repeating the evaluation changes nothing further/)).toBeTruthy();
  });
});
