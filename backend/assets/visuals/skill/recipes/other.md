## Recipe: other

Anything else: compose kit components first, and add a small custom component on tokens only when nothing fits. Example: an obligation matrix (parties by obligation).

```html
<style>
  .ob-grid { display: grid; grid-template-columns: minmax(8rem, 1fr) repeat(2, minmax(5rem, 9rem)); border-top: 1px solid var(--mv-line-strong); font-size: var(--mv-text-sm); }
  .ob-grid > * { padding: var(--mv-space-2) var(--mv-space-2-5); border-bottom: 1px solid var(--mv-line); }
  .ob-head { font-size: var(--mv-text-xs); color: var(--mv-ink-muted); }
  .ob-yes { color: var(--mv-ink-strong); }
  .ob-no { color: var(--mv-ink-faint); }
  @container mv-page (max-width: 420px) { .ob-grid { grid-template-columns: 1fr 4.5rem 4.5rem; } }
</style>
<main class="mv-page">
  <header class="mv-header">
    <h1 class="mv-title">Who must do what under the SHA</h1>
    <p class="mv-subtitle">Continuing obligations by party, from the shareholders' agreement dated 4 June 2025.</p>
  </header>
  <section class="mv-section">
    <div class="ob-grid" role="table" aria-label="Obligations by party">
      <div class="ob-head" role="columnheader">Obligation</div><div class="ob-head" role="columnheader">Founders</div><div class="ob-head" role="columnheader">Investor</div>
      <div role="cell">Non-compete, 24 months <button type="button" class="mv-cite" data-cite="doc-1" data-page="22" data-clause="14.1" aria-label="Open source"></button></div><div class="ob-yes" role="cell">Yes</div><div class="ob-no" role="cell">No</div>
      <div role="cell">Information rights</div><div class="ob-no" role="cell">No</div><div class="ob-yes" role="cell">Yes</div>
    </div>
  </section>
</main>
```
