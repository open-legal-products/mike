import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

// DesignTokensUI.css is the one place the web app and the Word add-in get
// their core design tokens from. It replaced a hand-copied add-in tokens.css
// guarded only by a "keep values in sync" comment, which drifted. These
// tests pin the structure that makes drift impossible: both entry
// stylesheets import the shared file, and neither redeclares one of its
// tokens (a local redeclaration would silently shadow the shared value).

const repoRoot = resolve(process.cwd(), "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const SHARED = "frontend/src/shared/ui/DesignTokensUI.css";
const WEB_ENTRY = "frontend/src/app/globals.css";
const ADDIN_ENTRY = "word-addin/src/taskpane/styles.css";
const ADDIN_BASE = "word-addin/src/shared/styles/tokens.css";

/** Every `--custom-property` declared anywhere in the stylesheet. */
function customProperties(css: string): Set<string> {
    const names = new Set<string>();
    postcss.parse(css).walkDecls(/^--/, (decl) => {
        names.add(decl.prop);
    });
    return names;
}

/** `@import` targets, in source order. */
function imports(css: string): string[] {
    const targets: string[] = [];
    postcss.parse(css).walkAtRules("import", (rule) => {
        targets.push(rule.params.replace(/^["']|["']$/g, ""));
    });
    return targets;
}

const sharedTokens = customProperties(read(SHARED));

describe("DesignTokensUI.css", () => {
    it("declares the theme mapping and both palettes", () => {
        const scopes = new Set<string>();
        postcss.parse(read(SHARED)).walkDecls(/^--/, (decl) => {
            const parent = decl.parent;
            if (parent?.type === "rule") scopes.add((parent as postcss.Rule).selector);
            if (parent?.type === "atrule") {
                const at = parent as postcss.AtRule;
                scopes.add(`@${at.name} ${at.params}`);
            }
        });
        expect([...scopes].sort()).toEqual([".dark", ":root", "@theme inline"]);
        // A parse that finds nothing would make every check below vacuous.
        expect(sharedTokens.size).toBeGreaterThan(50);
        expect(sharedTokens).toContain("--app-background");
        expect(sharedTokens).toContain("--color-app-surface");
    });

    it.each([
        [WEB_ENTRY, "../shared/ui/DesignTokensUI.css"],
        [ADDIN_ENTRY, "../../../frontend/src/shared/ui/DesignTokensUI.css"],
    ])("%s imports the shared tokens right after tailwindcss setup", (entry, target) => {
        const list = imports(read(entry));
        expect(list).toContain(target);
        expect(list.indexOf(target)).toBeGreaterThan(list.indexOf("tailwindcss"));
    });

    it("the add-in imports the shared tokens before its base layer", () => {
        const list = imports(read(ADDIN_ENTRY));
        expect(list.indexOf("../../../frontend/src/shared/ui/DesignTokensUI.css"))
            .toBeLessThan(list.indexOf("../shared/styles/tokens.css"));
    });

    it.each([WEB_ENTRY, ADDIN_ENTRY, ADDIN_BASE])(
        "%s does not redeclare a shared token",
        (file) => {
            const shadowed = [...customProperties(read(file))].filter((name) =>
                sharedTokens.has(name),
            );
            expect(shadowed).toEqual([]);
        },
    );
});
