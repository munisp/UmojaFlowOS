export type OperatingRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor" | "provider_contact" | "cbn_liaison";

export const legacyOperatingRoles = new Set<OperatingRole>(["admin", "compliance_officer", "treasury_operator", "auditor"]);
