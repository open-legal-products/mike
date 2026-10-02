import { expect, it } from "vitest";
import { docxRevisionElements } from "./docxRevisionElements";

it("matches EigenPal revision IDs across runs without selecting another revision", () => {
    const root = document.createElement("div");
    root.innerHTML = `
        <span data-revision-kind="insert" data-revision-id="8">first</span>
        <span data-revision-kind="insert" data-revision-id="8">second</span>
        <span data-revision-kind="insert" data-revision-id="18">unrelated</span>
        <span data-revision-kind="delete" data-revision-id="7">old</span>`;
    expect(docxRevisionElements(root, "ins", "8").map((element) => element.textContent)).toEqual(["first", "second"]);
    expect(docxRevisionElements(root, "ins", "7")).toEqual([]);
    expect(docxRevisionElements(root, "del", "7").map((element) => element.textContent)).toEqual(["old"]);
});


it("does not substitute a visible revision with identical text for an unpainted ID", () => {
    const root = document.createElement("div");
    root.innerHTML = '<span data-revision-kind="insert" data-revision-id="18">sixty</span>';
    expect(docxRevisionElements(root, "ins", "8", "sixty")).toEqual([]);
    expect(docxRevisionElements(root, "ins", undefined, "sixty")).toHaveLength(1);
});
