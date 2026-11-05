// Public surface of @mike/client: the client-side behavior the web app and the
// Word add-in share that has nothing to do with rendering. Consumers import
// from "@mike/client" only; a file in this directory that is not re-exported
// here is internal to the package.
//
// Everything here is framework-free: no React (type-only imports excepted),
// no DOM at module scope, no application imports. Playwright loads this
// package directly in Node for the add-in's end-to-end tests.

// Failure classification and presentation
export * from "./userError";
export * from "./toastStore";
export * from "./errorNotifier";

// Model catalog shared by both pickers
export * from "./modelCatalog";

// Uploads
export * from "./uploadSessionClient";
export * from "./settleWithConcurrency";
export * from "./secureUuid";

// Response excerpts (quote-and-annotate wire format)
export * from "./messageExcerpts";

// Sentry event hygiene
export * from "./sentryEvent";
export * from "./sentryPrivacy";
