// Bundles the browser libraries the visual shell inlines: a custom ECharts
// build (only the chart types the kit uses, SVG renderer) and elkjs. Output
// goes to assets/visuals/generated/, which is not committed.
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "assets", "visuals");
const out = path.join(assets, "generated");

async function newerThan(target, ...sources) {
  try {
    const targetTime = (await stat(target)).mtimeMs;
    for (const source of sources) {
      if ((await stat(source)).mtimeMs > targetTime) return false;
    }
    return true;
  } catch {
    return false;
  }
}

await mkdir(out, { recursive: true });

const entry = path.join(assets, "echarts-entry.js");
const echartsOut = path.join(out, "echarts.js");
const echartsPackage = require.resolve("echarts/package.json");
if (!(await newerThan(echartsOut, entry, echartsPackage))) {
  const notice = await readFile(path.join(path.dirname(echartsPackage), "NOTICE"), "utf8");
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2020"],
    legalComments: "eof",
    banner: {
      js:
        "/*! Apache ECharts | Licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0)\n" +
        notice.trim() +
        " */",
    },
    outfile: echartsOut,
    logLevel: "warning",
  });
}

const elkSource = require.resolve("elkjs/lib/elk.bundled.js");
const elkOut = path.join(out, "elk.js");
if (!(await newerThan(elkOut, elkSource))) await copyFile(elkSource, elkOut);
