import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormEvent, useState } from "react";
import { SubmitFeedback, useSubmitFeedback } from "@/components/SubmitFeedback";

/**
 * Administrator interface for supplying provider credentials and activating an
 * adapter.
 *
 * The interface is deliberately shaped around one idea: the operator supplies
 * the *name* of a deployment secret, not the secret. A field that accepted the
 * credential itself would place it in browser memory, in the request body, and
 * probably in a log, so it is not offered at all — and the server refuses
 * credential-shaped values regardless.
 */

export type CredentialRow = {
  id: string;
  counterpartyLegalName: string;
  category: string;
  environment: string;
  endpoint: string;
  state: string;
  credentialConfigured: boolean;
  secretReference: string | null;
  lastHealthCheckedAt: Date | string | null;
  lastHealthResult: { reachable?: boolean; httpStatus?: number | null; detail?: string; observedAt?: string } | null;
};

export function canConfigureCredentials(role: string | undefined): boolean {
  return role === "admin";
}

function stateTone(state: string): string {
  if (state === "active") return "bg-black text-white";
  if (state === "failed" || state === "suspended") return "bg-[#e11919] text-white";
  return "bg-black/5 text-black";
}

export function IntegrationCredentialForm({
  connections,
  pending,
  submit,
  error,
}: {
  connections: CredentialRow[];
  pending: boolean;
  submit: (input: { integrationConnectionId: string; secretReference: string; endpointUrl: string }) => void;
  error?: string | null;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [secretReference, setSecretReference] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const feedback = useSubmitFeedback(pending, error);

  // A live connection must be suspended before its credential can change, so
  // offering it here would produce a guaranteed server refusal.
  const configurable = connections.filter(row => row.state !== "active");

  if (configurable.length === 0) {
    return (
      <div className="px-5 py-8 text-sm leading-6 text-black/55" data-testid="credential-form-empty">
        No integration connection is awaiting credential configuration. Register a provider connection first, or suspend an
        active connection to re-point it at a different credential.
      </div>
    );
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit({ integrationConnectionId: connectionId, secretReference: secretReference.trim(), endpointUrl: endpointUrl.trim() });
  };

  return (
    <form className="grid gap-4 px-5 py-5" onSubmit={onSubmit} aria-label="Configure provider credential">
      <label className="grid gap-1.5">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Integration connection</span>
        <Select value={connectionId} onValueChange={setConnectionId}>
          <SelectTrigger className="rounded-none border-black/25" aria-label="Integration connection">
            <SelectValue placeholder="Select a registered connection" />
          </SelectTrigger>
          <SelectContent>
            {configurable.map(row => (
              <SelectItem key={row.id} value={row.id}>
                {row.counterpartyLegalName} · {row.category} · {row.environment}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="grid gap-1.5">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Deployment secret name</span>
        <Input
          className="rounded-none border-black/25"
          value={secretReference}
          onChange={event => setSecretReference(event.target.value)}
          placeholder="PROVIDER_FX_API_KEY"
          aria-label="Deployment secret name"
          aria-describedby="secret-reference-help"
        />
        <span id="secret-reference-help" className="text-xs leading-5 text-black/55">
          Enter the <strong>name</strong> of the deployment secret holding this provider&rsquo;s credential, not the credential
          itself. The credential is read from protected deployment configuration at the moment of the health check and is never
          stored in the database, transmitted to this browser, or written to an audit record.
        </span>
      </label>

      <label className="grid gap-1.5">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Provider health endpoint</span>
        <Input
          className="rounded-none border-black/25"
          value={endpointUrl}
          onChange={event => setEndpointUrl(event.target.value)}
          placeholder="https://provider.example.com/v1/health"
          aria-label="Provider health endpoint"
          aria-describedby="endpoint-help"
        />
        <span id="endpoint-help" className="text-xs leading-5 text-black/55">
          Must be an HTTPS URL with no embedded credentials. This exact endpoint is contacted during activation.
        </span>
      </label>

      <SubmitFeedback state={feedback} />

      <div>
        <Button
          type="submit"
          className="rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black"
          disabled={pending || !connectionId || !secretReference.trim() || !endpointUrl.trim()}
        >
          {pending ? "Recording credential reference…" : "Record credential reference"}
        </Button>
      </div>
    </form>
  );
}

export function IntegrationCredentialTable({
  rows,
  loading,
  canManage,
  activatePending,
  suspendPending,
  activate,
  suspend,
  activatingId,
}: {
  rows: CredentialRow[];
  loading: boolean;
  canManage: boolean;
  activatePending: boolean;
  suspendPending: boolean;
  activate: (input: { integrationConnectionId: string }) => void;
  suspend: (input: { integrationConnectionId: string; reason: string }) => void;
  activatingId?: string | null;
}) {
  if (loading) {
    return (
      <div className="px-5 py-8 text-sm text-black/55" data-testid="credential-table-loading">
        Loading integration credential state…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="px-5 py-8 text-sm leading-6 text-black/55" data-testid="credential-table-empty">
        No provider connection is registered. Registering a connection records documentation and environment only; it does not
        activate any provider.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/20 text-left text-[10px] font-black uppercase tracking-[0.14em] text-black/50">
            <th className="px-5 py-3">Provider</th>
            <th className="px-5 py-3">Credential</th>
            <th className="px-5 py-3">State</th>
            <th className="px-5 py-3">Last health check</th>
            <th className="px-5 py-3">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} className="border-b border-black/10 align-top">
              <td className="px-5 py-3">
                <div className="font-bold">{row.counterpartyLegalName}</div>
                <div className="text-xs text-black/55">
                  {row.category} · {row.environment}
                </div>
                <div className="mt-1 break-all text-xs text-black/45">{row.endpoint}</div>
              </td>
              <td className="px-5 py-3">
                {row.credentialConfigured ? (
                  <span className="text-xs font-bold">{row.secretReference}</span>
                ) : (
                  <span className="text-xs text-black/55">Not configured</span>
                )}
              </td>
              <td className="px-5 py-3">
                <span
                  className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${stateTone(row.state)}`}
                >
                  {row.state.replaceAll("_", " ")}
                </span>
              </td>
              <td className="px-5 py-3 text-xs leading-5 text-black/60">
                {row.lastHealthCheckedAt ? (
                  <>
                    <div>{new Date(row.lastHealthCheckedAt).toLocaleString()}</div>
                    {/* The provider's own words, shown verbatim rather than
                        summarised into a colour. */}
                    {row.lastHealthResult?.detail ? <div className="mt-1">{row.lastHealthResult.detail}</div> : null}
                  </>
                ) : (
                  <span className="text-black/45">Never checked</span>
                )}
              </td>
              <td className="px-5 py-3">
                {!canManage ? (
                  <span className="text-xs text-black/45">Administrator only</span>
                ) : row.state === "active" ? (
                  <Button
                    variant="outline"
                    className="rounded-none border-black/25 text-xs font-black uppercase"
                    disabled={suspendPending}
                    onClick={() =>
                      suspend({ integrationConnectionId: row.id, reason: "operator suspended from the console" })
                    }
                  >
                    {suspendPending ? "Suspending…" : "Suspend"}
                  </Button>
                ) : row.credentialConfigured ? (
                  <Button
                    className="rounded-none bg-black text-xs font-black uppercase text-white hover:bg-[#e11919]"
                    disabled={activatePending}
                    onClick={() => activate({ integrationConnectionId: row.id })}
                  >
                    {activatePending && activatingId === row.id ? "Contacting provider…" : "Run health check"}
                  </Button>
                ) : (
                  <span className="text-xs text-black/45">Configure a credential first</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
