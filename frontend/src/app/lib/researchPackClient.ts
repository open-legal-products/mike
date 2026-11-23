import { authenticatedFetch } from "./authEvents";

export const MAX_RESEARCH_PACK_BYTES = 4 * 1024 * 1024;
export const SUPPORTED_RESEARCH_PACK_SCHEMA = "counterpedia.research_workspace.portable_pack.v0.2";

export type ResearchPackRevision = Record<string, unknown> & {
    revision: number;
    question?: string;
    saved_at?: string;
};
export type ResearchPack = {
    schema: string;
    selected_revision: number;
    revisions: ResearchPackRevision[];
    export: Record<string, unknown>;
    authenticity: string;
    [key: string]: unknown;
};
export type VerificationReport = {
    integrity: "pass" | "fail";
    input_sha256: string | null;
    failures?: Array<{ code?: string; path?: string }>;
    [key: string]: unknown;
};
export type OpenResearchPack = { file: File; pack: ResearchPack; report: VerificationReport };

function localOriginAllowed(): boolean {
    if (typeof window === "undefined") return false;
    return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
        "",
    );
}

function failureMessage(report: VerificationReport): string {
    const code = report.failures?.[0]?.code ?? "research_workspace.invalid";
    if (
        code === "research_workspace.json_invalid" ||
        code === "research_workspace.duplicate_json_member"
    ) return "Research Pack refused: malformed JSON or duplicate object member.";
    if (
        code === "research_workspace.revision_hash_mismatch" ||
        code === "research_workspace.parent_mismatch" ||
        (code === "schema_invalid" &&
            report.failures?.[0]?.path?.endsWith("/parent_portable_revision_sha256"))
    ) return "Research Pack refused: historical revision integrity or parent chain mismatch.";
    if (
        code === "research_workspace.export_hash_mismatch" ||
        code === "research_workspace.export_head_mismatch"
    ) return "Research Pack refused: export envelope integrity mismatch.";
    if (code === "schema_invalid" && report.failures?.[0]?.path === "/schema") {
        return "Unsupported Research Pack schema. This client accepts v0.2 only.";
    }
    if (code.includes("too_large")) return "Research Pack is larger than the 4 MiB limit.";
    return `Research Pack refused: ${code}${
        report.failures?.[0]?.path ? ` at ${report.failures[0].path}` : ""
    }.`;
}

export async function verifyResearchPackFile(file: File): Promise<OpenResearchPack> {
    if (!localOriginAllowed()) {
        throw new Error(
            "Research Pack opening is available only from the local authenticated client.",
        );
    }
    if (file.size > MAX_RESEARCH_PACK_BYTES) {
        throw new Error("Research Pack is larger than the 4 MiB limit.");
    }
    let buffer: ArrayBuffer;
    try {
        buffer = await file.arrayBuffer();
    } catch {
        throw new Error("The selected file could not be read.");
    }
    if (buffer.byteLength > MAX_RESEARCH_PACK_BYTES) {
        throw new Error("Research Pack is larger than the 4 MiB limit.");
    }
    let response: Response;
    try {
        response = await authenticatedFetch("/api/research-pack/verify", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: buffer,
        });
    } catch {
        throw new Error(
            "Research Pack verification is unavailable. Check the local authenticated session.",
        );
    }
    if (response.status === 401) {
        throw new Error("Research Pack verification requires an authenticated Mike session.");
    }
    if (response.status === 429) throw new Error("The local verifier is busy. Try the file again.");
    if (response.status >= 500) {
        throw new Error(
            "Research Pack verification is temporarily unavailable. Try again on the local client.",
        );
    }
    if (!response.ok && response.status !== 422) {
        throw new Error(`Research Pack verification refused (HTTP ${response.status}).`);
    }
    let report: VerificationReport;
    try {
        report = await response.json() as VerificationReport;
    } catch {
        throw new Error(`Research Pack verification failed (${response.status}).`);
    }
    if (report.input_sha256 !== await sha256(buffer)) {
        throw new Error("The verifier response did not match the selected file bytes.");
    }
    if (!response.ok || report.integrity !== "pass") throw new Error(failureMessage(report));
    let pack: ResearchPack;
    try {
        pack = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as ResearchPack;
    } catch {
        throw new Error("The verified file could not be decoded for display.");
    }
    if (pack.schema !== SUPPORTED_RESEARCH_PACK_SCHEMA) {
        throw new Error("Unsupported Research Pack schema. This client accepts v0.2 only.");
    }
    return { file, pack, report };
}
