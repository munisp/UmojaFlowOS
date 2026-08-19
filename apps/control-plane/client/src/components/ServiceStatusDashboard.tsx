/**
 * Real-time status of the Go, Rust, and Python services.
 *
 * The design constraint that shapes everything here: this panel must never make
 * a service look healthier than it is, and must never display a number the
 * service did not report. Three distinct states are therefore rendered
 * distinctly rather than collapsed into a red/green light:
 *
 *  - **not configured** — the service is intentionally switched off. Rendering
 *    this as a fault would train operators to ignore faults.
 *  - **unreachable** — configured but not answering, always with the reason.
 *  - **healthy** — answering, with the counters it actually returned.
 *
 * The observation time is shown for every reading, so a stale panel is visibly
 * stale rather than quietly wrong.
 */

export type ServiceStatusRow =
  | { service: string; language: string; status: "not_configured"; reason: string }
  | { service: string; language: string; status: "unreachable"; reason: string; latencyMs: number | null }
  | {
      service: string;
      language: string;
      status: "healthy";
      latencyMs: number;
      uptimeSeconds: number;
      observedAt: string;
      counters: Record<string, number>;
      posture: Record<string, string>;
    };

const LANGUAGE_LABEL: Record<string, string> = { go: "Go", rust: "Rust", python: "Python" };

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3_600);
  return `${hours}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function humanCounter(key: string): string {
  return key.replaceAll("_", " ");
}

function StatusMark({ status }: { status: ServiceStatusRow["status"] }) {
  // Colour is paired with a word in every case, so the state is legible without
  // relying on colour perception.
  const tone =
    status === "healthy" ? "bg-black text-white" : status === "unreachable" ? "bg-[#e11919] text-white" : "bg-black/10 text-black";
  const label = status === "healthy" ? "Responding" : status === "unreachable" ? "Not responding" : "Not configured";
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{label}</span>
  );
}

export function ServiceStatusDashboard({
  data,
  loading,
  isFetching,
  error,
  observedAt,
  onRefresh,
}: {
  data: ServiceStatusRow[] | undefined;
  loading: boolean;
  isFetching: boolean;
  error?: string | null;
  observedAt?: string;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="px-5 py-8 text-sm text-black/55" data-testid="service-status-loading">
        Reading service health…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-5 py-8" role="alert" data-testid="service-status-error">
        <p className="text-base font-bold">Service health could not be read</p>
        {/* Distinguishing "the dashboard failed" from "the services are down"
            matters: the responses are entirely different. */}
        <p className="mt-2 max-w-xl text-sm leading-6 text-black/60">{error}</p>
        <p className="mt-2 max-w-xl text-sm leading-6 text-black/55">
          This reports a failure to collect status, not that the services are unhealthy. Their actual state is unknown.
        </p>
      </div>
    );
  }

  const rows = data ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/10 px-5 py-3">
        <p className="text-xs leading-5 text-black/55" data-testid="service-status-observed">
          {observedAt ? `Collected ${new Date(observedAt).toLocaleTimeString()}` : "Not yet collected"}
          {isFetching ? " · refreshing" : ""}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="border border-black/25 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] transition-transform duration-150 active:scale-[0.97]"
          style={{ transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
        >
          Refresh now
        </button>
      </div>

      <div className="grid gap-px bg-black/10 sm:grid-cols-2">
        {rows.map(row => (
          <div key={row.service} className="bg-white px-5 py-4" data-testid={`service-status-${row.service}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">
                  {LANGUAGE_LABEL[row.language] ?? row.language}
                </p>
                <h3 className="text-sm font-black uppercase tracking-[-0.02em]">{row.service}</h3>
              </div>
              <StatusMark status={row.status} />
            </div>

            {row.status === "not_configured" ? (
              <p className="mt-3 text-xs leading-5 text-black/55">{row.reason}</p>
            ) : row.status === "unreachable" ? (
              <p className="mt-3 text-xs leading-5 text-black/70">{row.reason}</p>
            ) : (
              <>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-black/50">Latency</dt>
                  <dd className="text-right font-bold">{row.latencyMs} ms</dd>
                  <dt className="text-black/50">Uptime</dt>
                  <dd className="text-right font-bold">{formatUptime(row.uptimeSeconds)}</dd>
                  {Object.entries(row.counters)
                    .filter(([key]) => key !== "uptime_seconds")
                    .map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-black/50">{humanCounter(key)}</dt>
                        <dd className="text-right font-bold">{value}</dd>
                      </div>
                    ))}
                </dl>
                {Object.entries(row.posture).map(([key, value]) => (
                  <p key={key} className="mt-2 text-[11px] leading-5 text-black/55">
                    {humanCounter(key)}: <span className="font-bold">{value.replaceAll("_", " ")}</span>
                  </p>
                ))}
                <p className="mt-2 text-[11px] text-black/45">
                  Service reported at {new Date(row.observedAt).toLocaleTimeString()}
                </p>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
