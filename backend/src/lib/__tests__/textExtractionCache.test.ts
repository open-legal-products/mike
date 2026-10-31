import { expect, it, vi } from "vitest";
import { createTextExtractionCache } from "../textExtractionCache";
it("coalesces concurrent reads by revision, but never caches failed work", async () => {
    const cache = createTextExtractionCache();
    const load = vi.fn(async () => "text");
    expect(await Promise.all([cache("v:r1", load), cache("v:r1", load)])).toEqual(["text", "text"]);
    expect(load).toHaveBeenCalledTimes(1);
    await cache("v:r2", load); expect(load).toHaveBeenCalledTimes(2);
    const fail = vi.fn(async () => { throw new Error("offline"); });
    await expect(cache("failed", fail)).rejects.toThrow();
    await expect(cache("failed", fail)).rejects.toThrow(); expect(fail).toHaveBeenCalledTimes(2);
});
it("bounds retained text by character budget and entry count", async () => {
    const cache = createTextExtractionCache(5, 2);
    const load = vi.fn(async () => "four");
    await cache("a", load); await cache("b", load); await cache("a", load);
    expect(load).toHaveBeenCalledTimes(3);
    const entries = createTextExtractionCache(100, 1);
    await entries("a", load); await entries("b", load); await entries("a", load);
    expect(load).toHaveBeenCalledTimes(6);
});
