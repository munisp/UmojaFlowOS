import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormEvent, useState } from "react";

type Corridor = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";

export function RateLockTable({ rows, loading }: { rows: Array<{ id: number; corridor: string; baseAsset: string; quoteAsset: string; lockedRate: string; expiresAt: Date; status: string }>; loading: boolean }) {
  if (loading) return <p className="px-5 py-8 text-sm text-black/55">Loading source-derived rate locks.</p>;
  if (!rows.length) return <p className="px-5 py-8 text-sm text-black/55">No rate lock exists until an operator selects a persisted source observation and a future expiry.</p>;
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-black/20 text-[10px] uppercase tracking-wider text-black/45"><tr><th className="px-5 py-3">Pair</th><th className="px-4 py-3">Corridor</th><th className="px-4 py-3">Locked rate</th><th className="px-4 py-3">Expires</th><th className="px-4 py-3">State</th></tr></thead><tbody>{rows.map(row => <tr className="border-b border-black/10" key={row.id}><td className="px-5 py-3 font-bold">{row.baseAsset} / {row.quoteAsset}</td><td className="px-4 py-3">{row.corridor.replaceAll("_", " ")}</td><td className="px-4 py-3">{row.lockedRate}</td><td className="px-4 py-3">{new Date(row.expiresAt).toLocaleString()}</td><td className="px-4 py-3 font-bold uppercase">{row.status.replaceAll("_", " ")}</td></tr>)}</tbody></table></div>;
}

export function RateLockForm({ observations, payments, submit, pending }: { observations: Array<{ id: number; baseAsset: string; quoteAsset: string; rate: string; observedAt: Date }>; payments: Array<{ id: number }>; submit: (input: { marketObservationId: number; paymentOrderId?: number; corridor: Corridor; expiresAt: Date }) => void; pending: boolean }) {
  const [corridor, setCorridor] = useState<Corridor>("NIGERIA_NGN");
  if (!observations.length) return <p className="px-5 py-8 text-sm leading-6 text-black/55">A persisted source observation is required before a rate lock can be created.</p>;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const paymentOrderId = String(data.get("paymentOrderId") ?? "");
    submit({ marketObservationId: Number(data.get("marketObservationId")), paymentOrderId: paymentOrderId ? Number(paymentOrderId) : undefined, corridor, expiresAt: new Date(String(data.get("expiresAt"))) });
  };
  return <form onSubmit={onSubmit} className="grid gap-4 p-5"><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Source observation</span><select name="marketObservationId" className="h-9 border border-black/25 bg-white px-3 text-sm">{observations.map(item => <option key={item.id} value={item.id}>{item.baseAsset}/{item.quoteAsset} · {item.rate} · {new Date(item.observedAt).toLocaleString()}</option>)}</select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Payment order (optional)</span><select name="paymentOrderId" className="h-9 border border-black/25 bg-white px-3 text-sm"><option value="">No payment order</option>{payments.map(item => <option key={item.id} value={item.id}>Order #{item.id}</option>)}</select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Corridor</span><select value={corridor} onChange={event => setCorridor(event.target.value as Corridor)} className="h-9 border border-black/25 bg-white px-3 text-sm"><option value="NIGERIA_NGN">Nigeria (NGN)</option><option value="KENYA_KES">Kenya (KES)</option><option value="SOUTH_AFRICA_ZAR">South Africa (ZAR)</option></select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Lock expires at</span><Input name="expiresAt" type="datetime-local" required className="rounded-none" /></label><Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Saving…" : "Create source-derived rate lock"}</Button></form>;
}
