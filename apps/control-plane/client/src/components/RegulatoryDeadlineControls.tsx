import { Button } from "@/components/ui/button";
import { FormEvent, useState } from "react";

type Regulator = "CBN" | "CBK" | "SARB";
type Corridor = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";

export function RegulatoryDeadlineTable({ rows, loading }: { rows: Array<{ id: string; regulator: string; corridor: string; title: string; dueAt: Date; status: string; lastRemindedAt: Date | null }>; loading: boolean }) {
  if (loading) return <p className="px-5 py-8 text-sm text-black/55">Loading regulatory deadline records.</p>;
  if (!rows.length) return <p className="px-5 py-8 text-sm text-black/55">No deadline record exists until a compliance officer enters the source-backed CBN, CBK, or SARB obligation.</p>;
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-black/20 text-[10px] uppercase tracking-wider text-black/45"><tr><th className="px-5 py-3">Regulator</th><th className="px-4 py-3">Corridor</th><th className="px-4 py-3">Obligation</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">State</th></tr></thead><tbody>{rows.map(row => <tr className="border-b border-black/10" key={row.id}><td className="px-5 py-3 font-bold">{row.regulator}</td><td className="px-4 py-3">{row.corridor.replaceAll("_", " ")}</td><td className="px-4 py-3">{row.title}</td><td className="px-4 py-3">{new Date(row.dueAt).toLocaleString()}</td><td className="px-4 py-3 font-bold uppercase">{row.status}</td></tr>)}</tbody></table></div>;
}

export function RegulatoryDeadlineForm({ submit, pending }: { submit: (input: { regulator: Regulator; corridor: Corridor; title: string; dueAt: Date; sourceReference: string }) => void; pending: boolean }) {
  const [regulator, setRegulator] = useState<Regulator>("CBN");
  const [corridor, setCorridor] = useState<Corridor>("NIGERIA_NGN");
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit({ regulator, corridor, title: String(data.get("title")), dueAt: new Date(String(data.get("dueAt"))), sourceReference: String(data.get("sourceReference")) });
  };
  return <form onSubmit={onSubmit} className="grid gap-4 p-5"><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Regulator</span><select value={regulator} onChange={event => setRegulator(event.target.value as Regulator)} className="h-9 border border-black/25 bg-white px-3 text-sm"><option value="CBN">CBN</option><option value="CBK">CBK</option><option value="SARB">SARB</option></select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Corridor</span><select value={corridor} onChange={event => setCorridor(event.target.value as Corridor)} className="h-9 border border-black/25 bg-white px-3 text-sm"><option value="NIGERIA_NGN">Nigeria (NGN)</option><option value="KENYA_KES">Kenya (KES)</option><option value="SOUTH_AFRICA_ZAR">South Africa (ZAR)</option></select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Obligation title</span><input name="title" required minLength={4} className="h-9 border border-black/25 bg-white px-3 text-sm" /></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Due at</span><input name="dueAt" type="datetime-local" required className="h-9 border border-black/25 bg-white px-3 text-sm" /></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Primary source reference URL</span><input name="sourceReference" type="url" required className="h-9 border border-black/25 bg-white px-3 text-sm" /></label><Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Saving…" : "Record regulatory deadline"}</Button></form>;
}
