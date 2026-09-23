import { expect, it } from "vitest";
import { docxRevisionElements } from "./docxRevisionElements";

it("matches SuperDoc's imported revision ID across runs without selecting its replacement partner", () => {
    const root = document.createElement("div");
    root.innerHTML = `
        <span data-track-change-kind="insert" data-track-change-ids="imported:8,group,7,imported:7">first</span>
        <span data-track-change-kind="insert" data-track-change-ids="imported:8,group,7,imported:7">second</span>
        <span data-track-change-kind="insert" data-track-change-ids="imported:18,group">unrelated</span>
        <span data-track-change-kind="delete" data-track-change-ids="imported:7,group,8,imported:8">old</span>`;
    expect(docxRevisionElements(root, "ins", "8").map((element) => element.textContent)).toEqual(["first", "second"]);
    expect(docxRevisionElements(root, "ins", "7")).toEqual([]);
    expect(docxRevisionElements(root, "del", "7").map((element) => element.textContent)).toEqual(["old"]);
});
