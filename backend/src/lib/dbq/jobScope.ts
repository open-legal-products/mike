// Per-job Sentry isolation for code that runs outside an HTTP request.
//
// Express gives every request its own isolation scope, so `setOperation` in
// a route handler tags that request alone. A queue worker has no such
// boundary: the DB-queue runner, the BullMQ processors and the upload
// worker loops all run several jobs concurrently in one process, and a tag
// set on the shared scope would land on whichever job fails next. Running
// each job inside its own isolation scope keeps the operation tag and the
// stage breadcrumbs with the job that produced them.

import * as Sentry from "@sentry/node";

/** Run one unit of background work in its own Sentry isolation scope. */
export function runIsolated<T>(work: () => Promise<T>): Promise<T> {
    return Sentry.withIsolationScope(() => work());
}
