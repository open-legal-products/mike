# Visuals

The assistant can make a visual: an interactive page shown beside the chat,
saved as a document the user can reopen, download and export. Visuals are
available in chats, project chats and the Word add-in. Tabular review does
not make them.

## What the assistant makes

A visual is one page built from a small design kit that matches the app:
ownership and group structures, maps of how documents relate, defined terms
and their dependencies, dates and deadlines, a branching rule or process, a
dashboard of what a dataset shows, or a single chart. The assistant chooses
the kind from the question; a question prose answers gets no visual.

The assistant does not write the page itself. It briefs a builder: a
subagent on the chat's model that gets the kit's guide, the brief, any
figures computed with `run_python`, and read-only access to the chat's
documents so it can cite pages and quotes. The builder writes the page as an
HTML fragment against the kit's classes, design tokens and helpers (an
orthogonal layout engine for charts of entities and documents, a timeline,
and charts) and saves it. The build shows in the chat as a step, "Building
visual", that opens to the builder's reads and its report; the assistant
checks the report and, to change the visual, briefs the builder again in
words. The page is checked when it is saved: colours, fonts, shadows and
radii must come from the kit's tokens, no element may load anything from the
network, and nothing may navigate or store data. A page that breaks a rule
goes back to the builder with the rule and the fix; after two refusals the
page is saved with the offending parts removed, and a page that is empty or
too large is never saved. When the sandbox renderer is available the page is
also run once in its headless browser before it is saved, and a script that
throws goes back to the builder the same way.

Delegated subagents do not make visuals; the assistant writes the brief from
what they return, and the builder is the only subagent that saves one.

Every visual is a snapshot. The page says what date its data is as at, and a
line under it names when it was prepared and from which files. Uploading a
newer version of a source document does not change a visual; when one of its
sources has moved on, the viewer says so and the user can ask the assistant
to update it, which saves a new dated version.

A visual is stored as an `html` document in the chat's project, or in the
user's library for other chats. Versions work as for other documents: each
update by the assistant is a new version, and the version picker shows them
all. The stored file holds only what the model wrote; the kit is added when
the page is served, so improvements to the kit reach older visuals.

## Citations

Facts in a visual carry citations to the chat's documents, as findings,
numbered sources, or clickable marks on charts and diagrams. Clicking one
opens the cited document beside the chat at the page and quote, or the sheet
and cell, exactly as a citation in an answer does. Access is checked again
when the source opens, so a visual shared with someone who cannot see a
source shows the citation but not the document. A visual cannot cite web
pages or case law.

## Exporting

The title row of a visual offers:

- **Download HTML**: the complete standalone page, with the kit and fonts
  inlined, that opens offline in any browser. Citations are inert outside the
  app. Outside the app the page's scripts run without the viewer's sandbox,
  so treat a downloaded visual like any other HTML file and open only those
  from people you trust.
- **Download PDF**: rendered by a headless browser in the
  [sandbox](code-analysis.md#the-sandbox). A static export loses what only a
  live page has: hover values on charts, clickable citations, the dark theme,
  and the data table behind each chart. A PDF of more than 60 pages is
  refused.
- **New Word document**: the visual as Word content, saved beside the
  visual. Headings, text and tables become Word headings, paragraphs and
  tables; each chart, diagram or timeline is a picture of that element, and
  tabs follow one another with their label as a heading. The assistant can do
  the same with a `visual` section in a generated Word document.

In the Word add-in, **Insert into document** inserts that Word content in a
new paragraph after the selection, in the document's own styles.

Exports are rate limited (`RATE_LIMIT_VISUAL_RENDER_MAX`, 120 an hour per
address) and are unavailable, with a plain message, where the sandbox is not
running.

## Safety

Model-written HTML never runs on the app's origin. The API serves a visual
only as a download with a sandbox policy, and the viewer shows it in two
nested frames that may run scripts but have no origin, no network, no
storage and no way to navigate or open windows. The page's own policy allows
only inline code and inline fonts and images; the frame around it enforces
the same policy even if the page tried to change it. The only thing a visual
can send the app is a citation, which the app validates before acting on it,
and the only thing the app sends a visual is the theme and whether citations
are active.

A future content security policy on the web app or the add-in must keep
allowing inline scripts and styles inside these frames; without that, no
visual renders.

## Troubleshooting

- **The assistant says the visual was not saved.** The page broke a kit rule
  and the builder could not fix it in two tries, the page was empty or too
  large, or the builder ran out of steps. Ask again, with less data or a
  narrower question.
- **"A source has changed since this was made."** A document the visual was
  built from has a newer version. Ask the assistant to update the visual.
- **PDF or Word export is unavailable.** The sandbox service is not running or
  cannot be reached; see [Code analysis](code-analysis.md).
- **The frame stays blank.** The page's script failed; the viewer shows an
  error with a retry. Download the HTML to see the page outside the app.
