export type OperatorRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor" | "provider_contact" | "cbn_liaison";

export type ConsoleAction = "counterparty" | "integration" | "alert" | "policy" | "case" | "kyc-document" | "sar-str" | "report" | "deadline" | "customer" | "beneficiary" | "liquidity" | "market" | "rate-lock" | "payment" | "payment-leg" | "evaluate-deadlines";

export function canPerformConsoleAction(role: OperatorRole | undefined, action: ConsoleAction): boolean {
  if (!role || role === "auditor" || role === "provider_contact" || role === "cbn_liaison") return false;
  if (role === "admin") return true;
  if (role === "compliance_officer") return ["policy", "case", "kyc-document", "sar-str", "report", "deadline"].includes(action);
  return ["customer", "beneficiary", "liquidity", "market", "rate-lock", "payment", "payment-leg"].includes(action);
}
