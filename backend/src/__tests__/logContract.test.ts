/**
 * The only prose that leaves the process in a structured log is its scope
 * and message, so both must be literals in the source. This checks every
 * call of the central logger in backend/src, and that nothing reaches
 * Sentry's log and metric APIs except through it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") sources(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

const LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"`;
const SCOPE = String.raw`"[A-Za-z][A-Za-z0-9_/.-]{0,39}"`;
/** What may follow each call's opening parenthesis. */
const ALLOWED: Array<[RegExp, RegExp]> = [
  [/\blog\.(?:info|warn)\(/g, new RegExp(String.raw`^\s*(?:${SCOPE}\s*,\s*${LITERAL}\s*[,)]|tpl\`\[[A-Za-z][A-Za-z0-9_/.-]{0,39}\] )`)],
  [/\b(?:logEvent|forwardLogEvent)\(/g, new RegExp(String.raw`^\s*"(?:info|warn)"\s*,\s*${SCOPE}\s*,\s*${LITERAL}\s*[,)]`)],
  [/\bcountMetric\(/g, /^\s*"[a-z][a-z0-9_.]{0,63}"\s*[,)]/],
];

describe("central logger source contract", () => {
  const files = sources(SRC);

  it("gives every log a literal scope and message, and every metric a literal name", () => {
    const violations: string[] = [];
    let calls = 0;
    for (const file of files) {
      if (file.endsWith("/lib/log.ts")) continue;
      const text = readFileSync(file, "utf8");
      // Another object named `log` (an injected one, say) is not this logger.
      const importsLogger = /import\s*\{[^}]*\blog\b[^}]*\}\s*from\s*"(?:\.{1,2}\/)+(?:[\w-]+\/)*log"/.test(text);
      for (const [call, allowed] of ALLOWED) {
        if (call === ALLOWED[0][0] && !importsLogger) continue;
        for (const match of text.matchAll(call)) {
          calls += 1;
          const after = text.slice(match.index + match[0].length, match.index + match[0].length + 400);
          if (!allowed.test(after)) {
            violations.push(`${relative(SRC, file)}:${text.slice(0, match.index).split("\n").length}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
    // The scan found the calls it is meant to check.
    expect(calls).toBeGreaterThan(50);
  });

  it("reaches Sentry's log and metric APIs only from lib/observability/sentry.ts", () => {
    const direct = files
      .filter((file) => !file.endsWith("/lib/observability/sentry.ts"))
      .filter((file) => /\bSentry\.(?:logger|metrics)\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(direct).toEqual([]);
  });

  it("refuses a message built at run time", () => {
    const [, allowed] = ALLOWED[0];
    expect(allowed.test(`"dbq", "poll failed", error)`)).toBe(true);
    expect(allowed.test("tpl`[dbq] poll ${n} failed`)")).toBe(true);
    expect(allowed.test("`[dbq] ${message}`)")).toBe(false);
    expect(allowed.test(`"dbq", message)`)).toBe(false);
    expect(allowed.test(`scope, "poll failed")`)).toBe(false);
    expect(allowed.test('"dbq", "poll " + name)')).toBe(false);
  });
});
