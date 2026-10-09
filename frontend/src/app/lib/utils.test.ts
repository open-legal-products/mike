import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
    it("joins truthy class names and drops falsy ones", () => {
        expect(cn("a", false && "b", undefined, "c")).toBe("a c");
    });

    it("merges conflicting tailwind classes, keeping the last", () => {
        expect(cn("px-2", "px-4")).toBe("px-4");
    });
});
