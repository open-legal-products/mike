import { describe, it, expect, vi } from "vitest";
import request from "supertest";

function mockSupabase() {
    const result = { data: null, error: null };
    const q: Record<string, unknown> = {};
    const chain = [
        "select", "insert", "update", "delete", "upsert",
        "eq", "neq", "in", "is", "or", "not", "lt", "order", "limit",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => Promise.resolve(result));
    q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
    return {
        from: vi.fn(() => q),
        rpc: vi.fn(() => Promise.resolve(result)),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Stub the storage IO functions so a request that clears validation never
// touches R2/S3, while keeping the rest of the storage module (key builders,
// disposition helpers) real. The validation tests below reject before storage
// is reached, but this guards against accidental real IO regardless.
vi.mock("../../lib/storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/storage")>();
    return {
        ...actual,
        uploadFile: vi.fn(async () => {}),
        downloadFile: vi.fn(async () => null),
        deleteFile: vi.fn(async () => {}),
    };
});

import { app } from "../../app";

describe("legacy multipart upload endpoints", () => {
    it("rejects multipart bytes before parsing the body", async () => {
        const res = await request(app)
            .post("/single-documents")
            .set("Authorization", "Bearer test")
            .attach("file", Buffer.from("hello world"), {
                filename: "notes.txt",
                contentType: "text/plain",
            });

        expect(res.status).toBe(410);
        expect(res.body).toEqual({
            code: "upload_session_required",
            detail: "This upload endpoint has been replaced by /upload-sessions.",
        });
    });

    it.each([
        ["post", "/library/file/documents"],
        ["post", "/projects/11111111-1111-4111-8111-111111111111/documents"],
        ["post", "/single-documents/11111111-1111-4111-8111-111111111111/versions"],
        ["put", "/single-documents/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/file"],
        ["post", "/workflows/11111111-1111-4111-8111-111111111111/reference-files"],
        ["put", "/workflows/11111111-1111-4111-8111-111111111111/reference-files/22222222-2222-4222-8222-222222222222"],
    ] as const)("returns 410 for %s %s", async (method, path) => {
        const res = await request(app)[method](path)
            .set("Authorization", "Bearer test")
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.alloc(1024));

        expect(res.status).toBe(410);
        expect(res.body.code).toBe("upload_session_required");
    });
});

describe("POST /single-documents/download-zip — bounds", () => {
    it("returns 400 when document_ids is empty", async () => {
        const res = await request(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test")
            .send({ document_ids: [] });

        expect(res.status).toBe(400);
        expect(res.body.detail).toMatch(/document_ids or folder_ids is required/i);
    });

    it("returns 404 when none of the requested documents are accessible", async () => {
        // The documents lookup resolves to no rows (stubbed DB), so the
        // access filter leaves nothing to zip.
        const res = await request(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test")
            .send({ document_ids: ["d-other-user"] });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("No documents found");
    });

    it("accepts folder-only downloads without requiring loaded document ids", async () => {
        const res = await request(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test")
            .send({ folder_ids: ["folder-not-accessible"] });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("No documents found");
    });
});
