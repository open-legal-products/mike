import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// @casualoffice/docs 1.4.2 imports this optional format converter. Its
// published ESM loader points beside dist/, but npm ships the WASM in wasm/.
// Correct the asset URL before either bundler resolves the worker graph.
// Keep this narrowly pinned and fail clearly if the upstream package changes.
// Resolve from Casual Docs rather than assuming a hoisted node_modules layout.
const require = createRequire(import.meta.url);
let root;
try {
    const casualRequire = createRequire(require.resolve("@casualoffice/docs"));
    root = new URL("../", pathToFileURL(casualRequire.resolve("@schnsrw/core/wasm")));
} catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    console.error("DOCX preview dependencies are missing. Run `bun install` or `npm ci` in frontend/, then start the app again.");
    process.exit(1);
}
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (manifest.version !== "0.1.1") {
    throw new Error("Recheck the Casual Docs WASM packaging workaround for @schnsrw/core " + manifest.version);
}
const loader = new URL("dist/s1engine_wasm-7IQLVWNA.js", root);
const source = await readFile(loader, "utf8");
const broken = 'new URL("s1engine_wasm_bg.wasm", import.meta.url)';
const fixed = 'new URL("../wasm/s1engine_wasm_bg.wasm", import.meta.url)';
if (source.includes(broken)) {
    await writeFile(loader, source.replace(broken, fixed));
} else if (!source.includes(fixed)) {
    throw new Error("The Casual Docs WASM loader changed; recheck prepare-docx.mjs.");
}

// SuperDoc's default worker URLs assume hoisted packages. Serve its published
// module workers from our origin, using the documented workerUrls option.
// Resolve through the React wrapper to support npm and Bun's nested layouts.
let engineRoot;
try {
    const reactRequire = createRequire(require.resolve("@superdoc/react"));
    const superdocRequire = createRequire(reactRequire.resolve("superdoc"));
    engineRoot = new URL("./", pathToFileURL(superdocRequire.resolve("@superdoc/docx-engine/package.json")));
} catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    console.error("SuperDoc dependencies are missing. Run `bun install` or `npm ci` in frontend/, then start the app again.");
    process.exit(1);
}
const engineManifest = JSON.parse(await readFile(new URL("package.json", engineRoot), "utf8"));
if (engineManifest.version !== "0.16.0") {
    throw new Error("Recheck the SuperDoc worker assets for @superdoc/docx-engine " + engineManifest.version);
}
const destination = new URL("../public/superdoc/0.16.0/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [sourceName, destinationName] of [
    ["dist/assets/browser-worker-entry-B1QPyQvK.js", "document.js"],
    ["dist/assets/collaboration-worker-entry-B8wOPO6e.js", "collaboration.js"],
    ["dist/assets/review-index-worker-entry-DgbIlazA.js", "review-index.js"],
    ["DOCX-ENGINE-LICENSE.md", "DOCX-ENGINE-LICENSE.md"],
    ["NOTICE.md", "NOTICE.md"],
    ["THIRD_PARTY_NOTICES", "THIRD_PARTY_NOTICES"],
]) {
    await cp(new URL(sourceName, engineRoot), new URL(destinationName, destination), { recursive: true });
}
