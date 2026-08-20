const controls = [
  { title: "Policy-based access", state: "Configured control", detail: "Keycloak identity claims and OPA policy decisions restrict each action by role, purpose, corridor, and evidence context. The policy layer defaults to refusal when it cannot make a safe decision." },
  { title: "Double-entry ledger", state: "Awaiting authorised attachment", detail: "TigerBeetle is the independent double-entry ledger boundary for approved value records. It is not attached in this environment, so this platform does not create ledger transfers, custody balances, or settlement claims." },
  { title: "Authorised activity record", state: "Operating record", detail: "The platform keeps attributable, append-only control records for decisions, evidence, and workflow state. A control record is not proof that a payment, provider, or regulator accepted an external action." },
  { title: "Governed components", state: "Configured, not deployed", detail: "Caddy, APISIX, Redis, Keycloak MFA, OPA, open-appsec, Kafka, Dapr, Temporal, Permify, OpenSearch, lakehouse, GeoLibre, Sedona, Mojaloop, and TigerBeetle remain unavailable until their approved environments and identities are independently validated." },
] as const;

export function GovernedControlPosture() {
  return <div className="grid divide-y divide-black/15">{controls.map(control => <div key={control.title} className="px-5 py-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-sm font-black uppercase tracking-[-0.02em]">{control.title}</p><span className="border border-black/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em]">{control.state}</span></div><p className="mt-2 text-xs leading-5 text-black/60">{control.detail}</p></div>)}</div>;
}
