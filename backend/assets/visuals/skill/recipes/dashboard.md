## Recipe: dashboard

What a dataset shows, against the context the other documents give. The figures come as data blocks, shaped for drawing. One chart per question, in tabs when there are several; a stat only for a number that answers the question and that no chart shows; a detail list (the customers behind, the entries in breach) as `MikeVisual.table` from its data block, only where the reader needs the rows. The shape follows the question: one trend is one chart with no stats or tabs; three questions about a portfolio are three tabs; a page with four stats is right only when the question has four answers that are numbers.

Here the client asked whether sales will reach the annual minimum, which region is behind, and which customers.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Sales are on course to miss the annual minimum</h1>
    <p class="mv-subtitle">January to September 2026, from the sales schedule.</p>
  </header>
  <section class="mv-stats" aria-label="Headline figure">
    <div class="mv-stat is-key"><div class="mv-stat-label">Projected shortfall at year end</div><div class="mv-stat-value" id="s-gap"></div><div class="mv-stat-note">At the nine-month run rate</div></div>
  </section>
  <div class="mv-tabs">
    <section class="mv-tab" data-tab="Against minimum">
      <div class="mv-panel"><div id="c-month"></div></div>
    </section>
    <section class="mv-tab" data-tab="By region">
      <div class="mv-panel"><div id="c-region"></div></div>
    </section>
    <section class="mv-tab" data-tab="Customers behind">
      <div id="t-customers"></div>
    </section>
  </div>
</main>
<script>
const d = MikeVisual.data("summary");
document.getElementById("s-gap").textContent = MikeVisual.chartFormat({ format: "currency", currency: "GBP" }).compact(d.projected_shortfall);
MikeVisual.chart("#c-month", { type: "area", title: "Cumulative revenue", x: "month", y: "cumulative", format: "currency", data: d.by_month, reference: { value: d.minimum, label: "Annual minimum, cl. 5.1" } });
MikeVisual.chart("#c-region", { type: "bar", horizontal: true, title: "Revenue against regional target", x: "region", y: "pct_of_target", format: "percent", data: d.by_region, highlight: d.weakest_region, reference: { value: 100, label: "Target" } });
MikeVisual.table("#t-customers", {
  data: d.customers_behind,
  columns: [{ key: "customer", label: "Customer" }, { key: "region", label: "Region" }, { key: "revenue", label: "Revenue", format: "currency" }, { key: "pct_of_target", label: "Of target", format: "percent" }],
  sort: "pct_of_target", search: true, caption: "Customers below 90% of their target at the nine-month point.",
});
</script>
```

Pitfalls: never hand-type arrays that Python produced. A stat that restates a chart is one too many, and so is a sentence that says what a chart shows. A fact stated once (the minimum here) is not repeated in the subtitle, a note and a caption.
