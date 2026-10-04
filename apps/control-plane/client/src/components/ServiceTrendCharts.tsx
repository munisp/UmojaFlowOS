import { useMemo, useRef, useState } from "react";

/**
 * Trend charts over recorded service health samples.
 *
 * Two rules govern everything here. First, only recorded samples are drawn: no
 * value is interpolated across a collection gap, because a smooth line through
 * a period when nothing was collected asserts health that was never observed.
 * Second, a service that was unreachable contributes a break in the latency
 * line rather than a zero, since zero milliseconds reads as the fastest
 * possible response when it actually means no response at all.
 *
 * The chart is hand-rolled SVG rather than a charting library: the bundle
 * budget (perf/slo.yaml → mobile.bundle) allows this route 90KB gzip, and a
 * general-purpose charting dependency alone exceeded that. Everything drawn
 * here is derivable from the recorded samples with plain geometry.
 */

export type TrendSample = {
  service: string;
  status: "healthy" | "unreachable" | "not_configured";
  latencyMs: number | null;
  counters: Record<string, number>;
  collectedAt: Date | string;
};

export type AvailabilityRow = {
  service: string;
  language: string;
  samples: number;
  healthySamples: number;
  availability: number | null;
  medianLatencyMs: number | null;
  lastStatus: string;
  lastCollectedAt: Date | string;
};

const SERVICE_LABEL: Record<string, string> = {
  "payment-engine": "Payment engine",
  "risk-compliance-core": "Risk and compliance",
  "reporting-analytics": "Regulatory reporting",
  "ledger-gateway": "Ledger gateway",
};

const SERIES_COLOUR: Record<string, string> = {
  "payment-engine": "#e11919",
  "risk-compliance-core": "#000000",
  "reporting-analytics": "#7a7a7a",
  "ledger-gateway": "#b4241f",
};

export const TREND_WINDOWS = [
  { label: "Last hour", minutes: 60 },
  { label: "Last 6 hours", minutes: 360 },
  { label: "Last 24 hours", minutes: 1440 },
  { label: "Last 7 days", minutes: 10080 },
] as const;

/**
 * Pivots samples into one row per collection time with a column per service.
 *
 * `null` is deliberately preserved for a service that was not healthy at that
 * moment: the renderer breaks the line at null, which is the honest
 * representation.
 */
