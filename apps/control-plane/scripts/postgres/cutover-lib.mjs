import crypto from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  return value;
}

export function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

export function deterministicUuid(scope, sourceId) {
  const bytes = crypto.createHash("sha256").update(`umojaflowos:mysql-cutover:${scope}:${sourceId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mapRoles(rows) {
  const roles = new Set(["admin", "compliance_officer", "treasury_operator", "auditor"]);
  return rows.map(row => {
    if (!roles.has(row.role)) throw new Error(`Cutover blocked: transitional role '${row.role}' for '${row.openId}' has no canonical PostgreSQL operating-role mapping`);
    return { userSubject: row.openId, role: row.role };
  }).sort((a, b) => `${a.userSubject}:${a.role}`.localeCompare(`${b.userSubject}:${b.role}`));
}
