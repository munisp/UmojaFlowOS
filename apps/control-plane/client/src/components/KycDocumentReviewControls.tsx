import { Button } from "@/components/ui/button";
import { FormEvent, useState } from "react";

type ReviewStatus = "under_review" | "approved" | "rejected" | "expired";

const transitions: Record<string, ReviewStatus[]> = {
  submitted: ["under_review", "expired"],
  under_review: ["approved", "rejected", "expired"],
  approved: ["expired"],
};

function label(value: string) { return value.replaceAll("_", " "); }

export function KycDocumentReviewTable({ rows, loading, canReview, pending, submit }: { rows: Array<{ id: string; customerLegalName: string; documentType: string; originalFilename: string; reviewStatus: string; reviewNote: string | null; reviewedBy: string | null; reviewedAt: Date | null; uploadedAt: Date }>; loading: boolean; canReview: boolean; pending: boolean; submit: (input: { documentId: string; reviewStatus: ReviewStatus; reviewNote: string }) => void }) {
  const [selected, setSelected] = useState<Record<string, ReviewStatus | "">>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const onSubmit = (event: FormEvent<HTMLFormElement>, documentId: string) => {
    event.preventDefault();
    const reviewStatus = selected[documentId];
    const reviewNote = notes[documentId]?.trim() ?? "";
    if (!reviewStatus || reviewNote.length < 4) return;
    submit({ documentId, reviewStatus, reviewNote });
  };
  if (loading) return <p className="px-5 py-8 text-sm text-black/55">Loading canonical PostgreSQL KYC document review records.</p>;
  if (!rows.length) return <p className="px-5 py-8 text-sm leading-6 text-black/55">No KYC document metadata is available for review. This ledger never contains document bytes; it records only storage references, evidence metadata, and attributed manual review state.</p>;
  return <div className="divide-y divide-black/10">{rows.map(row => {
    const allowed = transitions[row.reviewStatus] ?? [];
    return <article className="grid gap-3 px-5 py-4" key={row.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-bold">{row.customerLegalName} · {label(row.documentType)}</p><p className="mt-1 text-xs text-black/55">{row.originalFilename} · uploaded {new Date(row.uploadedAt).toLocaleString()}</p></div><span className="border border-black/25 px-2 py-1 text-[10px] font-black uppercase tracking-wide">{label(row.reviewStatus)}</span></div>{row.reviewNote && <p className="text-xs leading-5 text-black/65">Latest review note: {row.reviewNote}</p>}{row.reviewedAt && <p className="text-xs text-black/50">Reviewed by {row.reviewedBy ?? "unattributed"} · {new Date(row.reviewedAt).toLocaleString()}</p>}{canReview && allowed.length > 0 && <form className="grid gap-2 sm:grid-cols-[180px_1fr_auto]" onSubmit={event => onSubmit(event, row.id)}><select aria-label={`Set review state for ${row.originalFilename}`} value={selected[row.id] ?? ""} onChange={event => setSelected(current => ({ ...current, [row.id]: event.target.value as ReviewStatus }))} className="h-9 border border-black/25 bg-white px-2 text-xs"><option value="">Select transition</option>{allowed.map(status => <option key={status} value={status}>{label(status)}</option>)}</select><input aria-label={`Review note for ${row.originalFilename}`} value={notes[row.id] ?? ""} onChange={event => setNotes(current => ({ ...current, [row.id]: event.target.value }))} minLength={4} required placeholder="Manual review rationale" className="h-9 border border-black/25 bg-white px-3 text-sm" /><Button type="submit" disabled={pending || !(selected[row.id] && (notes[row.id]?.trim().length ?? 0) >= 4)} className="rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{pending ? "Saving…" : "Record"}</Button></form>}</article>;
  })}</div>;
}
