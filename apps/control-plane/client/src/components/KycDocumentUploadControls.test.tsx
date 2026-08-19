import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { KycDocumentUploadForm } from "./KycDocumentUploadControls";

/**
 * The upload path is where document bytes could most easily end up somewhere they
 * must not be. These regressions prove the console refuses unsupported and
 * oversized evidence before any intent is created, and that on the accepted path
 * the bytes go to object storage while only metadata and a checksum are handed to
 * the control plane.
 */

const CUSTOMERS = [{ id: "5c1d8e2f-7a3b-4c6d-9e0f-1a2b3c4d5e6f", legalName: "Corridor Importer Ltd", kycStatus: "in_review" }];

// jsdom ships no SubtleCrypto, so the browser's real digest implementation is
// supplied from Node. The component's own hashing code is exercised unchanged;
// only the platform primitive it calls is provided.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  }
});

function fileOf(name: string, type: string, bytes: number) {
  const contents = new Uint8Array(bytes);
  const file = new File([contents], name, { type });
  // jsdom's Blob.arrayBuffer resolves to an object SubtleCrypto refuses. The
  // real bytes are supplied so the component's own hashing code runs unchanged
  // and produces a digest over exactly this content.
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => contents.buffer.slice(0),
    configurable: true,
  });
  return file;
}

/**
 * Files must be attached through user-event: jsdom's `files` setter accepts only
 * a genuine FileList, and a hand-rolled stand-in is silently read by FormData as
 * an empty File, which would make these tests pass for the wrong reason.
 */
async function selectFile(file: File, { applyAccept = true }: { applyAccept?: boolean } = {}) {
  const input = document.querySelector('input[name="document"]') as HTMLInputElement;
  // user-event honours the `accept` attribute, which is the correct browser
  // behaviour but prevents testing the component's own MIME guard. Temporarily
  // clearing the attribute simulates the cases the attribute cannot catch: a
  // mislabelled file, a drag-and-drop, or a caller that bypasses the picker.
  const accept = input.getAttribute("accept");
  if (!applyAccept) input.removeAttribute("accept");
  await userEvent.upload(input, file);
  if (!applyAccept && accept) input.setAttribute("accept", accept);
  return input;
}

/** Records the intent payload the console builds, so it can be asserted field by field. */
function recordingCreateIntent(uploadUrl: string) {
  const seen: Array<Record<string, unknown>> = [];
  const fn = async (input: unknown) => {
    seen.push(input as Record<string, unknown>);
    return { id: uploadUrl.split("/").pop() as string, uploadUrl };
  };
  return { fn, seen };
}

describe("KYC document upload workflow", () => {
  afterEach(() => cleanup());

  it("offers no upload affordance when no canonical customer exists", () => {
    render(
      <KycDocumentUploadForm customers={[]} createIntent={vi.fn()} finalize={vi.fn()} onComplete={vi.fn()} />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/can only be accepted for a customer already on record/i)).toBeTruthy();
  });

  it("states plainly that PostgreSQL never receives document bytes", () => {
    render(
      <KycDocumentUploadForm customers={CUSTOMERS} createIntent={vi.fn()} finalize={vi.fn()} onComplete={vi.fn()} />,
    );
    expect(screen.getByText(/never document bytes/i)).toBeTruthy();
  });

  it("rejects an unsupported file type before creating any upload intent", async () => {
    const createIntent = vi.fn();
    render(
      <KycDocumentUploadForm customers={CUSTOMERS} createIntent={createIntent} finalize={vi.fn()} onComplete={vi.fn()} />,
    );

    await selectFile(fileOf("evidence.exe", "application/x-msdownload", 1_024), { applyAccept: false });
    fireEvent.submit(screen.getByRole("button", { name: /Store document evidence/i }).closest("form")!);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Only PDF, JPEG, PNG, WEBP, and TIFF/i));
    expect(createIntent).not.toHaveBeenCalled();
  });

  it("rejects an empty file rather than recording a zero-byte document", async () => {
    const createIntent = vi.fn();
    render(
      <KycDocumentUploadForm customers={CUSTOMERS} createIntent={createIntent} finalize={vi.fn()} onComplete={vi.fn()} />,
    );

    await selectFile(fileOf("empty.pdf", "application/pdf", 0));
    fireEvent.submit(screen.getByRole("button", { name: /Store document evidence/i }).closest("form")!);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/non-empty authorised document/i));
    expect(createIntent).not.toHaveBeenCalled();
  });

  it("rejects a file beyond the 25 MiB limit before hashing or uploading it", async () => {
    const createIntent = vi.fn();
    render(
      <KycDocumentUploadForm customers={CUSTOMERS} createIntent={createIntent} finalize={vi.fn()} onComplete={vi.fn()} />,
    );

    // Size is asserted via the property rather than by allocating 25 MiB.
    const oversized = fileOf("large.pdf", "application/pdf", 1_024);
    Object.defineProperty(oversized, "size", { value: 26_214_401 });
    await selectFile(oversized);
    fireEvent.submit(screen.getByRole("button", { name: /Store document evidence/i }).closest("form")!);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/exceeds the 25 MiB/i));
    expect(createIntent).not.toHaveBeenCalled();
  });

  it("sends only metadata and a checksum to the control plane, and the bytes to storage", async () => {
    const createIntent = recordingCreateIntent("https://storage.example/put/intent-1");
    const finalize = vi.fn(async () => ({}));
    const onComplete = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }) as never);

    render(
      <KycDocumentUploadForm
        customers={CUSTOMERS}
        createIntent={createIntent.fn}
        finalize={finalize}
        onComplete={onComplete}
      />,
    );

    await selectFile(fileOf("passport.pdf", "application/pdf", 2_048));
    fireEvent.submit(screen.getByRole("button", { name: /Store document evidence/i }).closest("form")!);

    await waitFor(() => expect(finalize).toHaveBeenCalledWith({ uploadIntentId: "intent-1" }));

    const intentPayload = createIntent.seen[0];
    expect(intentPayload.originalFilename).toBe("passport.pdf");
    expect(intentPayload.mimeType).toBe("application/pdf");
    expect(intentPayload.sizeBytes).toBe(2_048);
    // A full SHA-256, computed in the browser, is what the control plane receives.
    expect(String(intentPayload.contentSha256)).toMatch(/^[0-9a-f]{64}$/);
    // And no field carries the content itself.
    expect(Object.keys(intentPayload)).not.toContain("content");
    expect(JSON.stringify(intentPayload)).not.toContain("base64");

    // The bytes went to the presigned storage URL, not to the control plane.
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://storage.example/put/intent-1",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(onComplete).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("surfaces a failed storage upload as an error and does not finalise the intent", async () => {
    const finalize = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("denied", { status: 403 }) as never);

    render(
      <KycDocumentUploadForm
        customers={CUSTOMERS}
        createIntent={vi.fn(async () => ({ id: "intent-2", uploadUrl: "https://storage.example/put/intent-2" }))}
        finalize={finalize}
        onComplete={vi.fn()}
      />,
    );

    await selectFile(fileOf("passport.pdf", "application/pdf", 1_024));
    fireEvent.submit(screen.getByRole("button", { name: /Store document evidence/i }).closest("form")!);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/upload failed \(403\)/i));
    expect(finalize).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
