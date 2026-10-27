import { afterEach, describe, expect, it, vi } from "vitest";

import { createSecureUuid } from "./secureUuid";

const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createSecureUuid", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("uses crypto.randomUUID when the host provides it", () => {
        const randomUUID = vi.fn(
            () => "11111111-2222-4333-8444-555555555555",
        );
        vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID });

        expect(createSecureUuid()).toBe("11111111-2222-4333-8444-555555555555");
        expect(randomUUID).toHaveBeenCalledTimes(1);
    });

    it("falls back to getRandomValues where randomUUID is missing", () => {
        // Older Office WebViews expose Web Crypto without randomUUID; the
        // shared upload client mints client ids there too.
        const getRandomValues = vi.fn((bytes: Uint8Array) => {
            bytes.fill(0xff);
            return bytes;
        });
        vi.stubGlobal("crypto", { getRandomValues });

        const uuid = createSecureUuid();

        expect(getRandomValues).toHaveBeenCalledTimes(1);
        expect(uuid).toMatch(UUID_V4);
        // Version and variant bits are forced even on all-ones entropy.
        expect(uuid).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    });

    it("produces distinct identifiers on the fallback path", () => {
        let seed = 0;
        vi.stubGlobal("crypto", {
            getRandomValues: (bytes: Uint8Array) => {
                bytes.forEach((_, index) => {
                    bytes[index] = (seed + index) % 256;
                });
                seed += 1;
                return bytes;
            },
        });

        expect(createSecureUuid()).not.toBe(createSecureUuid());
    });
});
