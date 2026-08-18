import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ModelProvenanceUnavailableError,
  modalityForMimeType,
  resolveSelectedModel,
} from "./modelProvenance";

const routerSource = readFileSync(resolve(process.cwd(), "server/routers.ts"), "utf8");

describe("selector-derived model provenance", () => {
  it("maps image inputs to the visual modality and documents to text", () => {
    expect(modalityForMimeType("image/jpeg")).toBe("image");
    expect(modalityForMimeType("image/tiff")).toBe("image");
    expect(modalityForMimeType("application/pdf")).toBe("text");
  });

  it("fails closed when the document-intelligence service path is not configured", async () => {
    const previous = process.env.DOCUMENT_INTELLIGENCE_SRC_PATH;
    delete process.env.DOCUMENT_INTELLIGENCE_SRC_PATH;
    try {
      await expect(resolveSelectedModel("image/png")).rejects.toBeInstanceOf(ModelProvenanceUnavailableError);
    } finally {
      if (previous !== undefined) process.env.DOCUMENT_INTELLIGENCE_SRC_PATH = previous;
    }
  });

  it("fails closed when the resolver cannot reach a private runtime", async () => {
    const previousPath = process.env.DOCUMENT_INTELLIGENCE_SRC_PATH;
    const previousUrl = process.env.OLLAMA_BASE_URL;
    process.env.DOCUMENT_INTELLIGENCE_SRC_PATH = resolve(
      process.cwd(),
      "../UmojaFlowOS/services/document-intelligence/src",
    );
    delete process.env.OLLAMA_BASE_URL;
    try {
      await expect(resolveSelectedModel("image/png")).rejects.toBeInstanceOf(ModelProvenanceUnavailableError);
    } finally {
      if (previousPath !== undefined) process.env.DOCUMENT_INTELLIGENCE_SRC_PATH = previousPath;
      else delete process.env.DOCUMENT_INTELLIGENCE_SRC_PATH;
      if (previousUrl !== undefined) process.env.OLLAMA_BASE_URL = previousUrl;
    }
  });

  it("does not accept caller-supplied model provenance on the analysis-job procedure", () => {
    const procedureStart = routerSource.indexOf("createDocumentAnalysisJob:");
    expect(procedureStart).toBeGreaterThan(-1);
    const procedure = routerSource.slice(procedureStart, procedureStart + 1200);

    // The input schema must not expose provenance fields to the caller.
    expect(procedure).not.toContain("selectedModelTag: z.");
    expect(procedure).not.toContain("selectedModelDigest: z.");
    expect(procedure).not.toContain("selectedModelRole: z.");

    // Provenance must instead be resolved server-side before persistence.
    expect(procedure).toContain("resolveSelectedModel(input.mimeType)");
  });

  it("persists provenance only from the resolver result", () => {
    const procedureStart = routerSource.indexOf("createDocumentAnalysisJob:");
    const procedure = routerSource.slice(procedureStart, procedureStart + 1200);
    // The spread order matters: resolver output must be applied last so it can
    // never be overridden by request input.
    expect(procedure).toMatch(/\{ \.\.\.input, \.\.\.provenance \}/);
  });
});
