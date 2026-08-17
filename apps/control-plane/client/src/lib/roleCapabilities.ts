export type OperatorRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

export type ConsoleAction = "counterparty" | "integration" | "alert" | "policy" | "case" | "report" | "deadline" | "customer" | "beneficiary" | "liquidity" | "market" | "rate-lock" | "payment" | "payment-leg" | "evaluate-deadlines";

export function canPerformConsoleAction(role: OperatorRole | undefined, action: ConsoleAction): boolean {
  if (!role || role === "auditor") return false;
  if (role === "admin") return true;
  if (role === "compliance_officer") return ["policy", "case", "report", "deadline"].includes(action);
  return ["customer", "beneficiary", "liquidity", "market", "rate-lock", "payment", "payment-leg"].includes(action);
}
