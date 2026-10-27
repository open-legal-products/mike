import { readFileSync } from "node:fs";
import path from "node:path";

// The same depth from src/lib/visuals and dist/lib/visuals.
export const VISUAL_ASSETS_DIR = path.resolve(__dirname, "../../../assets/visuals");

export const VISUAL_KIT_VERSION = "1";
export const KIT_DIR = `kit/v${VISUAL_KIT_VERSION}`;

export const VISUAL_KINDS = [
  "entity_chart",
  "document_map",
  "defined_terms",
  "timeline",
  "concept",
  "dashboard",
  "chart",
  "other",
] as const;

export type VisualKind = (typeof VISUAL_KINDS)[number];

export function isVisualKind(value: unknown): value is VisualKind {
  return typeof value === "string" && (VISUAL_KINDS as readonly string[]).includes(value);
}

const cache = new Map<string, Buffer>();

export function readKitAssetBytes(rel: string): Buffer {
  const full = path.resolve(VISUAL_ASSETS_DIR, rel);
  if (!full.startsWith(VISUAL_ASSETS_DIR + path.sep)) {
    throw new Error(`visual asset outside the assets directory: ${rel}`);
  }
  let bytes = cache.get(full);
  if (!bytes) {
    bytes = readFileSync(full);
    cache.set(full, bytes);
  }
  return bytes;
}

export function readKitAsset(rel: string): string {
  return readKitAssetBytes(rel).toString("utf8");
}

let tokens: ReadonlySet<string> | null = null;

export function kitTokens(): ReadonlySet<string> {
  if (!tokens) {
    const css = readKitAsset(`${KIT_DIR}/mike-visual.css`);
    tokens = new Set(
      [...css.matchAll(/(--mv-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );
  }
  return tokens;
}

export function readVisualSkill(kind: VisualKind): string {
  return `${readKitAsset("skill/guide.md")}\n\n${readKitAsset(`skill/recipes/${kind}.md`)}`;
}
