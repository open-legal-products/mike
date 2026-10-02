import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "./fileHash";

describe("sha256Hex", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("hashes the file bytes like the backend (lower-case hex)", async () => {
        const file = new Blob(["abc"]);
        expect(await sha256Hex(file)).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });

    it("returns null where Web Crypto is unavailable (insecure origin)", async () => {
        vi.stubGlobal("crypto", {});
        expect(await sha256Hex(new Blob(["abc"]))).toBeNull();
    });

    it("returns null when the file cannot be read", async () => {
        const broken = {
            arrayBuffer: vi.fn().mockRejectedValue(new Error("gone")),
        } as unknown as Blob;
        expect(await sha256Hex(broken)).toBeNull();
    });
});
