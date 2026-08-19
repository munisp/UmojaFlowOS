import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OperatorRole } from "@/lib/roleCapabilities";

export type OnboardingModule =
  | "overview"
  | "payments"
  | "treasury"
  | "markets"
  | "compliance"
  | "reports"
  | "registry"
  | "integrations";

export type OnboardingSignals = {
  counterparties: number;
  integrations: number;
  customers: number;
  consents: number;
  documents: number;
  liquidityPositions: number;
  marketObservations: number;
  paymentOrders: number;
  complianceCases: number;
  reports: number;
  auditEvents: number;
};

type JourneyStep = {
  title: string;
  detail: string;
  module: OnboardingModule;
  completed: (signals: OnboardingSignals) => boolean;
};

type Journey = {
  roleLabel: string;
  title: string;
  intro: string;
  boundary: string;
  steps: JourneyStep[];
};

const journeys: Record<OperatorRole, Journey> = {
  admin: {
    roleLabel: "Administrator",
    title: "Establish controlled operating foundations",
    intro: "Build the approved counterparty and connection register before any live capability is considered.",
    boundary: "Registering a connection does not activate a provider. Activation remains a verified, auditable health-check decision.",
    steps: [
      { title: "Record a regulated counterparty", detail: "Register the provider or institution and retain its source-backed legal identity.", module: "registry", completed: signals => signals.counterparties > 0 },
      { title: "Register a connection", detail: "Describe the approved connection without placing a credential in the browser or records store.", module: "integrations", completed: signals => signals.integrations > 0 },
      { title: "Review credential governance", detail: "Use the protected administrator control to name a deployment secret and inspect its attributable history.", module: "integrations", completed: signals => signals.integrations > 0 && signals.auditEvents > 0 },
      { title: "Review operating posture", detail: "Check service status and attributable activity before handing work to operational roles.", module: "overview", completed: signals => signals.auditEvents > 0 },
    ],
  },
  compliance_officer: {
    roleLabel: "Compliance officer",
    title: "Create a reviewable evidence journey",
    intro: "Start with a recognised subject, capture lawful basis, then collect evidence for human review.",
    boundary: "Document analysis produces evidence only. It never grants an automated KYC/KYB approval, rejection, or payment decision.",
    steps: [
      { title: "Create the evidence subject", detail: "Record the customer before collecting personal or business verification material.", module: "compliance", completed: signals => signals.customers > 0 },
      { title: "Record verification consent", detail: "Capture the lawful scope and expiry before analysis may be requested.", module: "compliance", completed: signals => signals.consents > 0 },
      { title: "Store an authorised document", detail: "Upload protected document evidence and retain its checksum and provenance.", module: "compliance", completed: signals => signals.documents > 0 },
      { title: "Review evidence and decide", detail: "Record an attributable human decision or open a compliance case with its rationale.", module: "compliance", completed: signals => signals.complianceCases > 0 },
      { title: "Prepare reportable follow-up", detail: "Draft a SAR/STR or regulatory record only from a verified case and supporting evidence.", module: "reports", completed: signals => signals.reports > 0 },
    ],
  },
  treasury_operator: {
    roleLabel: "Treasury operator",
    title: "Build a controlled payment path",
    intro: "Work from reconciled positions and source evidence before drafting an order or recommendation.",
    boundary: "Drafting, locking a rate, or proposing a rebalance does not move funds. Provider finality and independent controls remain required.",
    steps: [
      { title: "Record a reconciled position", detail: "Capture actual nostro, vostro, pre-funding, liquidity, or custody evidence with its source reference.", module: "treasury", completed: signals => signals.liquidityPositions > 0 },
      { title: "Review market evidence", detail: "Use independently sourced NGN, KES, or ZAR observations before considering a rate lock.", module: "markets", completed: signals => signals.marketObservations > 0 },
      { title: "Draft a payment order", detail: "Create an order against a live rate lock and an authorised customer/beneficiary relationship.", module: "payments", completed: signals => signals.paymentOrders > 0 },
      { title: "Review the settlement path", detail: "Add only authorised legs and track control transitions; no screen represents settlement without evidence.", module: "payments", completed: signals => signals.paymentOrders > 0 && signals.counterparties > 0 },
    ],
  },
  auditor: {
    roleLabel: "Auditor",
    title: "Inspect attributable control evidence",
    intro: "Review the platform’s records, decisions, health observations, and regulatory workflow without obtaining operational authority.",
    boundary: "This role can inspect recorded evidence. It cannot approve a payment, alter a credential reference, or change a compliance outcome.",
    steps: [
      { title: "Review operating posture", detail: "Inspect the current live-capability boundary and attributable activity register.", module: "overview", completed: signals => signals.auditEvents > 0 },
      { title: "Inspect service observations", detail: "Review Go, Rust, and Python health readings with their collection time and known gaps.", module: "integrations", completed: signals => signals.integrations > 0 },
      { title: "Inspect payment and treasury records", detail: "Review draft orders, legs, rate-lock evidence, and treasury recommendations without changing them.", module: "payments", completed: signals => signals.paymentOrders > 0 || signals.liquidityPositions > 0 },
      { title: "Inspect compliance and reporting evidence", detail: "Review evidence, cases, and CBN, CBK, or SARB report workflow records.", module: "reports", completed: signals => signals.complianceCases > 0 || signals.reports > 0 },
    ],
  },
};

