import { describe, expect, it } from "vitest";
import { RESPONSE_LANGUAGE_CODES } from "../../../../backend/src/lib/responseLanguages";
import { RESPONSE_STYLE_OPTIONS } from "./mikeApi";

// The selector's languages are listed in the frontend for ordering and
// labels, and validated by the backend. A language offered here that the
// backend does not know would fail to save.
describe("response languages", () => {
    it("offers exactly the languages the backend accepts", () => {
        expect([...RESPONSE_STYLE_OPTIONS.language].sort()).toEqual(
            [...RESPONSE_LANGUAGE_CODES].sort(),
        );
    });

    it("lists Automatic first, then the English variants", () => {
        expect(RESPONSE_STYLE_OPTIONS.language.slice(0, 3)).toEqual([
            "auto",
            "en-US",
            "en-GB",
        ]);
    });
});
