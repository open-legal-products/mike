import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

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
