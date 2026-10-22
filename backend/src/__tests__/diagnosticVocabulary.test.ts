// The outbound privacy boundary keeps a tag only when its value is in the
// closed vocabulary (sentryPrivacy.ts). A call site that invents a value
// (`stage: "edit-resolution-conflict"` before it was listed) still compiles,
// still runs, and arrives in Sentry as "Failure in storage" with the one
// detail that mattered removed. This test reads every such literal in the
// backend source and fails on the first one the boundary would drop, so the
// vocabulary and the call sites cannot drift apart silently.

import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_VOCABULARY } from "../lib/observability/sentryPrivacy";

const SRC = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC)
  .map((f) => relative(SRC, f).split(sep).join("/"))
  .filter((f) => !/(^|\/)__tests__\//.test(f) && !/\.test\.ts$/.test(f));

const read = (file: string) => readFileSync(join(SRC, file), "utf8");

/** `tag: "value"` literals, per tag, with the file they appear in. */
function tagLiterals(tag: string): Array<{ file: string; value: string }> {
  const pattern = new RegExp(`\\b${tag}:\\s*"([^"\\n]+)"`, "g");
  const out: Array<{ file: string; value: string }> = [];
  for (const file of FILES) {
    const source = read(file);
    for (const match of source.matchAll(pattern)) out.push({ file, value: match[1]! });
  }
  return out;
}

describe("diagnostic tag vocabulary", () => {
  it.each(["component", "stage", "job_kind", "operation", "error_kind", "what", "storage_operation"])(
    "every `%s:` literal in the backend is a value the privacy boundary keeps",
    (tag) => {
      const vocabulary = DIAGNOSTIC_VOCABULARY[tag === "what" ? "stage" : tag]!;
      const unknown = tagLiterals(tag).filter(({ value }) => !vocabulary.has(value));
      expect(unknown, `add these to ${tag === "what" ? "stage" : tag} in sentryPrivacy.ts (both copies)`).toEqual([]);
    },
  );

  it("every best-effort delete names a stage the boundary keeps", () => {
    const unknown: Array<{ file: string; value: string }> = [];
    for (const file of FILES) {
      for (const match of read(file).matchAll(/deleteFiles?BestEffort\([^)]*?,\s*"([^"\n]+)"\s*\)/g)) {
        if (!DIAGNOSTIC_VOCABULARY.stage!.has(match[1]!)) unknown.push({ file, value: match[1]! });
      }
    }
    expect(unknown).toEqual([]);
  });

  it("every registered job kind is a value the boundary keeps", () => {
    const registry = read("jobs/registry.ts");
    const kinds = [...registry.matchAll(/"([a-z_]+\.[a-z_]+)"\s*:/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(5);
    expect(kinds.filter((k) => !DIAGNOSTIC_VOCABULARY.job_kind!.has(k))).toEqual([]);
  });
});
