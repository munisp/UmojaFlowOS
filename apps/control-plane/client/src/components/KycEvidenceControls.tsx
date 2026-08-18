import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormEvent, useState } from "react";

type AnalysisJob = {
  id: string;
  caseKind: string;
  documentClass: string;
  sourceSha256: string;
  state: string;
  submittedBy: string;
  submittedAt: Date;
};

export function KycEvidenceNotice() {
  return <div className="border-b border-black/15 bg-black/[0.02] px-5 py-4">
    <p className="text-sm font-bold">Visual analysis is document-gated</p>
    <p className="mt-1 max-w-3xl text-xs leading-5 text-black/60">The local Qwen3-VL development runtime is available, but no document is submitted without active, scope-matched consent and authorised source material. Absent evidence is recorded as unavailable or review-required; it is never treated as an approval or rejection.</p>
  </div>;
}

export function KycAnalysisJobTable({ jobs, loading }: { jobs: AnalysisJob[]; loading: boolean }) {
  if (loading) return <div className="px-5 py-8 text-sm text-black/55">Loading persisted analysis-job evidence…</div>;
  if (!jobs.length) return <div className="px-5 py-8"><p className="font-bold">No authorised analysis jobs</p><p className="mt-1 text-sm leading-6 text-black/55">No KYC or KYB document has been submitted for analysis. This console will not manufacture an identity, business, document, or model result.</p></div>;
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-black/20 text-[10px] uppercase tracking-wider text-black/45"><tr><th className="px-5 py-3">Scope</th><th className="px-4 py-3">Document class</th><th className="px-4 py-3">Source hash</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Submitted</th></tr></thead><tbody>{jobs.map(job => <tr className="border-b border-black/10" key={job.id}><td className="px-5 py-3 font-bold uppercase">{job.caseKind}</td><td className="px-4 py-3">{job.documentClass}</td><td className="px-4 py-3 font-mono text-[10px]">{job.sourceSha256.slice(0, 16)}…</td><td className="px-4 py-3"><Badge className="rounded-none border-0 bg-black/5 text-[10px] font-bold uppercase text-black">{job.state.replaceAll("_", " ")}</Badge></td><td className="px-4 py-3 text-black/55">{new Date(job.submittedAt).toLocaleString()}</td></tr>)}</tbody></table></div>;
}

