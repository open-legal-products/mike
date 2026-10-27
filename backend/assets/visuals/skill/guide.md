# Writing a visual

## What you write

The `html` you save is a body fragment: flow content, normally one `<main class="mv-page">`, plus any inline `<style>` and `<script>`. The file name in the task names the saved file; the page's `h1` is yours: the finding when there is one, otherwise the subject. No `<html>`, `<head>`, `<body>`, `<meta>`, `<link>`, `<iframe>` or `<script src>`: the shell adds the stylesheet, fonts, the kit (`MikeVisual`) and, when the page calls them, the layout engine and the chart library. Scripts run with no network and no storage; they only lay out the page.

A visual is a snapshot of the documents as they were when it was made. The shell stamps the date and the source files under the page; never call a visual live or current.

## The Mike look

A compact analytical view: a short title, a subtitle, then pictures. The subtitle is one sentence: what was analysed and the as-at date. Qualifications, assumptions and what was not checked go in a caption or in the chat answer. Words on the page only name, label and caption. A caption is at most one short sentence and says what the picture cannot (the denominator, the clause that sets the limit, the row that was excluded).

Shape the page to the question. A question with one answer is one picture; separate questions are tabs, each holding a picture (chart, graph, timeline or compact table) with a short label; a number that is itself an answer (a total against a limit, a count of sites in breach) is a stat, and a page has as many stats as the question has answers of that kind, often none. A stats row is never a summary of the charts below it. An entity chart, timeline, document map, term list or single comparison usually has no stats and no tabs.

One accent: azure marks the single most important item (the outlier, the next deadline) plus interactive things and citations; everything else is ink. Hairlines (`--mv-line`) separate; boxes (`.mv-panel`) group one unit, nested at most one level. EB Garamond (titles, `.mv-serif`, `.mv-quote`, `.mv-term-name`) for words from the documents and headings; Inter for everything else. Numbers tabular (`.mv-num`, `.mv-cell-num`), right-aligned, unit in the header. Status and category are plain words in a status colour (`.mv-status--warning`). Sentence case. Flat surfaces, no emoji or icons, no pill badges, no coloured left borders (use `.mv-note`), nothing larger than `.mv-title`; every colour, font, shadow and radius is a `--mv-*` token. A legend only for two or more series.

## Figures

Figures that were computed (any total, share, count, average or date difference) arrive as data blocks named in the brief: read each with `MikeVisual.data("leases")` and draw from it, never retyping its numbers. When there is no data block, show only figures a document states, each cited where it appears; never compute one yourself.

## Mechanics

How the parts are wired. Use the ones the question needs; most pages use the header and one picture.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Pemberton holds a third of the rent</h1>
    <p class="mv-subtitle">40 stores as at 30 June 2026, from the lease schedule.</p>
  </header>
  <section class="mv-section"><div class="mv-panel"><div id="c-landlords"></div><p class="mv-caption" id="cap"></p></div></section>
