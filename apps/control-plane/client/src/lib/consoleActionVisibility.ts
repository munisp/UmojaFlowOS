import { canPerformConsoleAction, type ConsoleAction, type OperatorRole } from "./roleCapabilities";

export type ComposerAction = ConsoleAction | "authorization" | "consent" | "analysis";
export type ConsoleModule = "registry" | "integrations" | "governance" | "treasury" | "markets" | "payments" | "compliance" | "reports" | "alerts";

type ActionDescriptor = { label: string; action: ComposerAction };

export const consoleModuleActions: Record<ConsoleModule, ActionDescriptor[]> = {
  registry: [{ label: "Record", action: "counterparty" }, { label: "Licence", action: "authorization" }],
  integrations: [{ label: "New connection", action: "integration" }],
  governance: [{ label: "New policy", action: "policy" }],
  treasury: [{ label: "New position", action: "liquidity" }],
  markets: [{ label: "Observe", action: "market" }, { label: "Lock", action: "rate-lock" }],
  payments: [{ label: "Draft", action: "payment" }, { label: "Leg", action: "payment-leg" }],
  compliance: [
    { label: "New case", action: "case" },
    { label: "KYC evidence", action: "kyc-document" },
    { label: "Consent", action: "consent" },
    { label: "Analyse", action: "analysis" },
    { label: "SAR/STR", action: "sar-str" },
  ],
  reports: [{ label: "Report", action: "report" }, { label: "Deadline", action: "deadline" }],
  alerts: [{ label: "Policy", action: "alert" }, { label: "Evaluate", action: "evaluate-deadlines" }],
};

export function canOpenConsoleComposer(role: OperatorRole | undefined, action: ComposerAction): boolean {
  // Licence authorisation is administrator-only.
  if (action === "authorization") return role === "admin";
  // A SAR/STR filing is a personal regulatory attestation by a compliance
  // officer, so administrator delegation is excluded here even though it
  // applies to the rest of the compliance module. This mirrors the
  // compliance-only procedure gate on the server.
  if (action === "sar-str") return role === "compliance_officer";
  // Consent capture and analysis submission both act on the data subject's
  // lawful basis, so they are the compliance officer's own responsibility and
  // are not delegated to an administrator.
  if (action === "consent" || action === "analysis") return role === "compliance_officer";
  return canPerformConsoleAction(role, action);
}

export function visibleConsoleModuleActions(role: OperatorRole | undefined, module: ConsoleModule): string[] {
  return consoleModuleActions[module].filter(({ action }) => canOpenConsoleComposer(role, action)).map(({ label }) => label);
}
