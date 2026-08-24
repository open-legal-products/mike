# Model committees

A committee answers one prompt with several models at once and has a chair
model synthesize their replies into the single answer the user sees. It is
selected like any other model, from the **Committee** group in the model
picker.

Users build their own committees under **Settings > Models**; a deployment can
also declare committees centrally in `MIKE_MODEL_CONFIG_JSON` (see
[Declaring OpenAI-compatible models](configured-models.md)).

## How a committee runs

1. Every member receives the original system prompt, plus its own optional
   extra instruction, and answers independently. Members run concurrently.
2. The chair receives the original request and all member answers, and is
   instructed to reconcile them without inventing citations or facts that no
   member provided.
3. The chair's answer is what the user sees.

Committee mode has no tool-calling loop. When the caller supplies tools — the
main chat path always does — they are dropped and the members are told so, so
the answer does not claim document or case-law work it could not do.

Because members are separate model calls, a committee costs roughly the sum of
its members plus the chair.

## Rules

- Between 2 and 8 members, up to 8 committees per user.
- A committee may not contain another committee, chair itself, or list itself
  as a member. Cycles are rejected at request time as well as on save.
- Every member and the chair must be usable — a committee is hidden from the
  picker, and refused at request time, when any of them is missing an API key.
  A committee that half-runs is not a usable answer.
- Selecting a committee that has since been deleted is an explicit error
  rather than a silent fallback to another model, because quietly answering
  with a different model misrepresents which model wrote the response.

## Storage

User committees live in `user_profiles.model_committees` (jsonb, default
`[]`), added by migration `20260823_02_user_model_committees.sql`. Their ids
are namespaced with `user-committee/` so they can never collide with a
deployment-declared committee or a catalog model.

Reads tolerate a database that has not applied the migration yet: a missing
column reports "no committees" rather than failing every chat and tabular
request.
