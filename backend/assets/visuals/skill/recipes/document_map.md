## Recipe: document_map

How documents relate: which governs, amends, guarantees or is subject to which. Header names the transaction and the as-at date; a graph with the principal document as the accent node and edge labels naming the relationship; a compact table only for what the graph cannot carry (dates and the linking clause), each cited.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Fenwick facility documents</h1>
    <p class="mv-subtitle">The agreements in the data room as at 20 October 2026 and how they bind each other.</p>
  </header>
  <section class="mv-section"><div class="mv-panel"><div id="map"></div></div></section>
  <section class="mv-section">
    <div class="mv-table-wrap"><table class="mv-table">
      <thead><tr><th scope="col">Document</th><th scope="col">Dated</th><th scope="col">Linking clause</th></tr></thead>
      <tbody>
        <tr><td>Facility agreement</td><td>12 Mar 2024</td><td>18.2 <button type="button" class="mv-cite" data-cite="doc-1" data-page="31" data-clause="18.2" aria-label="Open source"></button></td></tr>
        <tr><td>Amendment deed</td><td>3 Feb 2026</td><td>2.1 <button type="button" class="mv-cite" data-cite="doc-2" data-page="2" aria-label="Open source"></button></td></tr>
      </tbody>
    </table></div>
  </section>
</main>
<script>
MikeVisual.graph("#map", {
  title: "Document map", incoming: "Referenced by",
  nodes: [
    { id: "fa", label: "Facility agreement", sublabel: "12 March 2024", kind: "accent", cite: { cite: "doc-1", page: "1" } },
    { id: "am", label: "Amendment deed", sublabel: "3 February 2026", cite: { cite: "doc-2", page: "1" } },
    { id: "gu", label: "Guarantee", sublabel: "12 March 2024", cite: { cite: "doc-3", page: "1" } }
  ],
  edges: [
    { source: "am", target: "fa", label: "amends", kind: "dashed" },
    { source: "gu", target: "fa", label: "secures" }
  ]
});
</script>
```

Pitfalls: a document mentioned but not in the data room is `kind: "external"` with "not provided" in the sublabel. Edge labels are verbs, not clause numbers; clauses go in the table.