function StepMarker({ done }: { done: boolean }) {
  return done ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[#e11919]" /> : <Circle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-black/25" />;
}

export function StakeholderOnboardingWorkspace({
  role,
  signals,
  onNavigate,
}: {
  role: OperatorRole | undefined;
  signals: OnboardingSignals;
  onNavigate: (module: OnboardingModule) => void;
}) {
  if (!role) {
    return (
      <section className="uf-panel" aria-labelledby="onboarding-title">
        <div className="border-b border-black/20 px-5 py-4">
          <p className="uf-kicker">Role workspace</p>
          <h2 id="onboarding-title" className="mt-1 text-lg font-black tracking-[-0.045em] uppercase">Sign in to see your controlled workflow</h2>
        </div>
        <p className="px-5 py-6 text-sm leading-6 text-black/60">Each UmojaFlowOS role has a separate evidence, review, and authority boundary. Sign in to view only the steps your assigned role may perform.</p>
      </section>
    );
  }

  const journey = journeys[role];
  const completedCount = journey.steps.filter(step => step.completed(signals)).length;
  const nextStep = journey.steps.find(step => !step.completed(signals));

  return (
    <section className="uf-panel" aria-labelledby="onboarding-title" data-testid={`stakeholder-onboarding-${role}`}>
      <div className="flex flex-col gap-4 border-b border-black/20 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="uf-kicker">{journey.roleLabel} workspace</p>
          <h2 id="onboarding-title" className="mt-1 text-lg font-black tracking-[-0.045em] uppercase">{journey.title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-black/65">{journey.intro}</p>
        </div>
        <div className="shrink-0 border-l-4 border-[#e11919] pl-3 text-right">
          <p className="uf-kicker">Recorded milestones</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{completedCount}/{journey.steps.length}</p>
        </div>
      </div>
      <div className="divide-y divide-black/10">
        {journey.steps.map((step, index) => {
          const complete = step.completed(signals);
          const isNext = nextStep?.title === step.title;
          return (
            <div key={step.title} className="flex items-start gap-3 px-5 py-4">
              <StepMarker done={complete} />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/45">Step {index + 1} · {complete ? "Record available" : isNext ? "Next review point" : "Awaiting earlier evidence"}</p>
                <h3 className="mt-1 text-sm font-black uppercase tracking-[-0.02em]">{step.title}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-black/60">{step.detail}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="rounded-none border-black/30 text-xs font-black uppercase hover:border-[#e11919] hover:bg-[#e11919] hover:text-white"
                onClick={() => onNavigate(step.module)}
                aria-label={`Open ${step.module} for ${step.title}`}
              >
                Open <ArrowRight aria-hidden="true" className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="border-t border-black/20 bg-black/[0.025] px-5 py-4 text-sm leading-6 text-black/65">
        <span className="font-black uppercase tracking-[0.08em] text-black">Authority boundary: </span>{journey.boundary}
      </div>
    </section>
  );
}
