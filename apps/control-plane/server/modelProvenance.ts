import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Selector-derived model provenance for a KYC/KYB analysis job.
 *
 * The control plane deliberately does not decide which model analysed a
 * document. It asks the Python document-intelligence service, which reads the
 * live private Ollama inventory, applies the fail-closed selection policy, and
 * verifies the digest against the configured allowlist. This keeps the language
 * boundary intact (Python owns model selection) and makes caller-asserted
 * provenance impossible.
 */
export interface SelectedModelProvenance {
  selectedModelTag: "qwen3-vl:8b" | "deepseek-r1:8b";
  selectedModelDigest: string;
  selectedModelRole: "visual_primary" | "text_fallback";
}

export class ModelProvenanceUnavailableError extends Error {
  constructor(reason: string) {
    super(`selector-derived model provenance is unavailable: ${reason}`);
    this.name = "ModelProvenanceUnavailableError";
  }
}

/** Image inputs use the visual primary; PDFs are handled as text. */
export function modalityForMimeType(mimeType: string): "image" | "text" {
  return mimeType.startsWith("image/") ? "image" : "text";
}

const EXPECTED_ROLE_FOR_TAG: Record<string, string> = {
  "qwen3-vl:8b": "visual_primary",
  "deepseek-r1:8b": "text_fallback",
};

function parseResolverOutput(stdout: string): SelectedModelProvenance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ModelProvenanceUnavailableError("resolver output was not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ModelProvenanceUnavailableError("resolver output was not an object");
  }
  const record = parsed as Record<string, unknown>;
  const tag = record.selectedModelTag;
  const digest = record.selectedModelDigest;
  const role = record.selectedModelRole;

  if (tag !== "qwen3-vl:8b" && tag !== "deepseek-r1:8b") {
    throw new ModelProvenanceUnavailableError("resolver returned an unrecognised model tag");
  }
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new ModelProvenanceUnavailableError("resolver returned a malformed model digest");
  }
  if (role !== "visual_primary" && role !== "text_fallback") {
    throw new ModelProvenanceUnavailableError("resolver returned an unrecognised model role");
  }
  if (EXPECTED_ROLE_FOR_TAG[tag] !== role) {
    throw new ModelProvenanceUnavailableError("resolver returned a tag and role that do not correspond");
  }
  return { selectedModelTag: tag, selectedModelDigest: digest, selectedModelRole: role };
}

/**
 * Resolves provenance by invoking the Python selector. Any failure — an
 * unreachable runtime, a missing model, a drifted digest, or an unconfigured
 * service path — raises, so no analysis job is created without verified
 * provenance.
 */
export async function resolveSelectedModel(mimeType: string): Promise<SelectedModelProvenance> {
  const servicePath = process.env.DOCUMENT_INTELLIGENCE_SRC_PATH;
  if (!servicePath) {
    throw new ModelProvenanceUnavailableError("DOCUMENT_INTELLIGENCE_SRC_PATH is not configured");
  }
  const modality = modalityForMimeType(mimeType);
  try {
    const { stdout } = await run(
      process.env.PYTHON_EXECUTABLE ?? "python3",
      ["-m", "umojaflowos_document_intelligence.resolve_provenance_cli", modality],
      { env: { ...process.env, PYTHONPATH: servicePath }, timeout: 20_000 },
    );
    return parseResolverOutput(stdout);
  } catch (error) {
    if (error instanceof ModelProvenanceUnavailableError) throw error;
    const stderr = (error as { stderr?: string }).stderr ?? "";
    let reason = (error as Error).message;
    try {
      const parsed = JSON.parse(stderr) as { error?: string };
      if (parsed.error) reason = parsed.error;
    } catch {
      if (stderr.trim()) reason = stderr.trim();
    }
    throw new ModelProvenanceUnavailableError(reason);
  }
}
