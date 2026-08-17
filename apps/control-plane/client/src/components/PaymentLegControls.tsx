import { Button } from "@/components/ui/button";
import { FormEvent, useState } from "react";

type LegKind = "collection" | "fx" | "stablecoin_settlement" | "payout" | "reversal";

export function PaymentLegTable({ rows, loading }: { rows: Array<{ id: number; paymentOrderId: number; sequenceNumber: number; legKind: string; status: string; createdAt: Date }>; loading: boolean }) {
  if (loading) return <p className="px-5 py-8 text-sm text-black/55">Loading payment-leg evidence.</p>;
  if (!rows.length) return <p className="px-5 py-8 text-sm text-black/55">No payment leg exists until an authorised operator decomposes a draft order into controlled steps.</p>;
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-black/20 text-[10px] uppercase tracking-wider text-black/45"><tr><th className="px-5 py-3">Order</th><th className="px-4 py-3">Sequence</th><th className="px-4 py-3">Leg</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Created</th></tr></thead><tbody>{rows.map(row => <tr className="border-b border-black/10" key={row.id}><td className="px-5 py-3 font-bold">#{row.paymentOrderId}</td><td className="px-4 py-3">{row.sequenceNumber}</td><td className="px-4 py-3">{row.legKind.replaceAll("_", " ")}</td><td className="px-4 py-3 font-bold uppercase">{row.status}</td><td className="px-4 py-3">{new Date(row.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>;
}

export function PaymentLegForm({ payments, counterparties, submit, pending }: { payments: Array<{ id: number }>; counterparties: Array<{ id: number; legalName: string }>; submit: (input: { paymentOrderId: number; sequenceNumber: number; legKind: LegKind; counterpartyId?: number }) => void; pending: boolean }) {
  const [legKind, setLegKind] = useState<LegKind>("collection");
  if (!payments.length) return <p className="px-5 py-8 text-sm leading-6 text-black/55">A persisted payment order is required before a payment leg can be created.</p>;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const counterpartyId = String(data.get("counterpartyId") ?? "");
    submit({ paymentOrderId: Number(data.get("paymentOrderId")), sequenceNumber: Number(data.get("sequenceNumber")), legKind, counterpartyId: counterpartyId ? Number(counterpartyId) : undefined });
  };
  return <form onSubmit={onSubmit} className="grid gap-4 p-5"><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Payment order</span><select name="paymentOrderId" className="h-9 border border-black/25 bg-white px-3 text-sm">{payments.map(item => <option key={item.id} value={item.id}>Order #{item.id}</option>)}</select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Sequence number</span><input name="sequenceNumber" type="number" min="1" required className="h-9 border border-black/25 bg-white px-3 text-sm" /></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Leg type</span><select value={legKind} onChange={event => setLegKind(event.target.value as LegKind)} className="h-9 border border-black/25 bg-white px-3 text-sm">{["collection", "fx", "stablecoin_settlement", "payout", "reversal"].map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Counterparty (optional)</span><select name="counterpartyId" className="h-9 border border-black/25 bg-white px-3 text-sm"><option value="">No counterparty assigned</option>{counterparties.map(item => <option key={item.id} value={item.id}>{item.legalName}</option>)}</select></label><Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Saving…" : "Create draft payment leg"}</Button></form>;
}
