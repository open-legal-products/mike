## Recipe: concept

How a rule, test or process branches: a flowchart drawn with `graph` in `variant: "flow"`. Decisions are `kind: "decision"` with yes/no edge labels; start and end are `kind: "terminal"`; a "no" branch leaves sideways with `exit: "side"` so the main path stays straight. Narrow panels get numbered steps instead. A caption carries the one condition the boxes cannot.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Change of control consent under the lease</h1>
    <p class="mv-subtitle">The steps clause 24 requires before a share sale, from the lease dated 1 May 2021.</p>
  </header>
  <section class="mv-section"><div class="mv-panel"><div id="flow"></div><p class="mv-caption">Consent cannot be unreasonably withheld <button type="button" class="mv-cite" data-cite="doc-1" data-page="31" data-quote="not to be unreasonably withheld" aria-label="Open source"></button>.</p></div></section>
</main>
<script>
MikeVisual.graph("#flow", {
  title: "Consent process", variant: "flow", direction: "DOWN",
  nodes: [
    { id: "s", label: "Proposed share sale", kind: "terminal" },
    { id: "q1", label: "Is control changing?", kind: "decision", cite: { cite: "doc-1", page: "31" } },
    { id: "n", label: "Serve notice with buyer details", cite: { cite: "doc-1", page: "31" } },
    { id: "q2", label: "Net assets at least 3x rent?", kind: "decision" },
    { id: "g", label: "Landlord may require a guarantor" },
    { id: "e", label: "Consent within 20 business days", kind: "terminal" },
    { id: "x", label: "No consent needed", kind: "terminal" }
  ],
  edges: [
    { source: "s", target: "q1" },
    { source: "q1", target: "n", label: "yes" },
    { source: "q1", target: "x", label: "no", exit: "side" },
    { source: "n", target: "q2" },
    { source: "q2", target: "e", label: "yes" },
    { source: "q2", target: "g", label: "no", exit: "side" },
    { source: "g", target: "e" }
  ]
});
</script>
```

Pitfalls: one decision per node, phrased as a question with a yes/no answer. Keep the main path to at most eight steps.
