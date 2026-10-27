## Recipe: chart

A single quantitative comparison. Header with the finding and the period; one `MikeVisual.chart` in a panel, drawn from the data block. `highlight` marks the one bar the finding is about (single-series bars only); `reference` draws the budget, limit or target; `short` on a row gives a label for narrow widths; `cite` on a row opens the cell it came from. Use `table: "details"` when the reader will want the numbers.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Disclosure is the largest overrun</h1>
    <p class="mv-subtitle">Fees billed against budget by phase, invoices to 30 September 2026.</p>
  </header>
  <section class="mv-section"><div class="mv-panel"><div id="c"></div></div></section>
</main>
<script>
MikeVisual.chart("#c", {
  type: "bar", horizontal: true, x: "phase", y: "over_budget", format: "currency", currency: "GBP",
  title: "Billed over (under) budget", data: MikeVisual.data("phases"), highlight: "Disclosure", table: "details"
});
</script>
```

Pitfalls: bar axes start at zero; if the point needs a non-zero `min`, say so in the subtitle. Percent values are percent units (42 means 42%).
