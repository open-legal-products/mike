// The product name the Word add-in shows, baked in at build time by webpack's
// EnvironmentPlugin (REACT_APP_APP_NAME). Unset or blank keeps Mike's name.

const configuredName = process.env.REACT_APP_APP_NAME?.trim();

/** The product name shown in the task pane. */
export const APP_NAME = configuredName ? configuredName : "Mike";
