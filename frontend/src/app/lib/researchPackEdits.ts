import type { OpenResearchPack, ResearchPackRevision } from "@/app/lib/researchPackClient";

export const MIKE_EDIT_PACKAGE_SCHEMA = "mike.research_pack_edit.v0.1";
export const MAX_MIKE_EDIT_PACKAGE_BYTES = 16 * 1024 * 1024;
const DATABASE_NAME = "mike-research-pack-edits-v1";
const STORE_NAME = "packages";

export type EditableResearchRevision = {
    findingText: string;
    assessments: Array<{
        propositionId: string;
        observationId: string;
        stance: string;
        note: string;
    }>;
    contextReviews: Array<{ contextId: string; decision: string; note: string }>;
};

export type MikeEditRevision = {
    revision: number;
    parent_sha256: string;
    saved_at: string;
    edits: EditableResearchRevision;
    content_sha256: string;
};

export type MikeEditPackage = {
    schema: typeof MIKE_EDIT_PACKAGE_SCHEMA;
    package_id: string;
    created_at: string;
    base_pack: {
        filename: string;
        schema: string;
        sha256: string;
        contents_base64: string;
        selected_revision: number;
    };
    base_revision_sha256: string;
    local_revisions: MikeEditRevision[];
    selected_edit_revision: number;
    authenticity: "not_established";
    package_sha256: string;
};

export type StoredMikeEditPackage = {
    key: string;
    account_id: string;
    value: MikeEditPackage;
};

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function canonical(value: unknown): string {
    return JSON.stringify(value);
}

async function sha256(value: ArrayBuffer | string): Promise<string> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("Saved Mike edit refused: the original pack bytes are malformed.");
    }
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function editableFields(revision: ResearchPackRevision): EditableResearchRevision {
    const finding = record(revision.finding);
    const assessments = Array.isArray(revision.assessments) ? revision.assessments : [];
    const contexts = Array.isArray(revision.research_context) ? revision.research_context : [];
    return {
        findingText: stringValue(finding.text),
        assessments: assessments.map((item) => {
            const assessment = record(item);
            return {
                propositionId: stringValue(assessment.proposition_id),
                observationId: stringValue(assessment.observation_id),
                stance: stringValue(assessment.stance),
                note: stringValue(assessment.note),
            };
        }),
        contextReviews: contexts.map((item) => {
            const context = record(item);
            const review = record(context.review);
            return {
                contextId: stringValue(context.context_id),
                decision: stringValue(review.decision),
                note: stringValue(review.note),
            };
        }),
    };
}

export function withEditableFields(
    revision: ResearchPackRevision,
    edits: EditableResearchRevision,
): ResearchPackRevision {
    const finding = record(revision.finding);
    const assessmentEdits = new Map(
        edits.assessments.map((item) => [`${item.propositionId}\u0000${item.observationId}`, item]),
    );
    const reviewEdits = new Map(edits.contextReviews.map((item) => [item.contextId, item]));
    const assessments = (Array.isArray(revision.assessments) ? revision.assessments : []).map((item) => {
        const assessment = record(item);
        const edit = assessmentEdits.get(
            `${stringValue(assessment.proposition_id)}\u0000${stringValue(assessment.observation_id)}`,
        );
        return edit ? { ...assessment, stance: edit.stance, note: edit.note } : item;
    });
    const contexts = (Array.isArray(revision.research_context) ? revision.research_context : []).map((item) => {
        const context = record(item);
        const edit = reviewEdits.get(stringValue(context.context_id));
        return edit
            ? { ...context, review: { ...record(context.review), decision: edit.decision, note: edit.note } }
            : item;
    });
    return {
        ...revision,
        finding: { ...finding, text: edits.findingText },
        assessments,
        research_context: contexts,
    };
}

type PackageCore = Omit<MikeEditPackage, "package_sha256">;