</main>
<script>
const d = MikeVisual.data("leases");
document.getElementById("cap").textContent = "The other " + d.rest_count + " landlords hold " + d.rest_share + "% between them.";
MikeVisual.chart("#c-landlords", { type: "bar", horizontal: true, x: "landlord", y: "share", format: "percent", data: d.top_landlords, highlight: "Pemberton", reference: { value: 30, label: "Limit 30%" } });
</script>
```

Tabs, when the page answers separate questions: `<div class="mv-tabs"><section class="mv-tab" data-tab="Landlords">...</section><section class="mv-tab" data-tab="Arrears">...</section></div>`.

A stat, when a number is itself an answer and no picture on the page shows it: `<section class="mv-stats" aria-label="Headline figures"><div class="mv-stat"><div class="mv-stat-label">Stores in breach</div><div class="mv-stat-value" id="s-breach"></div><div class="mv-stat-note">of 40</div></div></section>`, its value set with `textContent` from the data.

## Choosing the chart

| Question | Form |
| --- | --- |
| Rank or compare categories | horizontal `bar` of the rows as the data gives them (sorted); a long tail arrives as top rows plus a total for the rest, which goes in the caption, never as an "Other" bar, which would be longer than the leaders and flatten them |
| One value against a limit or target | `bar` with `reference`, or a stat with the limit in its note |
| Actual against plan per category | `bar` with `y: ["budget", "actual"]` |
| Part of a whole | stacked `bar`; `doughnut` only for two to four parts |
| Change over time | `line`; `area` for a cumulative total |
| Distribution | `bar` of the binned counts the data gives |
| Two measures per item | `scatter` |
| Flows between groups | `sankey` |
| Dates and periods | `MikeVisual.timeline`, `MikeVisual.tracks` |
| Structure, ownership, process | `MikeVisual.graph` |
| Categories by categories | `heatmap` |
| Which items have which terms (yes/no, status) | `.mv-table` with status words; `heatmap` only for numeric values |
| Build-up of a total | `waterfall` |
| A single number that is the answer | a stat; two or three values to compare are a short bar, not a row of tiles |

Reserve `gauge` for one value on a fixed scale and `radar`, `funnel` for things that are literally those shapes. No `pie`, `treemap` or `bubble` unless asked. One value axis per chart.

## Components

- Header: `.mv-header` > `.mv-title`, `.mv-subtitle`. Every page. `.mv-eyebrow` above the title is optional: a short kind label such as "Fee review".
- Stat: `.mv-stats` > `.mv-stat` (`.mv-stat-label`, `.mv-stat-value`, `.mv-stat-note`), `.is-key` on the one that matters most. A number that answers the question by itself, with the limit, target or denominator in the note. Short labels; tiles in a row share one baseline.
- Tabs: `.mv-tabs` > `section.mv-tab[data-tab="Label"]`. Separate questions on one page; the kit builds the tablist and keyboard handling, and export shows every panel under its label. One question, no tabs.
- Panel: `.mv-panel` round one picture; `.mv-panel--subtle`, `.mv-panel--flush` (with `.mv-panel-head`, `.mv-panel-body`); `.mv-caption` under a chart; `.mv-slab` for quoted text. `.mv-grid-2` for two pictures that are read together.
- Section: `.mv-section` for the picture of a one-question page, or a second block under a graph (its table of dates, an open-points note).
- Table: only when the reader needs the rows. `MikeVisual.table` for rows from a data block; by hand, for a few rows: `.mv-table-wrap` > `table.mv-table`; `th scope`, `.mv-cell-num` on numeric cells and headers, `.mv-cell-primary`, `.mv-cell-sub`, `tfoot` for totals, `.mv-table-caption`. Key-value list: `dl.mv-kv`.
- Terms: `.mv-terms` > `.mv-term` (`.mv-term-name`, `.mv-term-ref`, `.mv-term-def`, `.mv-term-xrefs`), cross-references `a.mv-xref href="#term-id"`.
- Margin layout: `.mv-margin` > `.mv-margin-label` + content. `.mv-note` (`.mv-note-label`; `--info`, `--caution`, `--risk`) only for a gap that changes how the picture reads; other caveats go in the chat answer.
- Legend: `.mv-legend` > `.mv-legend-item` > `.mv-swatch` (`--accent`, `--muted`, `--dashed`, `--fill`, `--fill-accent`, `--line`, `--line-dashed`, `--line-accent`).
- Citations: `button.mv-cite` (left empty, the kit numbers it), `button.mv-quote` (`.mv-quote-source`, `.mv-quote-text`).
- Utilities: `.mv-muted`, `.mv-faint`, `.mv-strong`, `.mv-status`, `.mv-sr`, `.mv-row`, `.mv-stack`, `.mv-divider`, `.mv-wrap-any`.

## Helpers

All take an element or selector and raw data; they compute order, sizes, durations and positions.

- `MikeVisual.chart(el, spec)`: `type` one of `bar line area combo waterfall pie doughnut gauge scatter bubble heatmap treemap sankey funnel radar`; `data` as row objects (rows may carry `cite` and `short`); `x`, `y` or `series` (`series: [{ field, name, type: "bar"|"line" }]`; combo draws the first as bars, the rest as lines); `format: "number"|"currency"|"percent"`, `currency`, `unit`; `title`, `subtitle`, `highlight`, `horizontal`, `stacked`, `min`, `max`. `reference: { value, label }` (or an array) draws a labelled limit line across a bar, line, area or combo chart. A hidden data table is added for screen readers; `table: "details"` shows it. With several series the palette is categorical and azure is simply the first. `highlight` (a category or array of them) greys every other bar in a single-series bar chart. Sankey: `links: [{ source, target, value, cite }]`, optional `nodes`. Gauge: `value`, `min`, `max`, `warnAt`, `dangerAt`.
- Heatmap: `x`, `y`, `value`, `xCategories` (strings or `{ name, short }`), `yCategories`, `min`, `max`, `scaleLabels: [low, high]`; a missing cell is drawn blank. Waterfall: rows `{ label, value }`, `total: true` for a subtotal, `increase: "bad"`, `increaseLabel`, `decreaseLabel`, `totalLabel`, `min`.
- `MikeVisual.table(el, { data, columns: [{ key, label, format: "number"|"currency"|"percent"|"date", currency, align: "right" }], sort: "fee" (or "-fee" for descending), search: true, pageSize: 50, caption })` draws a `.mv-table` from row objects: sortable headers, a search box and more rows on request; export shows every row. Any list beyond a handful of rows is drawn this way. Rows may carry `cite`.
- `MikeVisual.graph(el, { title, direction: "DOWN"|"RIGHT"|"auto", variant: "flow", nodes: [{ id, label, sublabel, eyebrow, kind: "accent"|"external"|"muted"|"decision"|"terminal", cite }], edges: [{ source, target, label, kind: "dashed"|"accent"|"muted", exit: "side", arrow: false }], incoming: "Held by" })`. Returns a promise. Narrow panels get an indented outline automatically.
- `MikeVisual.timeline(el, { today, items: [{ date, title, kicker, html, status, kind: "key", risk: true, period: { from, to, label }, cite }] })`; ISO dates.
- `MikeVisual.tracks(el, { title, today, start, end, rows: [{ label, sub, from, to, kind: "key"|"done", cite }] })` for overlapping periods on a year axis.
- `MikeVisual.tabs(el)` for a `.mv-tabs` block a script builds; markup present at load is enhanced for you.
- `MikeVisual.echarts(el, option, { height, label })` only when `chart` cannot express it. `MikeVisual.data(name)`. `MikeVisual.formatDate(iso, { short })`. `MikeVisual.chartFormat({ format, currency })` returns `{ full, compact, signed }` for stat values.

## Custom components

Compose kit classes first; then a small `<style>` on tokens: `--mv-space-*`, `--mv-text-*`, `--mv-radius-*`, `--mv-line*`, `--mv-ink*`, `--mv-mark-faint` (strokes, not text), `--mv-surface`, `--mv-slab`, `--mv-canvas`, `--mv-accent*`, `--mv-danger`, `--mv-warning`, `--mv-success`, `--mv-chart-1` to `-8`. Layout with grid `minmax`, `flex-wrap` and container queries on `.mv-page`; space grid and flex items with `gap`; no fixed widths over 320px, no `position: fixed`, no animation. In your own SVG, `fill="var(--mv-ink)"`.

## Width, theme, citations

The page is shown at 350 to 900px wide, light and dark; tokens handle both. No horizontal page scroll: wide tables go in `.mv-table-wrap`.

Cite at the claim. `data-cite` takes a doc_id from this conversation's document list (`doc-1`), with `data-page` and `data-quote` for text documents or `data-sheet` and `data-cell` for spreadsheets, and `data-clause` where helpful. In helper data: `cite: { cite: "doc-1", page: "14", quote: "..." }`. In a Word chat the open document is `doc-0`. Never invent an id.

## Accessibility and sources

Real headings in order; `<table>` with `th scope` for tabular data; `type="button"` on buttons; colour never the only signal. Every number traces to a cell, clause or run; state the denominator and period; bar axes start at zero; unknowns are written as "not stated in the SPA", never filled in.
