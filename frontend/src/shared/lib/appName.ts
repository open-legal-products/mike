// The product name, for code the web app and the Word add-in share (such as
// userError.ts). Framework-free: each build substitutes NEXT_PUBLIC_APP_NAME
// at build time, Next.js from the environment and the add-in's webpack from
// its own REACT_APP_APP_NAME, so the web app never picks up an add-in
// variable. Unset or blank keeps Mike's name.

const configuredName = (process.env.NEXT_PUBLIC_APP_NAME || "").trim();

/** The product name shown in the interface. */
export const APP_NAME = configuredName ? configuredName : "Mike";