async function packageDigest(core: PackageCore): Promise<string> {
    return sha256(canonical(core));
}

export async function appendMikeEditRevision(
    opened: OpenResearchPack,
    selectedRevision: number,
    edits: EditableResearchRevision,
    existing: MikeEditPackage | null,
): Promise<MikeEditPackage> {
    const baseRevision = opened.pack.revisions.find((item) => item.revision === selectedRevision);
    if (!baseRevision) throw new Error("The selected source revision is missing.");
    const sourceBytes = await opened.file.arrayBuffer();
    const sourceDigest = await sha256(sourceBytes);
    const baseRevisionDigest = await sha256(canonical(baseRevision));
    if (existing && (
        existing.base_pack.sha256 !== sourceDigest ||
        existing.base_pack.selected_revision !== selectedRevision
    )) {
        throw new Error("The saved edit belongs to a different source pack or revision.");
    }

    const previous = existing?.local_revisions.at(-1);
    const snapshot = JSON.parse(canonical(edits)) as EditableResearchRevision;
    const revisionNumber = (previous?.revision ?? 0) + 1;
    const savedAt = new Date().toISOString();
    const parentDigest = previous?.content_sha256 ?? baseRevisionDigest;
    const contentDigest = await sha256(canonical(snapshot));
    const localRevision: MikeEditRevision = {
        revision: revisionNumber,
        parent_sha256: parentDigest,
        saved_at: savedAt,
        edits: snapshot,
        content_sha256: contentDigest,
    };
    const core: PackageCore = existing
        ? {
            ...existing,
            local_revisions: [...existing.local_revisions, localRevision],
            selected_edit_revision: revisionNumber,
        }
        : {
            schema: MIKE_EDIT_PACKAGE_SCHEMA,
            package_id: crypto.randomUUID(),
            created_at: savedAt,
            base_pack: {
                filename: opened.file.name,
                schema: opened.pack.schema,
                sha256: sourceDigest,
                contents_base64: bytesToBase64(new Uint8Array(sourceBytes)),
                selected_revision: selectedRevision,
            },
            base_revision_sha256: baseRevisionDigest,
            local_revisions: [localRevision],
            selected_edit_revision: revisionNumber,
            authenticity: "not_established",
        };
    const digestInput = { ...core } as PackageCore & { package_sha256?: string };
    delete digestInput.package_sha256;
    const result = { ...digestInput, package_sha256: await packageDigest(digestInput) };
    if (new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`).byteLength > MAX_MIKE_EDIT_PACKAGE_BYTES) {
        throw new Error("Mike edit history is larger than the 16 MiB package limit.");
    }
    return result;
}

export async function verifyMikeEditPackage(value: unknown): Promise<MikeEditPackage> {
    const candidate = record(value) as unknown as MikeEditPackage;
    if (
        candidate.schema !== MIKE_EDIT_PACKAGE_SCHEMA ||
        typeof candidate.package_id !== "string" ||
        !candidate.package_id ||
        !candidate.base_pack ||
        typeof candidate.base_pack.contents_base64 !== "string" ||
        typeof candidate.base_pack.sha256 !== "string" ||
        !Number.isInteger(candidate.base_pack.selected_revision)
    ) {
        throw new Error("Saved Mike edit refused: unsupported or incomplete package.");
    }
    const { package_sha256, ...core } = candidate;
    if (!package_sha256 || await packageDigest(core) !== package_sha256) {
        throw new Error("Saved Mike edit refused: package integrity mismatch.");
    }
    const baseBytes = base64ToBytes(candidate.base_pack.contents_base64);
    if (await sha256(baseBytes.slice().buffer) !== candidate.base_pack.sha256) {
        throw new Error("Saved Mike edit refused: original pack digest mismatch.");
    }
    if (!Array.isArray(candidate.local_revisions) || candidate.local_revisions.length === 0) {
        throw new Error("Saved Mike edit refused: no saved revision was found.");
    }
    let parent = candidate.base_revision_sha256;
    for (let index = 0; index < candidate.local_revisions.length; index += 1) {
        const revision = candidate.local_revisions[index];
        if (
            revision.revision !== index + 1 ||
            revision.parent_sha256 !== parent ||
            !revision.edits ||
            !Array.isArray(revision.edits.assessments) ||
            !Array.isArray(revision.edits.contextReviews) ||
            await sha256(canonical(revision.edits)) !== revision.content_sha256
        ) {
            throw new Error("Saved Mike edit refused: revision history integrity mismatch.");
        }
        parent = revision.content_sha256;
    }
    if (candidate.selected_edit_revision !== candidate.local_revisions.at(-1)?.revision) {
        throw new Error("Saved Mike edit refused: selected local revision is inconsistent.");
    }
    return candidate;
}

export async function verifyMikeEditPackageFile(file: File): Promise<MikeEditPackage> {
    if (file.size > MAX_MIKE_EDIT_PACKAGE_BYTES) {
        throw new Error("Mike edit package is larger than the 16 MiB limit.");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(await file.text()) as unknown;
    } catch {
        throw new Error("Mike edit package refused: malformed JSON.");
    }
    return verifyMikeEditPackage(parsed);
}

export async function verifyMikeEditPackageSource(
    value: MikeEditPackage,
    opened: OpenResearchPack,
): Promise<void> {
    const sourceBytes = await opened.file.arrayBuffer();
    if (await sha256(sourceBytes) !== value.base_pack.sha256) {
        throw new Error("Saved Mike edit refused: source pack digest does not match.");
    }
    const revision = opened.pack.revisions.find(
        (item) => item.revision === value.base_pack.selected_revision,
    );
    if (!revision || await sha256(canonical(revision)) !== value.base_revision_sha256) {
        throw new Error("Saved Mike edit refused: source revision binding does not match.");
    }
}

export function mikeEditBaseFile(value: MikeEditPackage): File {
    const bytes = base64ToBytes(value.base_pack.contents_base64);
    return new File([bytes.slice().buffer], value.base_pack.filename || "research-pack.json", {
        type: "application/json",
    });
}

export function exportMikeEditPackage(value: MikeEditPackage): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
        return Promise.reject(new Error("Local edit storage is unavailable in this browser."));
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
                store.createIndex("account_id", "account_id", { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("Could not open local edit storage."));
        request.onblocked = () => reject(new Error("Local edit storage is busy in another tab."));
    });
}

export async function listMikeEditPackages(accountId: string): Promise<StoredMikeEditPackage[]> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).index("account_id").getAll(accountId);
        request.onsuccess = () => resolve(request.result as StoredMikeEditPackage[]);
        request.onerror = () => reject(new Error("Could not list saved local edits."));
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
            database.close();
            reject(new Error("Could not read saved local edits."));
        };
    });
}

export async function storeMikeEditPackage(
    accountId: string,
    value: MikeEditPackage,
): Promise<void> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({
            key: `${accountId}:${value.package_id}`,
            account_id: accountId,
            value,
        } satisfies StoredMikeEditPackage);
        transaction.oncomplete = () => {
            database.close();
            resolve();
        };
        transaction.onerror = () => {
            database.close();
            reject(new Error("Could not save the local edit."));
        };
        transaction.onabort = () => {
            database.close();
            reject(new Error("Local edit save was interrupted."));
        };
    });
}

export async function deleteMikeEditPackage(accountId: string, packageId: string): Promise<void> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(`${accountId}:${packageId}`);
        transaction.oncomplete = () => {
            database.close();
            resolve();
        };
        transaction.onerror = () => {
            database.close();
            reject(new Error("Could not delete the local edit."));
        };
        transaction.onabort = () => {
            database.close();
            reject(new Error("Local edit deletion was interrupted."));
        };
    });
}
