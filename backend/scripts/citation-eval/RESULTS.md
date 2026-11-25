# Citation eval results, 2026-11-23

Three formats, the same harness (`run.ts`), fixtures and models:

- **block**: `main` at 31234107, the `<CITATIONS>` block.
- **cite_sources**: PR #931 at f5ff4d8e.
- **inline**: this branch with `CITATION_FORMAT=inline`.

Models: claude-sonnet-5-5, claude-haiku-4-5, gpt-6-luna. Seven tasks, three
repeats: 63 runs per format. Quotes are graded against the fixture text by
the harness, not by each branch's own checker.

Caveats:
- Small samples (15 completed answers per model per format); treat
  differences of a few percent as noise.
- Inline quotes are the passage text itself, so "not in source" and "wrong
  page" are 0 by construction. Inline's remaining error is citing the wrong
  passage, which "Expected sources cited" approximates.
- The output-token cap task did not reliably cut answers short (reasoning
  models spent the cap before writing; others finished under it). The
  scripted-model test `citationFailureModes.test.ts` covers that case.
- The "markers standing in for text" heuristic also counts markers placed
  on headings; it is a pointer for manual review, not a defect count.
- "Median total time" in the by-format tables pools tasks from ~3s
  (spreadsheet) to ~100s (long-memo) and three models, so it mostly
  reflects whichever runs land mid-pool (a few Haiku key-terms and
  cross-doc runs). Compare speed with the same-task, same-model table
  instead. Runs went four at a time and each format ran as its own batch,
  so provider load differs between formats.

## Speed

Same task and model, total time against block (table under Full
results):

- **inline** was faster in 14 of 15 task/model cells; median ratio 0.76
  (about 24% faster), range 0.43–1.59. The exception is single-fact on
  GPT-6 Luna (12.6s against 7.9s).
- **cite_sources** was faster in 7 of 15; median ratio 1.01, range
  0.54–1.35. No consistent difference from block.

Inline is not faster because its answers are shorter: its visible answers
are about as long as block's (longer in 11 of 15 cells). Block's raw output
is 1.4–3.1× its visible answer, because the `<CITATIONS>` JSON repeats a
quote for every citation; inline writes `[[doc-0 12]]` instead. That is the
drop in mean output tokens (3.3k to 2.2k).

## Cheap-model reproduction of the "forgotten block" claim

