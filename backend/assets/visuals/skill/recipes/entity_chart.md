## Recipe: entity_chart

Who owns or controls whom. Header names the group and the as-at date; one panel with the graph. Mark the ultimate parent `kind: "accent"`, outside parties `kind: "external"`, and write holdings as edge labels. Narrow panels show the same graph as an indented outline, where `incoming` names the relationship. A caption only for what the chart cannot show, such as a deadlock or an option.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Halcyon group ownership</h1>
    <p class="mv-subtitle">Issued ordinary shares as at 30 June 2026, from the share registers and the joint venture agreement.</p>
  </header>
  <section class="mv-section"><div class="mv-panel"><div id="g"></div><p class="mv-caption">Northgate is deadlocked: each party appoints two directors and the chair has no casting vote <button type="button" class="mv-cite" data-cite="doc-2" data-page="14" data-quote="The chair shall not have a second or casting vote" aria-label="Open source"></button>.</p></div></section>
</main>
<script>
MikeVisual.graph("#g", {
  title: "Ownership chart", direction: "DOWN", incoming: "Held by",
  nodes: [
    { id: "hgh", label: "Halcyon Group Holdings Ltd", eyebrow: "England & Wales", kind: "accent", cite: { cite: "doc-1", page: "2" } },
    { id: "huk", label: "Halcyon UK Holdings Ltd", eyebrow: "England & Wales", cite: { cite: "doc-1", page: "5" } },
    { id: "ngt", label: "Northgate Port Services Ltd", eyebrow: "England & Wales", sublabel: "Joint venture", cite: { cite: "doc-2", page: "3" } },
    { id: "cal", label: "Calder Maritime plc", kind: "external" }
  ],
  edges: [
    { source: "hgh", target: "huk", label: "100%" },
    { source: "huk", target: "ngt", label: "50%" },
    { source: "cal", target: "ngt", label: "50%", kind: "dashed" }
  ]
});
</script>
```

Pitfalls: a holding the documents do not state is "Holding unverified" in the sublabel, not a guessed percentage. Only one accent node.
