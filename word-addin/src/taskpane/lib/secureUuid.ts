/**
 * Re-export of the shared implementation. The upload-session client mints
 * client ids from `@mike/client`; keeping one implementation means the
 * add-in and the web app cannot drift on the WebView fallback path.
 */
export { createSecureUuid } from "@mike/client";
