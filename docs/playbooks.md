# Playbooks

Mike playbooks convert a human-authored Word negotiation guide into
structured, versioned rules that can review contracts.

## Data model

A playbook contains global guidance and ordered topics. Each topic contains
rules with:

- a concept to identify at clause or agreement scope;
- a required/optional setting;
- standard, fallback, and unacceptable positions;
- illustrative, preferred, verbatim, accepted, or unacceptable sample clauses;
- conditions, reviewer guidance, and escalation actions; and
- source references to the imported Word paragraph or table cell.

Imported content is always a draft. Publishing creates an immutable numbered
version. Reviews use the last published version, so later draft edits do not
change an in-progress or historical review.

## Importing a Word playbook

1. Open **Playbooks** and select **Import Word**.
2. Select a `.docx` playbook and a compilation model. Only models with usable
   credentials are offered, and Mike preselects an available one.
3. Review the extracted topics, concepts, positions, sample clauses, and
   source references.
4. Save corrections and select **Publish**.

The browser uploads the `.docx` straight to object storage under a presigned
URL scoped to the signed-in account, then asks the API to compile it from that
key. The API never receives the file body, and the staged object is removed
once the import finishes, successfully or not.

The importer reads Word headings, paragraphs, and tables before asking the
model to compile the material. Mike automatically recompiles once when the
first response is not valid JSON, fails schema validation, or cannot be tied
back to the Word source. It retains the original `.docx` only after
compilation succeeds. Every imported rule must resolve to at least one real
source reference, or the import fails rather than creating an unauditable
rule.

Each model attempt has five minutes by default. Set
`PLAYBOOK_COMPILATION_TIMEOUT_MS` to override that limit, or
`LLM_REQUEST_TIMEOUT_MS` to set a shared default. A playbook-specific value
takes precedence. The limit bounds how long an import waits; it does not abort
the model request already in flight.

Each import creates an audit record with its current processing stage. Failed
imports retain the stage and error without retaining the source document,
making credential, Word extraction, model compilation, and output-validation
failures distinguishable.

## Model selection

The compilation and review model menus draw on the same catalog as chat:
built-in cloud models, discovered Ollama models, and OpenRouter models when an
OpenRouter key is configured. A model is offered only when the account has a
usable key for its provider; local Ollama models need none.

## Contract review

Publish the playbook, select **Review document**, choose strict or permissive
posture, and supply a `.docx` or `.txt` contract. Strict mode flags fallback
matches for review; permissive mode may accept them but still explains the
applied fallback.

Review findings include the published rule, status, exact contract quote,
location, analysis, and suggested language. Each run is retained with the
version it was reviewed against.

The current one-pass safety limits are 150,000 extracted characters per
imported playbook, 100,000 serialized characters per published playbook, and
180,000 characters per reviewed contract. Oversized inputs fail explicitly
instead of being silently truncated.
