import { describe, expect, it } from "vitest";
import {
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    isPasswordTooLong,
    passwordByteLength,
} from "./passwordPolicy";

// The forms and the API must agree on exactly which passwords are legal,
// or a user passes the form and is refused by the server with no way to
// tell why. The backend counts with Buffer.byteLength; these rows are the
// same boundaries pinned in backend/src/modules/auth/__tests__/auth.test.ts.
describe("password policy", () => {
    it("matches the backend constants", () => {
        expect(MIN_PASSWORD_LENGTH).toBe(10);
        expect(MAX_PASSWORD_LENGTH).toBe(72);
    });

    it.each([
        ["ASCII", "a", 72],
        ["2-byte Latin (é)", "é", 36],
        ["3-byte CJK (密)", "密", 24],
        ["4-byte emoji (😀)", "\u{1F600}", 18],
        ["decomposed accent (e + U+0301)", "é", 24],
    ])("puts the boundary at exactly 72 bytes for %s", (_label, unit, count) => {
        const atLimit = unit.repeat(count);
        expect(passwordByteLength(atLimit)).toBe(72);
        expect(isPasswordTooLong(atLimit)).toBe(false);
        expect(isPasswordTooLong(unit.repeat(count + 1))).toBe(true);
    });

    it("counts bytes, not String.length", () => {
        // Each emoji is 2 UTF-16 units but 4 bytes, so a `.length > 72`
        // check would pass 36 of them (144 bytes), which GoTrue rejects.
        const emoji = "\u{1F600}".repeat(19);
        expect(emoji.length).toBe(38);
        expect(isPasswordTooLong(emoji)).toBe(true);
    });

    it("treats the empty password as not too long", () => {
        expect(passwordByteLength("")).toBe(0);
        expect(isPasswordTooLong("")).toBe(false);
    });
});