export function KycEvidenceLedger({ evidence, loading }: { evidence: Array<{ id: string; caseKind: string; documentClass: string; kind: string; disposition: string; engineName: string; engineVersion: string; modelTag: string | null; modelDigest: string | null; signals: unknown[]; limitations: unknown[]; createdAt: Date }>; loading: boolean }) {
  if (loading) return <div className="px-5 py-8 text-sm text-black/55">Loading persisted evidence…</div>;
  if (!evidence.length) return <div className="px-5 py-8"><p className="font-bold">No persisted analysis evidence</p><p className="mt-1 text-sm leading-6 text-black/55">OCR, document-structure, visual-consistency, presentation-attack-risk, and engine-unavailable evidence appears only after a consent-backed job records attributable evidence.</p></div>;
  // An unavailable analysis runtime must read as a blocked review rather than a
  // clean result, so it is called out above the ledger instead of appearing as
  // one row among many.
  const unavailable = evidence.filter(item => item.disposition === "unavailable" || item.kind === "engine_unavailable");
  return <div className="overflow-x-auto">{unavailable.length ? <div className="border-b-2 border-[#e11919] bg-[#e11919]/[0.06] px-5 py-4"><div className="flex items-start gap-3"><span aria-hidden className="mt-1 block h-3 w-3 shrink-0 bg-[#e11919]" /><div><p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#e11919]">Analysis runtime unavailable · review blocked</p><p className="mt-1 max-w-3xl text-xs leading-5 text-black/70">{unavailable.length} evidence record{unavailable.length === 1 ? "" : "s"} report an unavailable analysis runtime. This is a recorded state, not a result: no verification determination exists for the affected {unavailable.length === 1 ? "job" : "jobs"}, and each remains pending human review.</p></div></div></div> : null}<table className="w-full text-left text-xs"><thead className="border-b border-black/20 text-[10px] uppercase tracking-wider text-black/45"><tr><th className="px-5 py-3">Scope</th><th className="px-4 py-3">Evidence</th><th className="px-4 py-3">Disposition</th><th className="px-4 py-3">Engine</th><th className="px-4 py-3">Signals & limitations</th></tr></thead><tbody>{evidence.map(item => <tr className="border-b border-black/10 align-top" key={item.id}><td className="px-5 py-3 font-bold uppercase">{item.caseKind}</td><td className="px-4 py-3"><p className="font-bold">{item.kind.replaceAll("_", " ")}</p><p className="mt-1 text-[10px] text-black/50">{item.documentClass} · {new Date(item.createdAt).toLocaleString()}</p></td><td className="px-4 py-3"><Badge className="rounded-none border-0 bg-black/5 text-[10px] font-bold uppercase text-black">{item.disposition.replaceAll("_", " ")}</Badge></td><td className="px-4 py-3"><p>{item.engineName} {item.engineVersion}</p><p className="mt-1 max-w-40 break-all font-mono text-[10px] text-black/50">{item.modelTag ?? "no model"}{item.modelDigest ? ` · ${item.modelDigest.slice(0, 12)}…` : ""}</p></td><td className="max-w-72 px-4 py-3 text-black/60"><p><span className="font-bold text-black">Signals:</span> {item.signals.length ? item.signals.map(signal => typeof signal === "string" ? signal : JSON.stringify(signal)).join("; ") : "No signals recorded"}</p><p className="mt-2"><span className="font-bold text-black">Limits:</span> {item.limitations.length ? item.limitations.map(String).join("; ") : "No limitations recorded"}</p></td></tr>)}</tbody></table></div>;
}

export function ReviewerDecisionHistory({ decisions, loading }: { decisions: Array<{ id: string; caseKind: string; documentClass: string; disposition: string; rationale: string; decidedBy: string; decidedAt: Date }>; loading: boolean }) {
  if (loading) return <div className="px-5 py-8 text-sm text-black/55">Loading reviewer decisions…</div>;
  if (!decisions.length) return <div className="px-5 py-8"><p className="font-bold">No reviewer decisions</p><p className="mt-1 text-sm leading-6 text-black/55">A manual decision is recorded only after a compliance officer reviews a persisted, consent-backed analysis job.</p></div>;
  return <div className="divide-y divide-black/10">{decisions.map(item => <div className="px-5 py-4" key={item.id}><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><Badge className="rounded-none border-0 bg-black text-[10px] font-bold uppercase text-white">{item.disposition.replaceAll("_", " ")}</Badge><span className="text-xs font-bold uppercase">{item.caseKind} · {item.documentClass}</span></div><span className="text-[10px] text-black/50">{new Date(item.decidedAt).toLocaleString()}</span></div><p className="mt-2 text-sm leading-6 text-black/70">{item.rationale}</p><p className="mt-2 text-[10px] font-bold uppercase tracking-wide text-black/45">Reviewer: {item.decidedBy}</p></div>)}</div>;
}

export function ReviewerDecisionForm({ jobs, pending, submit }: { jobs: AnalysisJob[]; pending: boolean; submit: (input: { analysisJobId: string; disposition: "approved" | "rejected" | "needs_information" | "escalated"; rationale: string }) => void }) {
  const [disposition, setDisposition] = useState<"approved" | "rejected" | "needs_information" | "escalated">("needs_information");
  if (!jobs.length) return <div className="px-5 py-8 text-sm leading-6 text-black/55">A reviewer decision requires a persisted, consent-backed analysis job. No action is available until one exists.</div>;
  return <form className="grid gap-4 px-5 py-5" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); submit({ analysisJobId: String(data.get("analysisJobId")), disposition, rationale: String(data.get("rationale")) }); }}><Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Analysis job</span><Select name="analysisJobId" defaultValue={jobs[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{jobs.map(job => <SelectItem key={job.id} value={job.id}>{job.caseKind.toUpperCase()} · {job.documentClass} · {job.id.slice(0, 8)}</SelectItem>)}</SelectContent></Select></Label><Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Manual disposition</span><Select value={disposition} onValueChange={value => setDisposition(value as typeof disposition)}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="needs_information">Needs information</SelectItem><SelectItem value="escalated">Escalated</SelectItem><SelectItem value="approved">Approved by reviewer</SelectItem><SelectItem value="rejected">Rejected by reviewer</SelectItem></SelectContent></Select></Label><Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Attributable rationale</span><Input name="rationale" required minLength={10} maxLength={4000} className="rounded-none border-black/25" placeholder="State the human review basis and evidence limitations" /></Label><Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Recording…" : "Record reviewer decision"}</Button></form>;
}
