#!/usr/bin/env node
/**
 * Summarises citation-eval runs: one Markdown table per grouping.
 *
 *   node scripts/citation-eval/summarize.mjs block.jsonl cite_sources.jsonl inline.jsonl
 */
import { readFileSync } from "node:fs";

const rows = process.argv
  .slice(2)
  .flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
if (rows.length === 0) {
  console.error("Pass one or more .jsonl files.");
  process.exit(1);
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "–");
const num = (x, digits = 0) => (x === null || x === undefined ? "–" : x.toFixed(digits));
const sec = (ms) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)}s`);

/** Markers that open a line, list item or clause instead of following text. */
function markerAsText(text) {
  return [
    ...(text ?? "").matchAll(
      /(?:^|\n)[ \t]*(?:[-*]|\d+\.)?[ \t]*(?:\*\*[^*\n]+\*\*:?)?[ \t]*\[\d+\](?=[ \t]*(?:$|\n|[a-z]))/g,
    ),
  ].length;
}

function metrics(group) {
  const ok = group.filter((r) => r.outcome !== "failed");
  const withMarkers = ok.filter((r) => r.markers > 0);
  const quotes = sum(ok.map((r) => r.quotes));
  return {
    runs: group.length,
    failed: group.length - ok.length,
    // The reported bug: markers shown, nothing behind them.
    noCitations: `${withMarkers.filter((r) => r.markers_without_any_citation).length}/${withMarkers.length}`,
    danglingAnswers: pct(withMarkers.filter((r) => r.dangling_markers > 0).length, withMarkers.length),
    danglingMarkers: `${sum(ok.map((r) => r.dangling_markers))}/${sum(ok.map((r) => r.markers))}`,
    citationsPerAnswer: num(mean(ok.map((r) => r.citations)), 1),
    notInSource: pct(sum(ok.map((r) => r.quotes_not_in_source)), quotes),
    wrongPage: pct(sum(ok.map((r) => r.quotes_wrong_page)), quotes),
    unverifiedByApp: pct(sum(ok.map((r) => r.quotes_unverified_by_app)), quotes),
    coverage: pct(sum(ok.map((r) => r.expected_sources_cited)), sum(ok.map((r) => r.expected_sources))),
    leaks: sum(ok.map((r) => (r.transport_leak ? 1 : 0))),
    firstText: sec(median(ok.map((r) => r.ms_to_first_content))),
    total: sec(median(ok.map((r) => r.ms_total))),
    inTok: num(mean(ok.map((r) => r.usage?.input_tokens))),
    cacheRead: num(mean(ok.map((r) => r.usage?.cache_read_tokens))),
    outTok: num(mean(ok.map((r) => r.usage?.output_tokens))),
    citeCalls: num(mean(ok.map((r) => r.cite_calls)), 1),
    // A marker standing where words should be: "1. [2]" or "give [1] is
    // required" — the evidence went into the citation, not the sentence.
    markerAsText: `${sum(ok.map((r) => markerAsText(r.visible_text)))}/${sum(ok.map((r) => r.markers))}`,
  };
}

const COLUMNS = [
  ["runs", "Runs"],
  ["failed", "Failed"],
  ["noCitations", "Markers but no citations"],
  ["danglingAnswers", "Answers with a dangling marker"],
  ["danglingMarkers", "Dangling / all markers"],
  ["citationsPerAnswer", "Citations per answer"],
  ["notInSource", "Quotes not in source"],
  ["wrongPage", "Quotes on wrong page"],
  ["unverifiedByApp", "Quotes the app marked unverified"],
  ["coverage", "Expected sources cited"],
  ["leaks", "Raw citation syntax shown"],
  ["firstText", "Median time to first text"],
  ["total", "Median total time"],
  ["inTok", "Mean input tokens"],
  ["cacheRead", "Mean cache-read tokens"],
  ["outTok", "Mean output tokens"],
  ["citeCalls", "cite_sources calls"],
  ["markerAsText", "Markers standing in for text (heuristic)"],
];

function table(title, keyOf, filter = () => true) {
  const groups = new Map();
  for (const r of rows.filter(filter)) {
    const key = keyOf(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const keys = [...groups.keys()].sort();
  const computed = keys.map((k) => metrics(groups.get(k)));
  console.log(`\n### ${title}\n`);
  console.log(`| Metric | ${keys.join(" | ")} |`);
  console.log(`| --- | ${keys.map(() => "---").join(" | ")} |`);
  for (const [field, label] of COLUMNS) {
    console.log(`| ${label} | ${computed.map((m) => m[field]).join(" | ")} |`);
  }
}

/**
 * Total time against a baseline format, task by task and model by model.
 * A median pooled over every task mostly reflects which tasks land in the
 * middle of the pool (here a few Haiku key-terms and cross-doc runs), so
 * compare each format with the baseline on the same task and model.
 */
function pairedTimes(title, baseline, filter) {
  const ok = rows.filter((r) => filter(r) && r.outcome !== "failed");
  const arms = [...new Set(ok.map((r) => r.arm))].sort();
  if (!arms.includes(baseline)) return;
  const others = arms.filter((a) => a !== baseline);
  const cells = [...new Set(ok.map((r) => `${r.task}\t${r.model}`))].sort();
  const timeOf = (arm, cell) =>
    median(ok.filter((r) => r.arm === arm && `${r.task}\t${r.model}` === cell).map((r) => r.ms_total));
  const ratios = Object.fromEntries(others.map((a) => [a, []]));
  console.log(`\n### ${title}\n`);
  console.log(`| Task | Model | ${arms.join(" | ")} | ${others.map((a) => `${a} ÷ ${baseline}`).join(" | ")} |`);
  console.log(`| --- | --- | ${arms.map(() => "---").join(" | ")} | ${others.map(() => "---").join(" | ")} |`);
  for (const cell of cells) {
    const base = timeOf(baseline, cell);
    const shown = others.map((a) => {
      const t = timeOf(a, cell);
      if (t === null || !base) return "–";
      ratios[a].push(t / base);
      return (t / base).toFixed(2);
    });
    console.log(`| ${cell.replace("\t", " | ")} | ${arms.map((a) => sec(timeOf(a, cell))).join(" | ")} | ${shown.join(" | ")} |`);
  }
  console.log("");
  for (const a of others) {
    const r = ratios[a];
    if (!r.length) continue;
    const faster = r.filter((x) => x < 1).length;
    console.log(
      `- ${a}: faster than ${baseline} in ${faster} of ${r.length}; median ratio ${num(median(r), 2)}` +
        ` (range ${num(Math.min(...r), 2)}–${num(Math.max(...r), 2)}).`,
    );
  }
}

const SCENARIO = new Set(["stopped", "length-cutoff"]);
table("All completed-answer tasks, by format", (r) => r.arm, (r) => !SCENARIO.has(r.task));
pairedTimes(
  "Total time against block, same task and model (completed-answer tasks)",
  "block",
  (r) => !SCENARIO.has(r.task),
);
table("Stopped by the user mid-answer, by format", (r) => r.arm, (r) => r.task === "stopped");
table("Output-token cap, by format", (r) => r.arm, (r) => r.task === "length-cutoff");
for (const model of [...new Set(rows.map((r) => r.model))].sort()) {
  table(`${model}, completed-answer tasks`, (r) => r.arm, (r) => r.model === model && !SCENARIO.has(r.task));
}
for (const task of [...new Set(rows.map((r) => r.task))].sort()) {
  if (SCENARIO.has(task)) continue;
  table(`Task: ${task}`, (r) => r.arm, (r) => r.task === task);
}
