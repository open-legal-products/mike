import postcss, { type Declaration, type Root } from "postcss";
import { KIT_DIR, kitTokens, readKitAsset } from "./kit";

export type VisualLintRule =
  | "size"
  | "empty"
  | "script-error"
  | "reserved"
  | "forbidden-element"
  | "external-url"
  | "network-js"
  | "raw-color"
  | "gradient"
  | "raw-font"
  | "raw-shadow"
  | "raw-radius"
  | "token"
  | "emoji"
  | "unknown-cite";

export type VisualLintIssue = {
  rule: VisualLintRule;
  blocking: boolean;
  /** Where it was seen, at most 80 characters. */
  where: string;
  fix: string;
};

type VisualLintContext = { citeIds: ReadonlySet<string> };

type VisualLintReport = { issues: VisualLintIssue[]; omitted: number };

const MAX_VISUAL_BYTES = 300 * 1024;
const MAX_ELEMENTS = 20_000;
const MAX_ISSUES = 12;

const FORBIDDEN_SELECTOR =
  "iframe, frame, object, embed, base, link, meta, form, input[type=password], script[src]";
const URL_ATTRIBUTES = ["src", "href", "srcset", "action", "poster", "xlink:href", "data"];
const SVG_COLOR_ATTRIBUTES = ["fill", "stroke", "stop-color", "color", "flood-color"];
const NETWORK_JS = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|RTCDataChannel|webkitRTCPeerConnection|import\s*\(|new\s+Worker|window\.open|localStorage|sessionStorage|document\.cookie|\.location\s*=|location\.(href|assign|replace)\s*[=(])|(?<![.\w$])location\s*=(?!=)/;
const EMOJI = /\p{Extended_Pictographic}/u;
const GRADIENT = /-gradient\(/i;
const COLOR_FUNCTION = /(?:#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/i;
const INLINE_IMAGE = /^\s*(#|data:image\/(png|jpeg|webp|svg\+xml))/i;
const CSS_INLINE_IMAGE = /url\(\s*["']?(#|data:image\/(png|jpeg|webp|svg\+xml))/i;
const EXTERNAL_SCHEME = /^\s*(https?:|\/\/|ws|javascript:)/i;
const KIT_RADIUS = /^(0|50%|var\(--mv-[a-z0-9-]+\)|(0|50%|var\(--mv-[a-z0-9-]+\))(\s+(0|50%|var\(--mv-[a-z0-9-]+\)))*)$/i;
const NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
   burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
   darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
   darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
   deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
   ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
   lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
   lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
   lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
   mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
   mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab
   orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru
   pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
   seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan
   teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/),
);
const PROPERTIES_WITHOUT_COLORS = new Set([
  "font-family",
  "font",
  "content",
  "grid-template-areas",
  "counter-reset",
  "counter-increment",
  "animation",
  "animation-name",
  "transition",
  "transition-property",
]);

export const FIXES: Record<VisualLintRule, string> = {
  size: "Make the page smaller: draw long lists and charts with MikeVisual.table and MikeVisual.chart rather than writing rows out, and drop repeated markup and custom CSS.",
  empty: "The page shows nothing. Write the content into the html.",
  "script-error": "Fix the script so the page runs without throwing.",
  reserved: "Do not use mv-snapshot; the shell adds that line itself.",
  "forbidden-element": "Remove the element. Visuals are self-contained: no frames, forms, external scripts or head elements.",
  "external-url": "Remove the URL. Nothing can be loaded from the network; inline small data: images or draw with the kit.",
  "network-js": "Remove it. Scripts cannot reach the network, storage or navigate; they only lay out the page.",
  "raw-color": "Use a kit token such as var(--mv-ink-muted) or var(--mv-accent).",
  gradient: "Remove the gradient. Surfaces are flat: var(--mv-surface), var(--mv-slab) or .mv-panel.",
  "raw-font": "Use var(--mv-font-sans) or var(--mv-font-serif).",
  "raw-shadow": "Use a kit shadow: var(--mv-glass-flat-shadow), or none.",
  "raw-radius": "Use var(--mv-radius-sm), -md, -lg, -xl or -full.",
  token: "Only the kit's --mv-* tokens exist; define your own --x- properties and use a kit value.",
  emoji: "Remove the emoji. Use words, or a kit status colour on text.",
  "unknown-cite": "data-cite must be a doc_id from the document list, such as doc-1.",
};

const describe = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
};

let lightValues: Map<string, [number, number, number]> | null = null;

function parseRgb(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function kitLightColors(): Map<string, [number, number, number]> {
  if (!lightValues) {
    lightValues = new Map();
    const css = readKitAsset(`${KIT_DIR}/mike-visual.css`);
    for (const m of css.matchAll(/(--mv-[a-z0-9-]+)\s*:\s*(?:var\(--mv-light,\s*)?([^;)]+)/g)) {
      const rgb = parseRgb(m[2]);
      if (rgb) lightValues.set(m[1], rgb);
    }
  }
  return lightValues;
}

function nearestKitColor(color: string): string | null {
  const rgb = parseRgb(color);
  if (!rgb) return null;
  let best: { token: string; distance: number } | null = null;
  for (const [token, value] of kitLightColors()) {
    const distance = value.reduce((sum, v, i) => sum + (v - rgb[i]) ** 2, 0);
    if (!best || distance < best.distance) best = { token, distance };
  }
  return best?.token ?? null;
}

const withoutVars = (value: string) => value.replace(/var\([^)]*\)/g, "");

function colorLiteral(value: string): string | null {
  if (/color-mix\(/i.test(value) && !COLOR_FUNCTION.test(withoutVars(value))) return null;
  const bare = withoutVars(value);
  const fn = COLOR_FUNCTION.exec(bare);
  if (fn) return fn[0].startsWith("#") ? fn[0] : bare.slice(fn.index, bare.indexOf(")", fn.index) + 1);
  for (const word of bare.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (NAMED_COLORS.has(word)) return word;
  }
  return null;
}

function parseCss(css: string): Root | null {
  try {
    return postcss.parse(css);
  } catch {
    return null;
  }
}

class Collector {
  issues: VisualLintIssue[] = [];
  seen = new Set<string>();
  tokens = kitTokens();

  add(rule: VisualLintRule, where: string, fix = FIXES[rule]) {
    const key = `${rule}:${where}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.issues.push({ rule, blocking: rule === "size" || rule === "empty", where: describe(where), fix });
  }

  rawColor(value: string, where: (literal: string) => string) {
    const literal = colorLiteral(value);
    if (!literal) return;
    const nearest = nearestKitColor(literal);
    this.add("raw-color", where(literal), nearest ? `Use var(${nearest}) instead of ${literal}.` : FIXES["raw-color"]);
  }

  declaration(decl: Declaration, where: string) {
    const prop = decl.prop.toLowerCase();
    const value = decl.value;
    if (prop.startsWith("--mv-")) this.add("token", `${where}: ${prop}`);
    for (const m of value.matchAll(/var\(\s*(--mv-[a-z0-9-]+)/g)) {
      if (!this.tokens.has(m[1])) this.add("token", `${where}: ${m[1]}`, `There is no ${m[1]}. ${FIXES.token}`);
    }
    if (GRADIENT.test(value) || (prop === "background-clip" && /text/i.test(value))) {
      this.add("gradient", `${where}: ${prop}`);
    }
    if (/url\(/i.test(value) && !CSS_INLINE_IMAGE.test(value)) {
      this.add("external-url", `${where}: ${prop}`);
    }
    if (prop === "font-family" || prop === "font") {
      if (!/var\(--mv-font-|^inherit$/i.test(value)) this.add("raw-font", `${where}: ${prop}: ${value}`);
    } else if (!PROPERTIES_WITHOUT_COLORS.has(prop)) {
      this.rawColor(value, (literal) => `${where}: ${prop}: ${literal}`);
    }
    if (/shadow$/.test(prop) && !/^(none|0|var\(--mv-[a-z0-9-]+\))$/i.test(value.trim())) {
      this.add("raw-shadow", `${where}: ${prop}`);
    }
    if (/radius/.test(prop) && !KIT_RADIUS.test(value.trim())) {
      this.add("raw-radius", `${where}: ${prop}`);
    }
  }

  stylesheet(css: string, where: string) {
    const root = parseCss(css);
    if (!root) return;
    root.walkAtRules((rule) => {
      if (rule.name === "import") this.add("external-url", `${where}: @import`);
      if (rule.name === "font-face") this.add("raw-font", `${where}: @font-face`);
    });
    root.walkDecls((decl) => {
      const selector = decl.parent && "selector" in decl.parent ? String(decl.parent.selector) : where;
      this.declaration(decl, selector);
    });
  }

  script(code: string, where: string) {
    const m = NETWORK_JS.exec(code);
    if (m) this.add("network-js", `${where}: ${m[0]}`);
  }
}

const parseFragment = async (html: string) =>
  (await import("linkedom")).parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document;

export async function lintVisual(html: string, ctx: VisualLintContext): Promise<VisualLintReport> {
  const c = new Collector();
  if (Buffer.byteLength(html, "utf8") > MAX_VISUAL_BYTES) {
    c.add("size", `${Math.round(Buffer.byteLength(html, "utf8") / 1024)} KB`);
    return { issues: c.issues, omitted: 0 };
  }
  if (/mv-snapshot/.test(html)) c.add("reserved", "mv-snapshot");
  const document = await parseFragment(html);
  const elements = [...document.body.querySelectorAll("*")];
  if (elements.length > MAX_ELEMENTS) {
    c.add("size", `${elements.length} elements`);
    return { issues: c.issues, omitted: 0 };
  }
  const hasScript = elements.some((el) => el.tagName === "SCRIPT");
  if (!document.body.textContent?.trim() && !document.body.querySelector("svg") && !hasScript) {
    c.add("empty", "no content");
  }
  for (const el of document.body.querySelectorAll(FORBIDDEN_SELECTOR)) {
    c.add("forbidden-element", `<${el.tagName.toLowerCase()}>`);
  }
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (URL_ATTRIBUTES.includes(name) && value.trim() && !INLINE_IMAGE.test(value)) {
        if (tag !== "a" || EXTERNAL_SCHEME.test(value)) c.add("external-url", `<${tag} ${name}="${value}">`);
      }
      if (name.startsWith("on")) c.script(value, `<${tag} ${name}>`);
      if (name === "style") c.stylesheet(`x{${value}}`, `<${tag} style>`);
      if (SVG_COLOR_ATTRIBUTES.includes(name)) c.rawColor(value, (literal) => `<${tag} ${name}="${literal}">`);
      if (name === "data-cite" && !ctx.citeIds.has(value)) c.add("unknown-cite", `data-cite="${value}"`);
      if (EMOJI.test(value)) c.add("emoji", `<${tag} ${name}>`);
    }
    if (tag === "style") c.stylesheet(el.textContent ?? "", "<style>");
    if (tag === "script") c.script(el.textContent ?? "", "<script>");
  }
  const text = document.body.textContent ?? "";
  const emoji = EMOJI.exec(text);
  if (emoji) c.add("emoji", `text: ${emoji[0]}`);
  return { issues: c.issues.slice(0, MAX_ISSUES), omitted: Math.max(0, c.issues.length - MAX_ISSUES) };
}

export function formatLintIssues(report: VisualLintReport): string {
  const lines = report.issues.map((i) => `${i.rule} at ${i.where}: ${i.fix}`);
  if (report.omitted) lines.push(`and ${report.omitted} more`);
  return lines.join("\n");
}

/** Drops what the policy would block anyway, so a forced save stays clean. */
export async function stripUnsafe(html: string, ctx: VisualLintContext): Promise<string> {
  const document = await parseFragment(html.replace(/mv-snapshot/g, "mv-snapshot-x"));
  for (const el of document.body.querySelectorAll(FORBIDDEN_SELECTOR)) el.remove();
  for (const el of document.body.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (URL_ATTRIBUTES.includes(name) && EXTERNAL_SCHEME.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
      if (name === "data-cite" && !ctx.citeIds.has(attr.value)) el.removeAttribute(attr.name);
    }
  }
  return document.body.innerHTML;
}
