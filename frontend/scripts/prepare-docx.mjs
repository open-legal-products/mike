import { readFile, writeFile } from "node:fs/promises";

// @casualoffice/docs 1.4.2 imports this optional format converter. Its
// published ESM loader points beside dist/, but npm ships the WASM in wasm/.
// Correct the asset URL before either bundler resolves the worker graph.
// Keep this narrowly pinned and fail clearly if the upstream package changes.
const root = new URL("../node_modules/@schnsrw/core/", import.meta.url);
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
