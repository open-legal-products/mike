import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KIT_DIR, VISUAL_ASSETS_DIR, readKitAsset } from "../../../../lib/visuals/kit";
import { lintVisual } from "../../../../lib/visuals/lint";
import { visualsSystemPrompt } from "../tools/visualTools";

const skillDir = path.join(VISUAL_ASSETS_DIR, "skill");
const skillFiles = [
  path.join(skillDir, "guide.md"),
  ...readdirSync(path.join(skillDir, "recipes")).map((f) => path.join(skillDir, "recipes", f)),
];
const skillText = skillFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const kitSource = readKitAsset(`${KIT_DIR}/mike-visual.js`) + readKitAsset(`${KIT_DIR}/mike-charts.js`);
const kitCss = readKitAsset(`${KIT_DIR}/mike-visual.css`);

describe("the visuals skill", () => {
  it("names only helpers and classes the kit has, and keeps the always-on prompt short", () => {
    const helpers = new Set([...skillText.matchAll(/MikeVisual\.([a-zA-Z]+)/g)].map((m) => m[1]));
    const missingHelpers = [...helpers].filter((name) => !new RegExp(`\\b${name}\\b`).test(kitSource));
    expect(missingHelpers).toEqual([]);

    const classes = new Set([...skillText.matchAll(/\bmv-[a-z0-9-]+/g)].map((m) => m[0]).filter((c) => !c.startsWith("mv-data-")));
    const missingClasses = [...classes].filter((name) => !kitCss.includes(name) && !kitSource.includes(name));
    expect(missingClasses).toEqual([]);

    expect(visualsSystemPrompt(true).length).toBeLessThanOrEqual(3600);
  });

  it("gives examples the lint accepts", async () => {
    const citeIds = new Set(["doc-1", "doc-2", "doc-3", "active"]);
    for (const file of skillFiles) {
      for (const block of readFileSync(file, "utf8").matchAll(/```html\n([\s\S]*?)```/g)) {
        const report = await lintVisual(block[1], { citeIds });
        expect(report.issues, `${path.basename(file)}: ${JSON.stringify(report.issues)}`).toEqual([]);
      }
    }
  });
});