To give the claim its best chance, the block format (`main`'s behaviour) was
run on the two cheapest catalogue models with keys available, on the three
heaviest citation tasks and on follow-up turns. In a follow-up, `main`
replays earlier answers with their [N] markers but without the block they
ended with, so the model sees its own answers apparently uncited.
5 repeats each, 50 runs.

| Model, task | Answers with markers but no citations | Dangling markers | Quotes not in source |
| --- | --- | --- | --- |
| Haiku 4.5, key-terms | 0/5 | 0/80 | 11/80 |
| Haiku 4.5, cross-doc | 0/5 | 0/32 | 5/34 |
| Haiku 4.5, long-memo | 0/5 | 0/138 | 5/138 |
| Haiku 4.5, follow-up (1 earlier turn) | 0/5 | 0/36 | 0/36 |
| Haiku 4.5, follow-up (3 earlier turns) | 0/5 | 0/18 | 2/18 |
| GPT-6 Luna, key-terms | 0/5 | 0/55 | 8/86 |
| GPT-6 Luna, cross-doc | 0/4 (1 run failed) | 0/38 | 2/51 |
| GPT-6 Luna, long-memo | 0/5 | **32/241** (50-citation cap) | 3/243 |
| GPT-6 Luna, follow-up (1 earlier turn) | 0/5 | 0/36 | 0/42 |
| GPT-6 Luna, follow-up (3 earlier turns) | 0/5 | 0/15 | 1/19 |

Not reproduced: no answer lost its block. What cheap models do show is
misquoting (up to 14% of quotes) and, on long answers, the 50-citation cap.
The same follow-up tasks in inline format: 20/20 answers fully cited, 0/99
dangling markers.

## Verified on a local stack (CITATION_FORMAT=inline)

- Browser: a .docx upload, an answer with citation pills, a pill opening the
  document with clause 10.1 highlighted, the same after a reload, and a
  follow-up turn.
- Stop over HTTP after three markers: the saved answer keeps 3 verified
  citations.
- A drafted Word memo with references: no tags or passage labels in the
  generated file.
- An edit of clause 10.1: the edit applies, and its citation resolves to the
  edited text ("twelve months"), verified.
- Citation updates are sent while the answer streams (7 before the last text
  in the memo turn), so markers open before the answer ends.

## After the robustness and surface fixes

Re-run on the final code (Haiku 4.5 and GPT-6 Luna, all tasks, 2 repeats):
28 completed answers with 0/296 dangling markers, 95% of expected sources
cited, no raw tag syntax, no failed runs; 4 stopped answers kept all 22 of
their citations.

Stop through the real chat route on the local stack, three runs each:

| Format | Markers shown | Citations saved |
| --- | --- | --- |
| block (`main`) | 3, 3, 3 | 0, 0, 0 |
| inline | 6, 5, 6 | 6, 5, 6 |

Other surfaces, live on the local stack:

- Word chat (the add-in's document text): every quote one line of at most
  179 characters, an exact substring of the document, verified.
- Tabular chat on a review whose columns have stored indices 0 and 3: the
  model cites COL:1, which resolves through stored index 3; citations are
  stored with the turn, and a marker opens its cell in the table.
- Web chat: the model read the lease, inserted clause 9.4 (moving every
  later passage), then cited clause 10.1 with the passage number it was
  shown before the edit; the citation resolved to clause 10.1 in the
  edited version, verified.
- A first tabular run showed Haiku writing the evidence inside the tags
  ("The landlord is [1]"). The tabular and Word prompts now carry the
  wrong/right example, and the stream shows a quoted tag's words when the
  sentence needs them; three re-runs wrote full sentences.

## Full results

### All completed-answer tasks, by format

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 45 | 45 | 45 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/45 | 1/45 | 0/45 |
| Answers with a dangling marker | 7% | 2% | 0% |
| Dangling / all markers | 30/659 | 8/520 | 0/674 |
| Citations per answer | 14.0 | 11.4 | 15.0 |
| Quotes not in source | 4% | 0% | 0% |
| Quotes on wrong page | 5% | 0% | 0% |
| Quotes the app marked unverified | 3% | 0% | 0% |
| Expected sources cited | 94% | 92% | 96% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 5.7s | 5.8s | 5.5s |
| Median total time | 15.2s | 17.8s | 10.9s |
| Mean input tokens | 17594 | 34934 | 16977 |
| Mean cache-read tokens | 7786 | 20102 | 7478 |
| Mean output tokens | 3265 | 3323 | 2155 |
| cite_sources calls | 0.0 | 1.3 | 0.0 |
| Markers standing in for text (heuristic) | 0/659 | 22/520 | 0/674 |

### Total time against block, same task and model (completed-answer tasks)

| Task | Model | block | cite_sources | inline | cite_sources ÷ block | inline ÷ block |
| --- | --- | --- | --- | --- | --- | --- |
| cross-doc | claude-haiku-4-5 | 13.2s | 17.8s | 10.9s | 1.35 | 0.83 |
| cross-doc | claude-sonnet-5-5 | 26.0s | 26.2s | 24.7s | 1.01 | 0.95 |
| cross-doc | gpt-6-luna | 35.3s | 31.0s | 20.4s | 0.88 | 0.58 |
| key-terms | claude-haiku-4-5 | 15.2s | 20.0s | 9.4s | 1.31 | 0.62 |
| key-terms | claude-sonnet-5-5 | 20.1s | 27.2s | 19.0s | 1.35 | 0.94 |
| key-terms | gpt-6-luna | 17.5s | 14.5s | 7.5s | 0.83 | 0.43 |
| long-memo | claude-haiku-4-5 | 46.5s | 52.0s | 35.3s | 1.12 | 0.76 |
| long-memo | claude-sonnet-5-5 | 83.3s | 103.9s | 74.1s | 1.25 | 0.89 |
| long-memo | gpt-6-luna | 82.1s | 70.1s | 39.5s | 0.85 | 0.48 |
| single-fact | claude-haiku-4-5 | 4.9s | 6.0s | 4.4s | 1.23 | 0.90 |
| single-fact | claude-sonnet-5-5 | 13.4s | 12.6s | 9.4s | 0.94 | 0.70 |
| single-fact | gpt-6-luna | 7.9s | 4.9s | 12.6s | 0.62 | 1.59 |
| spreadsheet | claude-haiku-4-5 | 3.3s | 4.0s | 2.5s | 1.21 | 0.77 |
| spreadsheet | claude-sonnet-5-5 | 5.4s | 4.6s | 4.0s | 0.85 | 0.75 |
| spreadsheet | gpt-6-luna | 5.0s | 2.7s | 2.2s | 0.54 | 0.45 |

- cite_sources: faster than block in 7 of 15; median ratio 1.01 (range 0.54–1.35).
- inline: faster than block in 14 of 15; median ratio 0.76 (range 0.43–1.59).

### Stopped by the user mid-answer, by format

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 9 | 9 | 9 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 9/9 | 0/9 | 0/9 |
| Answers with a dangling marker | 100% | 0% | 0% |
| Dangling / all markers | 64/64 | 0/60 | 0/61 |
| Citations per answer | 0.0 | 18.2 | 6.8 |
| Quotes not in source | – | 0% | 0% |
| Quotes on wrong page | – | 1% | 0% |
| Quotes the app marked unverified | – | 0% | 0% |
| Expected sources cited | 0% | 100% | 100% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 7.5s | 13.9s | 8.8s |
| Median total time | 7.5s | 16.7s | 8.8s |
| Mean input tokens | – | – | – |
| Mean cache-read tokens | – | – | – |
| Mean output tokens | – | – | – |
| cite_sources calls | 0.0 | 1.4 | 0.0 |
| Markers standing in for text (heuristic) | 0/64 | 0/60 | 0/61 |

### Output-token cap, by format

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 9 | 9 | 9 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/3 | 0/3 | 0/3 |
| Answers with a dangling marker | 0% | 0% | 0% |
| Dangling / all markers | 0/88 | 0/70 | 0/86 |
| Citations per answer | 9.8 | 8.0 | 9.6 |
| Quotes not in source | 2% | 1% | 0% |
| Quotes on wrong page | 8% | 1% | 0% |
| Quotes the app marked unverified | 2% | 0% | 0% |
| Expected sources cited | 33% | 33% | 33% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 12.1s | 11.8s | 12.6s |
| Median total time | 15.1s | 16.5s | 14.9s |
| Mean input tokens | 17745 | 29842 | 17150 |
| Mean cache-read tokens | 7793 | 14998 | 7488 |
| Mean output tokens | 2694 | 2673 | 2070 |
| cite_sources calls | 0.0 | 0.7 | 0.0 |
| Markers standing in for text (heuristic) | 0/88 | 0/70 | 0/86 |

### claude-haiku-4-5, completed-answer tasks

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 15 | 15 | 15 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/15 | 0/15 | 0/15 |
| Answers with a dangling marker | 0% | 0% | 0% |
| Dangling / all markers | 0/146 | 0/149 | 0/165 |
| Citations per answer | 9.8 | 10.1 | 11.0 |
| Quotes not in source | 10% | 0% | 0% |
| Quotes on wrong page | 14% | 1% | 0% |
| Quotes the app marked unverified | 10% | 0% | 0% |
| Expected sources cited | 88% | 89% | 91% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 2.3s | 2.2s | 2.0s |
| Median total time | 12.2s | 17.1s | 9.4s |
| Mean input tokens | 17401 | 37629 | 16823 |
| Mean cache-read tokens | 7740 | 21831 | 7448 |
| Mean output tokens | 1807 | 2161 | 1194 |
| cite_sources calls | 0.0 | 1.6 | 0.0 |
| Markers standing in for text (heuristic) | 0/146 | 22/149 | 0/165 |

### claude-sonnet-5-5, completed-answer tasks

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 15 | 15 | 15 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/15 | 1/15 | 0/15 |
| Answers with a dangling marker | 0% | 7% | 0% |
| Dangling / all markers | 0/255 | 8/231 | 0/296 |
| Citations per answer | 17.0 | 14.9 | 19.7 |
| Quotes not in source | 0% | 0% | 0% |
| Quotes on wrong page | 0% | 0% | 0% |
| Quotes the app marked unverified | 0% | 0% | 0% |
| Expected sources cited | 98% | 93% | 100% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 10.5s | 17.8s | 11.5s |
| Median total time | 20.1s | 23.1s | 19.0s |
| Mean input tokens | 22790 | 40659 | 22044 |
| Mean cache-read tokens | 10098 | 21248 | 9736 |
| Mean output tokens | 4610 | 4905 | 3528 |
| cite_sources calls | 0.0 | 0.9 | 0.0 |
| Markers standing in for text (heuristic) | 0/255 | 0/231 | 0/296 |

### gpt-6-luna, completed-answer tasks

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 15 | 15 | 15 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/15 | 0/15 | 0/15 |
| Answers with a dangling marker | 20% | 0% | 0% |
| Dangling / all markers | 30/258 | 0/140 | 0/213 |
| Citations per answer | 15.2 | 9.4 | 14.2 |
| Quotes not in source | 4% | 1% | 0% |
| Quotes on wrong page | 4% | 0% | 0% |
| Quotes the app marked unverified | 1% | 0% | 0% |
| Expected sources cited | 95% | 93% | 96% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 9.6s | 10.9s | 11.6s |
| Median total time | 17.5s | 14.5s | 12.6s |
| Mean input tokens | 12592 | 26513 | 12064 |
| Mean cache-read tokens | 5521 | 17226 | 5252 |
| Mean output tokens | 3377 | 2902 | 1744 |
| cite_sources calls | 0.0 | 1.4 | 0.0 |
| Markers standing in for text (heuristic) | 0/258 | 0/140 | 0/213 |

### Task: cross-doc

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 9 | 9 | 9 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/9 | 0/9 | 0/9 |
| Answers with a dangling marker | 0% | 0% | 0% |
| Dangling / all markers | 0/92 | 0/79 | 0/96 |
| Citations per answer | 10.3 | 8.9 | 10.7 |
| Quotes not in source | 5% | 2% | 0% |
| Quotes on wrong page | 4% | 0% | 0% |
| Quotes the app marked unverified | 5% | 0% | 0% |
| Expected sources cited | 83% | 78% | 89% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 13.5s | 19.7s | 13.8s |
| Median total time | 24.9s | 26.2s | 20.4s |
| Mean input tokens | 19032 | 40414 | 18356 |
| Mean cache-read tokens | 7792 | 22860 | 7490 |
| Mean output tokens | 3248 | 2944 | 2056 |
| cite_sources calls | 0.0 | 1.6 | 0.0 |
| Markers standing in for text (heuristic) | 0/92 | 0/79 | 0/96 |

### Task: key-terms

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 9 | 9 | 9 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/9 | 0/9 | 0/9 |
| Answers with a dangling marker | 0% | 0% | 0% |
| Dangling / all markers | 0/144 | 0/138 | 0/167 |
| Citations per answer | 16.0 | 15.3 | 18.6 |
| Quotes not in source | 10% | 0% | 0% |
| Quotes on wrong page | 11% | 0% | 0% |
| Quotes the app marked unverified | 5% | 0% | 0% |
| Expected sources cited | 100% | 100% | 100% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 7.4s | 10.9s | 5.0s |
| Median total time | 17.5s | 20.0s | 9.4s |
| Mean input tokens | 17549 | 38362 | 17054 |
| Mean cache-read tokens | 7792 | 23118 | 7484 |
| Mean output tokens | 2566 | 2756 | 1509 |
| cite_sources calls | 0.0 | 1.7 | 0.0 |
| Markers standing in for text (heuristic) | 0/144 | 22/138 | 0/167 |

### Task: long-memo

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 9 | 9 | 9 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/9 | 0/9 | 0/9 |
| Answers with a dangling marker | 33% | 0% | 0% |
| Dangling / all markers | 30/362 | 0/249 | 0/344 |
| Citations per answer | 36.9 | 27.9 | 38.2 |
| Quotes not in source | 0% | 0% | 0% |
| Quotes on wrong page | 2% | 1% | 0% |
| Quotes the app marked unverified | 0% | 0% | 0% |
| Expected sources cited | 98% | 100% | 100% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 39.7s | 56.0s | 23.1s |
| Median total time | 69.8s | 70.1s | 40.8s |
| Mean input tokens | 17736 | 41039 | 17123 |
| Mean cache-read tokens | 7791 | 21342 | 7482 |
| Mean output tokens | 9115 | 9805 | 6286 |
| cite_sources calls | 0.0 | 1.4 | 0.0 |
| Markers standing in for text (heuristic) | 0/362 | 0/249 | 0/344 |

### Task: single-fact

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 9 | 9 | 9 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/9 | 1/9 | 0/9 |
| Answers with a dangling marker | 0% | 11% | 0% |
| Dangling / all markers | 0/39 | 8/34 | 0/45 |
| Citations per answer | 4.3 | 2.9 | 5.0 |
| Quotes not in source | 8% | 0% | 0% |
| Quotes on wrong page | 8% | 0% | 0% |
| Quotes the app marked unverified | 8% | 0% | 0% |
| Expected sources cited | 100% | 89% | 100% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 6.3s | 4.1s | 7.3s |
| Median total time | 7.9s | 6.2s | 9.3s |
| Mean input tokens | 17418 | 27973 | 16840 |
| Mean cache-read tokens | 7775 | 16139 | 7456 |
| Mean output tokens | 1032 | 810 | 721 |
| cite_sources calls | 0.0 | 0.9 | 0.0 |
| Markers standing in for text (heuristic) | 0/39 | 0/34 | 0/45 |

### Task: spreadsheet

| Metric | block | cite_sources | inline |
| --- | --- | --- | --- |
| Runs | 9 | 9 | 9 |
| Failed | 0 | 0 | 0 |
| Markers but no citations | 0/9 | 0/9 | 0/9 |
| Answers with a dangling marker | 0% | 0% | 0% |
| Dangling / all markers | 0/22 | 0/20 | 0/22 |
| Citations per answer | 2.4 | 2.2 | 2.4 |
| Quotes not in source | 0% | 0% | 0% |
| Quotes on wrong page | 0% | 0% | 0% |
| Quotes the app marked unverified | 0% | 0% | 0% |
| Expected sources cited | 94% | 94% | 94% |
| Raw citation syntax shown | 0 | 0 | 0 |
| Median time to first text | 4.4s | 2.4s | 2.0s |
| Median total time | 4.5s | 3.7s | 2.6s |
| Mean input tokens | 16237 | 26879 | 15512 |
| Mean cache-read tokens | 7781 | 17052 | 7479 |
| Mean output tokens | 363 | 298 | 205 |
| cite_sources calls | 0.0 | 1.0 | 0.0 |
| Markers standing in for text (heuristic) | 0/22 | 0/20 | 0/22 |
