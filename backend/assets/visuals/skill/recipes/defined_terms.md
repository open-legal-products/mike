## Recipe: defined_terms

What terms mean and how they depend on each other. One `.mv-term` per term, in the order a reader needs them (base terms first), the definition quoted from the document in serif, cross-references as `a.mv-xref` to the term's id, and a cite on each.

```html
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Earn-out definitions in the Fenwick SPA</h1>
    <p class="mv-subtitle">The seven terms that fix the earn-out, as defined in the execution version dated 12 March 2026.</p>
  </header>
  <section class="mv-section">
    <div class="mv-terms">
      <article class="mv-term mv-margin" id="t-ebitda">
        <span class="mv-margin-label mv-term-ref">Sch. 6, para 1</span>
        <div>
          <h2 class="mv-term-name">EBITDA</h2>
          <p class="mv-term-def">The consolidated profit of the Target Group for the relevant Earn-out Period before interest, tax, depreciation and amortisation, adjusted as set out in paragraph 2 <button type="button" class="mv-cite" data-cite="doc-1" data-page="44" data-quote="before interest, tax, depreciation and amortisation" aria-label="Open source"></button>.</p>
          <p class="mv-term-xrefs">Uses <a class="mv-xref" href="#t-period">Earn-out Period</a>, <a class="mv-xref" href="#t-target">Target Group</a></p>
        </div>
      </article>
      <article class="mv-term mv-margin" id="t-period">
        <span class="mv-margin-label mv-term-ref">Sch. 6, para 1</span>
        <div>
          <h2 class="mv-term-name">Earn-out Period</h2>
          <p class="mv-term-def">Each of the financial years ending 31 December 2026 and 31 December 2027 <button type="button" class="mv-cite" data-cite="doc-1" data-page="44" aria-label="Open source"></button>.</p>
        </div>
      </article>
    </div>
  </section>
  <section class="mv-section">
    <div class="mv-note mv-note--caution"><span class="mv-note-label">Gap</span><p>"Target Group" is used in Schedule 6 but defined only in clause 1.1; the two readings differ on whether Northgate is included.</p></div>
  </section>
</main>
```

Pitfalls: quote definitions verbatim, with the page; do not paraphrase inside `.mv-term-def`. A term defined in two places gets two refs, not a merged definition.
