## Recipe: timeline

Dates and deadlines under one agreement or a short set of related ones. Use `tracks` instead, or as well, when the point is overlapping periods (earn-out years, warranty periods). Header names the agreement and today's date; then the timeline; then an "Open points" note only for dates the documents leave uncertain. Give the helper ISO dates and today's date from the task; it computes order, done state, elapsed share and day counts.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Key dates under the Fenwick SPA</h1>
    <p class="mv-subtitle">Signing to the warranty claims cut-off, as at 20 October 2026.</p>
  </header>
  <section class="mv-section"><div id="tl"></div></section>
  <section class="mv-section">
    <div class="mv-note"><span class="mv-note-label">Open points</span><p>The completion accounts deadline runs from delivery of the draft, which the documents do not date.</p></div>
  </section>
</main>
<script>
MikeVisual.timeline("#tl", {
  today: "2026-10-20",
  items: [
    { date: "2026-03-12", kicker: "Signing", title: "Exchange and deposit", cite: { cite: "doc-1", page: "8", clause: "3.2" } },
    { date: "2027-01-31", kicker: "Earn-out 1", kind: "key", title: "First earn-out statement due", period: { from: "2026-01-01", to: "2026-12-31", label: "FY2026" }, cite: { cite: "doc-1", page: "44" } },
    { date: "2028-01-08", kicker: "18 months", title: "General warranty claims cut-off", risk: true, status: "Falls before the second earn-out statement", cite: { cite: "doc-1", page: "52", quote: "within 18 months of Completion" } }
  ]
});
</script>
```

Pitfalls: a date that depends on an event ("10 Business Days after Completion") has no ISO date; put it in the note with its clause, not on the axis. Mark only one item as key.
