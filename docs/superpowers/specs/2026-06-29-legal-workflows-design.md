# Archived: Legal Workflows — Design Spec

> Historical design proposal recorded on 2026-06-29. Its file paths and
> workflow-loading architecture are no longer current. System workflows now
> come from the `mike-workflows` repository and are generated into Mike as
> described in [CONTRIBUTING.md](../../../CONTRIBUTING.md#mike-workflows).

Date: 2026-06-29

## Goal

Add three curated assistant workflows: a cease-and-desist letter drafter, a
contract-triage router, and a Master Services Agreement review.

## Architecture

Workflows are titled prompts (`{ id, title, prompt_md }`). Built-ins are
code-defined in `backend/src/lib/builtinWorkflows.ts`, seeded into the runtime
`WorkflowStore` by `buildWorkflowStore` (`lib/chatTools.ts`), and exposed to the
assistant via the `list_workflows` and `read_workflow` tools. No DB or schema
change is involved.

These three live in a **new file** `backend/src/lib/legalWorkflows.ts`
exporting `LEGAL_WORKFLOWS: { id: string; title: string; prompt_md: string }[]`.
`builtinWorkflows.ts` imports and spreads it into `BUILTIN_WORKFLOWS`, so the
single existing seed path picks them up automatically.

```ts
// builtinWorkflows.ts
import { LEGAL_WORKFLOWS } from "./legalWorkflows";
export const BUILTIN_WORKFLOWS = [ ...existing, ...LEGAL_WORKFLOWS ];
```

No other code changes. Chaining (workflow #2) works because the assistant can
call `list_workflows` then `read_workflow` mid-run to load and follow another
workflow's prompt.

## Workflow 1 — `builtin-cease-and-desist`

Title: **Draft Cease & Desist (IP infringement)**

Behaviour: gather the essentials (asking for anything not already supplied or
found in uploaded documents), then draft a formal C&D letter as a downloadable
`.docx`.

Draft `prompt_md`:

> ## Draft a Cease & Desist Letter (IP infringement)
>
> Help the user draft a formal cease-and-desist letter to a party copying their
> product or intellectual property.
>
> First, make sure you have the information below. Use anything available in
> uploaded documents or the conversation; for anything missing, ask the user in
> a single consolidated list and wait for their reply before drafting:
> - Rights holder: full legal name and address of the party sending the letter.
> - The IP/rights being infringed: copyright, trademark, and/or trade dress —
>   and any registration numbers or first-use/priority dates if available.
> - The original product or work being copied (short description).
> - The infringer: name and address/contact if known.
> - Where the infringement appears: marketplace/site names and specific URLs or
>   listing IDs.
> - How they are infringing (a concrete description of the copying).
> - Desired remedies (e.g. stop sales, remove listings, destroy inventory,
>   written confirmation) and a compliance deadline (e.g. 10 business days).
>
> Then use the generate_docx tool to produce the letter as a downloadable Word
> document. Structure it as a formal business letter: sender block, date,
> recipient block, "RE:" line, body paragraphs (identify the rights and the
> ownership, describe the infringing conduct with the specifics gathered,
> demand the listed remedies by the stated deadline, and reserve all rights and
> remedies), and a signature block.
>
> Keep the tone firm and professional. Do not assert facts the user has not
> provided. Begin the document with a short italicised note: "Draft for review —
> not legal advice. Have qualified counsel review before sending." Do not give a
> legal opinion on the strength of the claim.

## Workflow 2 — `builtin-contract-triage`

Title: **Review Contract (auto-detect type)**

Behaviour: detect the contract type, then load and follow the matching review
workflow; fall back to a generic review for unrecognised types.

Draft `prompt_md`:

> ## Review Contract — detect type and run the right review
>
> 1. Read the uploaded contract and identify its type (e.g. Master Services
>    Agreement, Shareholder Agreement, Credit/Facility Agreement, NDA, SaaS
>    subscription, employment agreement, etc.). State the detected type in one
>    line.
> 2. Call list_workflows and look for a review workflow matching the detected
>    type:
>    - Master Services Agreement → "Master Services Agreement Review"
>    - Shareholder Agreement → "Shareholder Agreement Summary"
>    - Credit or Facility Agreement → "Credit Agreement Summary"
>    If a match exists, call read_workflow with its id and follow those
>    instructions exactly for this document.
> 3. If no specific review workflow matches the detected type, do a general
>    contract review instead: parties and roles, term and renewal, key
>    obligations of each party, fees/payment, liability and indemnities,
>    termination rights and effects, governing law and dispute resolution, and a
>    list of any unusual, onerous, or non-market terms with clause references.
>
> Always ground findings in the document and cite clause or section references.

## Workflow 3 — `builtin-msa-review`

Title: **Master Services Agreement Review**

Behaviour: structured summary like the existing Credit/SHA reviews, delivered
inline (docx only if the user asks).

Draft `prompt_md`:

> ## Master Services Agreement Review
>
> Review the uploaded Master Services Agreement and produce a comprehensive
> legal summary covering the topics below. For each, identify the key
> provisions, quote the relevant clause or schedule references, and flag any
> unusual, onerous, or non-market terms.
>
> 1. **Parties** — full legal names, roles (customer/supplier), and jurisdictions.
> 2. **Structure** — how the MSA relates to SOWs/Order Forms; order of precedence.
> 3. **Term & Renewal** — initial term, renewal mechanism, and notice periods.
> 4. **Services & SOW mechanics** — how services are scoped, changed, and accepted.
> 5. **Fees & Payment** — pricing model, invoicing, payment terms, late fees,
>    expenses, and any rate-increase mechanism.
> 6. **Intellectual Property** — ownership of pre-existing IP and deliverables,
>    and any licences granted.
> 7. **Confidentiality** — scope, exclusions, and duration.
> 8. **Data Protection & Security** — data processing obligations, security
>    standards, breach notification, and any DPA reference.
> 9. **Warranties** — service warranties and disclaimers.
> 10. **Indemnities** — who indemnifies whom and for what (e.g. IP, data breach).
> 11. **Limitation of Liability** — liability caps, the cap amount/formula, and
>     carve-outs (e.g. confidentiality, IP, data breach, indemnities).
> 12. **Insurance** — required coverage types and amounts.
> 13. **Termination** — termination for cause/convenience, cure periods, and the
>     effects of termination (transition, return/destruction of data).
> 14. **Governing Law & Dispute Resolution** — governing law, forum, and whether
>     litigation or arbitration.
>
> Deliver the summary inline in your chat response. Only produce a downloadable
> Word document with generate_docx if the user explicitly asks for one.

## Out of scope / non-goals

- No new tools, routes, DB tables, or frontend changes.
- No jurisdiction-specific legal logic beyond what the prompts request from the user.
- Workflows are drafting/review aids, not legal advice (stated in-letter for #1).

## Test plan

- `list_workflows` (via the assistant) returns the three new titles.
- Each runs end-to-end: #1 asks for missing details then emits a `.docx`; #2
  detects an MSA and follows the MSA review; #3 produces the inline summary.
- Backend `npm run build` (tsc) passes.
