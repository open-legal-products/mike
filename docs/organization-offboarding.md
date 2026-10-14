# Organization offboarding

Removing a member, leaving an organization and deleting an account use the
same organization content rules. Account deletion applies them to every team
organization before deleting personal workspace data and the authentication
account. An organization never acquires someone's personal workspace.

| State after departure | Result |
| --- | --- |
| Another item owner remains | Keep the item and its existing owners. |
| Public or shared with remaining members, without another owner | Transfer to one selected member; default to a remaining organization owner. |
| Private and unshared, without another owner | Archive for 30 days, then permanently delete. |

The rules cover projects, workflows, standalone chats, tabular reviews and
uploaded library documents. Project and workflow contents follow their parent.
Library files referenced by retained conversations or reviews are retained too.
Recovering archived work also recovers its archived library dependencies when
those dependencies are still within their recovery period.

Only organization owners can list, reassign or permanently delete archived
work, under **Organization settings → Members → Departed**. That view lists one
row per departure (the person, when they left, and when their work is deleted),
which opens into the types of work and then the items, so an owner can hand
over or delete everything a person left, one type, or a selection. A departed
member whose account has since been deleted is listed as a former member,
without a name. Reassigning assigns an owner and removes the expiry date.
Archived content is excluded from ordinary access, including access by
organization owners; it must be reassigned first. Removal previews show counts for private work and never
expose its titles to administrators.

Admins can remove ordinary members and transfer their shared work. They cannot
manage the private archive or remove organization owners/admins. The last owner
must appoint another owner or explicitly delete the organization, even when the
organization is empty. No editor is automatically promoted to organization
owner.

## Joining during signup

After signing up and verifying their email, a user can view and accept pending
organization invitations on a separate third onboarding screen, after profile
and legal practice details. Each invitation shows
the organization, offered role and inviter. Accepting selects that organization
for the end of setup; it does not complete onboarding or remove the user's
personal workspace. Users can continue setup without accepting and decide later
in Settings → Organizations. Invitation details are never looked up from an
unverified email entered into the signup form.

## Transactions and operations

`remove_org_member` rechecks permissions under an organization lock. Its
membership-deletion trigger transfers or archives content and revokes the
departing member's ownership and grants in the same transaction.
`request_account_deletion` atomically offboards all team memberships, inserts
the account deletion job and sets `account_deletion_requested_at`. API
authentication refuses further access while deletion is pending. The worker
deletes personal data before the authentication account and can safely retry.

`org_departure_events` records transfers, archives, recoveries, deletions and
expiry in their database transactions. These organization records survive the
departing account's deletion and contain no copied email or private item title.

The worker maintenance sweep expires archives in batches of 100, beginning
30 seconds after worker startup and repeating on `STALE_SWEEP_INTERVAL_MS`.
Recovery stops at the expiry timestamp even if a sweep is delayed. Document
deletion uses the existing durable document-cleanup queue. Run a worker runtime
when the API uses `WORKERS_MODE=none`; otherwise scheduled expiry will not run.

Apply `20261013_05_org_departure_retention.sql` and
`20261013_06_org_departure_listing.sql` before deploying this backend.
Fresh installations already include it in `backend/schema.sql`. The migration
cannot recover private content deleted under the previous removal policy.

The PostgreSQL regression suite creates and drops its own disposable database:

```bash
MIKE_TEST_POSTGRES_CONTAINER=supabase_db_backend npm test --prefix backend -- \
  src/__tests__/integration/orgDepartureRetention.postgres.test.ts
```

## Organization audit log

Owners and admins open **Organization → Audit log**. It uses the
same table, date selector, type/status/application filters, search, scrolling,
event details and export modal as **Settings → My Activity**. It has no entry in the
account dropdown. CSV exports preserve the selected organization and filters,
include its ID, and contain up to 2,000 events; narrow the period for larger logs.
Authorization is rechecked when listing, queuing, building and downloading.

Events carry an immutable organization identifier independent of the actor's
current membership and the continued existence of a resource. Creation is
recorded after its owner membership succeeds. Deletion, restoration, purge and
member-departure events are recorded in their database transactions. The
migration backfills associations from recorded organization/resource IDs;
events whose source has already disappeared without recorded scope remain
unattributed. It does not guess from current memberships or invent past
creation events.

Audit access does not grant content access. Titles, details and links for
inaccessible private work are redacted before search, sorting and CSV export.
Account erasure removes personal history and anonymizes the actor on retained
organization events.

## Deleting and restoring an organization

An owner can delete a nonempty team organization from its General settings.
This immediately removes it from workspace lists and blocks normal access,
including creator access, invitations and new content. Existing content,
memberships and settings remain recoverable for 30 days. Personal workspaces
cannot be deleted through organization endpoints.

Owners restore from **Settings → Organizations → Recently deleted**. The
screen shows the exact recovery deadline. Restoration requires MFA when the
owner has enrolled it. Admins, members and outsiders cannot restore an
organization. Restoration preserves existing roles and item permissions;
previously archived departed-member work stays archived and its independent
expiry continues to apply. Repeating deletion does not extend the deadline.

After the deadline, restoration is refused even if maintenance is delayed.
The worker's regular maintenance sweep permanently removes expired
organizations in bounded transactions. It uses the same organization lock as
restore, so recovery cannot race a purge. Document-version deletion enqueues
existing durable storage cleanup; storage outages can be retried. A worker
runtime must be running to perform expiry and drain cleanup jobs.

Apply `20261014_03_organization_audit_lifecycle.sql` before deploying these
API/UI changes. The complete fresh-install schema includes the same changes.
No additional service or production dependency is required.


## Access to active private organization content

Owners open active private organization items from **Organization → Audit log →
Event details**, using the footer's Open button. There is no separate Private
Content page; its former URL redirects to the audit log. Projects, workflows,
chats, reviews and documents are supported. Personal workspaces are excluded.
Admins do not receive private access automatically; existing explicit private
content permissions continue to apply. The permissions API remains available,
but the UI for granting new admin permissions is intentionally omitted with the
removed Private Content page.

Permission allows discovery of organization item names and their owners. It
does not grant ordinary content access until the event's **Open** button is
selected. That action atomically saves a read-only opening and an audit event;
an audit failure leaves no opening. Existing sharing rights continue to apply.
Referenced documents are included only while they remain in the same
organization. Archived items still require the separate offboarding recovery
process.

**End access** removes the explicit opening. Permission revocation, demotion,
departure, item archival or ownership/scope changes and organization deletion
also remove openings; restoring a role or item does not restore old openings.
The server rechecks membership, permission and item scope on every read. Audit
entries record permission changes, openings and voluntary endings. Admins
without permission cannot see other actors' private-item titles in those events.

Apply `20261014_04_org_private_content_access.sql` and
`20261014_05_audit_private_content_access.sql` before deploying the backend.
The fresh schema includes the same changes. Verify the database rules in a
disposable local database:

```bash
MIKE_TEST_POSTGRES_CONTAINER=supabase_db_backend npm test --prefix backend -- \
  src/modules/orgs/__tests__/orgs.privateContent.postgres.test.ts
```


The audit pagination and lifecycle review fixes ship in
`20261014_07_org_lifecycle_review_fixes.sql` and
`20261014_08_paginate_organization_audit.sql`. Apply all pending migrations
before deploying the backend. Organization username searches stay within the
organization's audit actors, and ordinary pages resolve resource access only
for the selected events. Sensitive title searches and sorts redact first.