export function buildLatencySeries(samples: TrendSample[]): Array<Record<string, number | string | null>> {
  const byTime = new Map<number, Record<string, number | string | null>>();
  for (const sample of samples) {
    const time = new Date(sample.collectedAt).getTime();
    const row = byTime.get(time) ?? { time, label: new Date(time).toLocaleTimeString() };
    row[sample.service] = sample.status === "healthy" ? sample.latencyMs : null;
    byTime.set(time, row);
  }
  return Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

/**
 * Converts cumulative counters into per-interval deltas.
 *
 * Services report counters that only ever increase, so plotting them raw shows
 * a line that always rises regardless of activity. A restart resets the
 * counter, which would produce a negative delta; that interval is dropped
 * rather than drawn as negative throughput, which cannot happen.
 */
export function buildThroughputSeries(samples: TrendSample[], counterName: string): Array<Record<string, number | string>> {
  const ordered = [...samples].sort((a, b) => new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime());
  const previous = new Map<string, number>();
  const rows: Array<Record<string, number | string>> = [];
  for (const sample of ordered) {
    if (sample.status !== "healthy") continue;
    const value = sample.counters?.[counterName];
    if (typeof value !== "number") continue;
    const last = previous.get(sample.service);
    previous.set(sample.service, value);
    if (last === undefined) continue;
    const delta = value - last;
    if (delta < 0) continue; // counter reset on restart
    const time = new Date(sample.collectedAt).getTime();
    const existing = rows.find(row => row.time === time);
    if (existing) existing[sample.service] = delta;
    else rows.push({ time, label: new Date(time).toLocaleTimeString(), [sample.service]: delta });
  }
  return rows;
}

function EmptyHistory({ detail }: { detail: string }) {
  return (
    <div className="px-5 py-10 text-sm leading-6 text-black/55" data-testid="trend-empty">
      {detail}
    </div>
  );
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 224;
const PAD = { top: 8, right: 12, bottom: 22, left: 44 };

/**
 * Multi-series latency line chart as plain SVG.
 *
 * Null values split a series into separate paths: the gap stays a gap. A hover
 * guide snaps to the nearest recorded moment and lists each service's value at
 * that moment, or "no response recorded" where the observation was a failure.
 */
function LatencyChart({
  rows,
  services,
}: {
  rows: Array<Record<string, number | string | null>>;
  services: string[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { max, yTicks } = useMemo(() => {
    let peak = 0;
    for (const row of rows) {
      for (const service of services) {
        const value = row[service];
        if (typeof value === "number" && value > peak) peak = value;
      }
    }
    const ceiling = peak <= 0 ? 1 : peak * 1.1;
    const steps = 4;
    const ticks = Array.from({ length: steps + 1 }, (_, i) => Math.round((ceiling / steps) * i));
    return { max: ceiling, yTicks: ticks };
  }, [rows, services]);

  const plotW = CHART_WIDTH - PAD.left - PAD.right;
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (rows.length <= 1 ? plotW / 2 : (index / (rows.length - 1)) * plotW);
  const y = (value: number) => PAD.top + plotH - (value / max) * plotH;

  const segments = useMemo(() => {
    const byService = new Map<string, string[]>();
    for (const service of services) {
      const paths: string[] = [];
      let current: string[] = [];
      rows.forEach((row, index) => {
        const value = row[service];
        if (typeof value === "number") {
          current.push(`${current.length === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`);
        } else if (current.length > 0) {
          // Break the line: a moment with no recorded response is not drawn
          // as any response time at all.
          if (current.length > 1) paths.push(current.join(""));
          current = [];
        }
      });
      if (current.length > 1) paths.push(current.join(""));
      byService.set(service, paths);
    }
    return byService;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, services, max]);

  const labelEvery = Math.max(1, Math.ceil(rows.length / 6));

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || rows.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
    const ratio = rows.length <= 1 ? 0 : (px - PAD.left) / plotW;
    const index = Math.round(ratio * (rows.length - 1));
    setHover(Math.max(0, Math.min(rows.length - 1, index)));
  };

  const hoverRow = hover === null ? null : rows[hover];

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-56 w-full"
        role="img"
        aria-label="Recorded response times per service"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map(tick => (
          <g key={tick}>
            <line x1={PAD.left} x2={CHART_WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} stroke="#00000010" />
            <text x={PAD.left - 6} y={y(tick) + 3} textAnchor="end" fontSize={10} fill="#00000055">
              {tick}
            </text>
          </g>
        ))}
        {rows.map((row, index) =>
          index % labelEvery === 0 ? (
            <text
              key={String(row.time)}
              x={x(index)}
              y={CHART_HEIGHT - 6}
              textAnchor="middle"
              fontSize={10}
              fill="#00000055"
            >
              {String(row.label)}
            </text>
          ) : null,
        )}
        {services.map(service =>
          (segments.get(service) ?? []).map((d, i) => (
            <path key={`${service}-${i}`} d={d} fill="none" stroke={SERIES_COLOUR[service] ?? "#000"} strokeWidth={2} />
          )),
        )}
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={CHART_HEIGHT - PAD.bottom}
            stroke="#00000035"
            strokeDasharray="3 3"
          />
        )}
      </svg>
      {hoverRow && (
        <div
          className="pointer-events-none absolute top-2 right-2 border border-black/20 bg-white px-3 py-2 text-xs shadow-sm"
          data-testid="latency-tooltip"
        >
          <div className="mb-1 font-bold">{String(hoverRow.label)}</div>
          {services.map(service => {
            const value = hoverRow[service];
            return (
              <div key={service} className="flex items-center gap-2">
                <span className="inline-block h-2 w-2" style={{ backgroundColor: SERIES_COLOUR[service] ?? "#000" }} />
                <span>{SERVICE_LABEL[service] ?? service}</span>
                <span className="ml-auto pl-3 font-bold">
                  {typeof value === "number" ? `${value} ms` : "no response recorded"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ServiceTrendCharts({
  samples,
  availability,
  loading,
  windowMinutes,
  onWindowChange,
}: {
  samples: TrendSample[];
  availability: AvailabilityRow[];
  loading: boolean;
  windowMinutes: number;
  onWindowChange: (minutes: number) => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const services = useMemo(() => Array.from(new Set(samples.map(sample => sample.service))).sort(), [samples]);
  const latency = useMemo(() => buildLatencySeries(samples), [samples]);
  const visible = services.filter(service => !hidden.has(service));

  const toggle = (service: string) => {
    setHidden(current => {
      const next = new Set(current);
      if (next.has(service)) next.delete(service);
      else next.add(service);
      return next;
    });
  };

  return (
    <div className="grid gap-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-black/10 px-5 py-3">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Window</span>
        {TREND_WINDOWS.map(option => (
          <button
            key={option.minutes}
            type="button"
            onClick={() => onWindowChange(option.minutes)}
            aria-pressed={windowMinutes === option.minutes}
            className={`px-2.5 py-1 text-xs font-bold uppercase tracking-wide transition-[transform,background-color] duration-150 active:scale-[0.97] ${
              windowMinutes === option.minutes ? "bg-black text-white" : "bg-black/5 text-black hover:bg-black/10"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="px-5 py-10 text-sm text-black/55" data-testid="trend-loading">
          Loading recorded history…
        </div>
      ) : samples.length === 0 ? (
        <EmptyHistory detail="No health observations have been recorded in this window. Trends appear once the scheduled collector has run, or after an administrator records a sample manually. No line is drawn from a single live reading, because one reading is not a trend." />
      ) : (
        <>
          <div className="flex flex-wrap gap-2 px-5 pt-4">
            {services.map(service => (
              <button
                key={service}
                type="button"
                onClick={() => toggle(service)}
                aria-pressed={!hidden.has(service)}
                className={`flex items-center gap-2 border px-2.5 py-1 text-xs font-bold transition-[transform,opacity] duration-150 active:scale-[0.97] ${
                  hidden.has(service) ? "border-black/15 text-black/35" : "border-black/25 text-black"
                }`}
              >
                <span className="inline-block h-2.5 w-2.5" style={{ backgroundColor: SERIES_COLOUR[service] ?? "#000" }} />
                {SERVICE_LABEL[service] ?? service}
              </button>
            ))}
          </div>

          <div className="px-5 py-4">
            <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-black/50">
              Response time, milliseconds
            </div>
            <div data-testid="latency-chart">
              <LatencyChart rows={latency} services={visible} />
            </div>
          </div>

          <div className="border-t border-black/10 px-5 py-4">
            <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-black/50">
              Availability over the selected window
            </div>
            {availability.length === 0 ? (
              <p className="text-sm text-black/55" data-testid="availability-empty">
                No availability can be stated for this window, because no observations were recorded in it.
              </p>
            ) : (
              <table className="w-full border-collapse text-sm" data-testid="availability-table">
                <thead>
                  <tr className="border-b border-black/15 text-left text-[10px] font-black uppercase tracking-[0.14em] text-black/50">
                    <th className="py-2 pr-4">Service</th>
                    <th className="py-2 pr-4">Observations</th>
                    <th className="py-2 pr-4">Responded</th>
                    <th className="py-2 pr-4">Typical response</th>
                    <th className="py-2">Most recent</th>
                  </tr>
                </thead>
                <tbody>
                  {availability.map(row => (
                    <tr key={row.service} className="border-b border-black/10">
                      <td className="py-2 pr-4 font-bold">{SERVICE_LABEL[row.service] ?? row.service}</td>
                      <td className="py-2 pr-4">{row.samples}</td>
                      <td className="py-2 pr-4">
                        {row.availability === null ? (
                          <span className="text-black/45">Not observed</span>
                        ) : (
                          `${(row.availability * 100).toFixed(1)}% (${row.healthySamples}/${row.samples})`
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {row.medianLatencyMs === null ? (
                          <span className="text-black/45">No response recorded</span>
                        ) : (
                          `${Math.round(row.medianLatencyMs)} ms`
                        )}
                      </td>
                      <td className="py-2">
                        <span className={row.lastStatus === "healthy" ? "" : "font-bold text-[#e11919]"}>
                          {row.lastStatus === "healthy" ? "Responding" : row.lastStatus === "unreachable" ? "Not responding" : "Not connected"}
                        </span>
                        <span className="ml-2 text-xs text-black/50">{new Date(row.lastCollectedAt).toLocaleString()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
