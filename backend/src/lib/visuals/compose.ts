import { KIT_DIR, readKitAsset, readKitAssetBytes } from "./kit";
import { escapeText, parseStoredVisual, type VisualSource } from "./source";

/**
 * The document policy. default-src 'none' plus inline script and style is
 * everything a composed visual needs, because the kit, the libraries and the
 * fonts are all inlined below; nothing may leave the frame.
 */
export const VISUAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "font-src data:; img-src data: blob:; connect-src 'none'; frame-src 'none'; " +
  "worker-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";

const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, " +
  "U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, " +
  "U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

const fontFace = (family: string, file: string, range: string, weight: string) =>
  `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;` +
  `src:url(data:font/woff2;base64,${readKitAssetBytes(`fonts/${file}`).toString("base64")}) format("woff2");` +
  `unicode-range:${range};}`;

const fontCss = (withLatinExt: boolean) =>
  [
    fontFace("Inter", "inter-latin.woff2", LATIN, "100 900"),
    fontFace("EB Garamond", "eb-garamond-latin.woff2", LATIN, "400 800"),
    ...(withLatinExt
      ? [
          fontFace("Inter", "inter-latin-ext.woff2", LATIN_EXT, "100 900"),
          fontFace("EB Garamond", "eb-garamond-latin-ext.woff2", LATIN_EXT, "400 800"),
        ]
      : []),
  ].join("\n");

// A closing script tag inside inlined code would end the script early.
const inlineScript = (code: string) =>
  `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;

// No CSP directive covers WebRTC, so the page removes it before any other script runs.
const WEBRTC_GUARD = inlineScript(
  `for(const k of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel",` +
    `"RTCSessionDescription","RTCIceCandidate"])` +
    `{try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}}`,
);

// Each authored script gets its own block, so a top-level `const top` or
// `let name` cannot collide with the window's own globals and stop the page.
// The end tag is matched as the browser reads it: `</script` followed by
// whitespace, a slash or `>`, with anything up to the `>` ignored.
const scopeAuthoredScripts = (html: string) =>
  html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script(?:[\s/][^>]*)?>/gi, (tag, attrs: string, code: string) =>
    /\b(src|type)\s*=/i.test(attrs) && !/\btype\s*=\s*["']?(text\/)?javascript\b/i.test(attrs)
      ? tag
      : `<script${attrs}>{\n${code}\n}</script>`,
  );

function formatSnapshotDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
  return `${day} at ${time} UTC`;
}

function listFilenames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function snapshotSentence(src: Pick<VisualSource, "createdAt" | "sources">): string {
  const when = formatSnapshotDate(src.createdAt);
  const files = listFilenames(src.sources.map((s) => s.filename));
  if (!when && !files) return "";
  return `Prepared${when ? ` ${when}` : ""}${files ? ` from ${files}` : ""}.`;
}

/**
 * The complete, self-contained document for a stored visual: policy, fonts,
 * kit, the libraries the fragment uses, and the fragment. The same bytes are
 * shown in the viewer, downloaded, and rendered for export.
 */
export function composeVisualDocument(
  src: VisualSource,
  opts: { mode?: "view" | "export" } = {},
): string {
  const exporting = opts.mode === "export";
  const needsElk = /MikeVisual\.graph\(/.test(src.html);
  const needsEcharts = /MikeVisual\.(chart|echarts)\(/.test(src.html);
  const latinExt = /[Ā-ʺḀ-ỿ†₠-⃀]/.test(src.html);
  const stamp = snapshotSentence(src);
  return [
    "<!doctype html>",
    `<html lang="en" data-theme="light"${exporting ? " data-mv-export" : ""}>`,
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">`,
    WEBRTC_GUARD,
    `<meta http-equiv="x-dns-prefetch-control" content="off">`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeText(src.title)}</title>`,
    `<style>${fontCss(latinExt)}</style>`,
    `<style>${readKitAsset(`${KIT_DIR}/mike-visual.css`)}</style>`,
    ...(needsElk ? [inlineScript(readKitAsset("generated/elk.js"))] : []),
    ...(needsEcharts ? [inlineScript(readKitAsset("generated/echarts.js"))] : []),
    inlineScript(readKitAsset(`${KIT_DIR}/mike-visual.js`)),
    inlineScript(readKitAsset(`${KIT_DIR}/mike-charts.js`)),
    "</head>",
    "<body>",
    scopeAuthoredScripts(src.html),
    ...(stamp ? [`<p id="mv-snapshot">${escapeText(stamp)}</p>`] : []),
    "</body>",
    "</html>",
  ].join("\n");
}

export async function composeStoredVisual(stored: Buffer | ArrayBuffer): Promise<string> {
  return composeVisualDocument(await parseStoredVisual(stored));
}
