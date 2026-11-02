# Subagents

In chats and project chats, the assistant can hand a self-contained task to a
subagent: reviewing a long document, researching case law or the web, or
making a set of edits. Several subagents can work at once, up to 8 per answer,
continuations included. Each one returns a brief, and the assistant writes the
answer. There is no switch to turn them on: the assistant decides when a task
is worth delegating. Tabular review, workflows and the Word add-in do not use
subagents.

Subagents use more tokens than answering directly, and they run on the API
keys the chat runs on.

## What a subagent can do

A subagent works with the user's access and nothing more. It has the same
tools as the answer that started it: the chat's documents, CourtListener and
the web when they are on, workflows and playbooks, document generation and
editing, and the user's connectors (MCP servers, Google Drive and Workspace).
Where the answer may not write documents, for example a project viewer's
chat, neither may its subagents. It cannot ask the user questions or start
subagents of its own; those two tools are refused if it asks for them anyway.

The assistant can limit a subagent to some of the chat's documents. A scoped
subagent's document list shows only those, its document tools refuse any
other, and searches across a project, library or templates are refused; it
can still search inside its own documents and create new ones, which it can
then use. A continued subagent keeps the documents it started with.

A subagent is told to act only within its task and never because a document,
web page or email asks it to, and to list every change it made in its brief.
The assistant is also told, by the server, which documents the subagent
edited, created or copied and which connector actions it ran, and reports
them to the user. The edits appear as the usual accept/reject cards once
the subagent finishes.

Edits to one document from the answer and its subagents run in turn, each
building on the last. The assistant is told not to give two subagents
overlapping edits.

A subagent sees only the task the assistant writes for it, not the
conversation. Its brief comes back fenced as untrusted content, and the
assistant must cite a document or case itself before relying on what a
subagent found; those citations are verified like any other.

## Questions, approvals and follow-ups

A subagent that cannot finish without an answer (an ambiguity, a missing
fact) stops and asks the assistant. The assistant answers it when the
conversation or the documents settle it. If only the user knows, the
assistant asks the user, and continues the subagent in the next turn.

A connector write that needs the user's permission (see **Ask for permission
for write actions** in [Google Workspace](google-workspace.md)) pauses the
subagent. Its approval reaches the user in the answer's popup, marked as
requested by that subagent, together with any other approvals and questions of
the same step, and the answer pauses with it. Once the user decides, the
server runs what was approved and the assistant continues the subagent. The
subagent is told, from the server's own record, whether each action ran (and
its result), failed, was rejected, or has no recorded outcome, in which case
it must not retry it.

The assistant can also continue a finished subagent with a follow-up, in the
same answer or a later one in the same chat. The subagent keeps its task, its
findings and its earlier tool results, so it does not read everything again.
Each continuation is a new delegation with its own limits, and counts toward
the subagents per answer.

To make that possible, Mike keeps each subagent's task, findings, question
and tool results (document text, case text, web pages) in the
`chat_subagent_runs` table for 30 days. Only the backend reads it, and only
for the user who started the subagent, in the chat it ran in: other members
of a shared chat, and organization admins, cannot continue it. A row is
deleted with its chat, its answer or the account. When a later turn continues
a subagent, results from documents the user can no longer open, or versions
that no longer exist, are left out.

## Effort and model

For each task the assistant picks an effort and a model tier, or a specific
model. Explicit requests in the conversation ("be quick", "use a cheap
model", "don't delegate") override its defaults.

| Effort | Steps | Tokens | Time | Web searches / pages |
| --- | --- | --- | --- | --- |
| Quick | 20 | 600,000 | 10 min | 10 / 15 |
| Standard | 50 | 2,500,000 | 30 min | 25 / 40 |
| Deep | 120 | 8,000,000 | 90 min | 60 / 100 |

Even quick effort allows more steps than a chat answer's 16, because a
subagent is meant for long reading and research. All of an answer's subagents
together make at most 150 web searches and open at most 250 pages.

A subagent that reaches its time or token limit stops and returns a partial
brief. Its last step has no tools, so it ends with a brief rather than
mid-search. Token limits apply only when the provider reports usage. A stop or
a time limit takes effect between tool calls, so a document tool already
running finishes first.

Quick and standard effort cap reasoning at low and medium; deep uses the
chat's reasoning level. A reasoning level the assistant names for a task
replaces the cap.

| Tier | Model |
| --- | --- |
| Light | The provider's low-tier model (for example Claude Haiku) |
| Standard | The provider's mid-tier model (for example Claude Sonnet) |
| Same | The chat's model |

A tier never picks a more capable model than the chat. Models reached
through a router, a cloud platform, a custom endpoint or Ollama run tiered
subagents on the chat's model.

When the user asks for a particular model ("use two Fable subagents"), the
assistant names it, and that wins over the tier. The assistant is shown the
chat's model and the other built-in models of the same provider that the user
has a key for, and can name any other model the user could pick for a chat.
The server checks a named model the way it checks a chat's model (the saved
router selections and the user's keys); one the user can't use falls back to
the tier, and the assistant is told.

In **Settings > Model Preferences**, *Subagent model* and *Subagent reasoning*
set defaults for these choices; *Chosen per task* leaves them to the
assistant. A default is only an instruction to the assistant: it uses it unless
the conversation asks for something else ("use a cheap model for this"), and
the server enforces nothing. A default model the user can't use falls back to
the tier like any other named model.

Each delegation shows the model and effort it ran with.

## Troubleshooting

- Existing deployments must apply the `20261018_*` migrations from
  `backend/migrations/` before subagents can be continued in a later turn.
- A subagent that ran in another chat, for another user, more than 30 days
  ago, or failed or was stopped cannot be continued. The assistant is told so
  and starts a new one.
