// Facade for the visuals module: static renders of assistant-made visuals.
// Creating and editing visuals lives in the chat engine; storing them in the
// documents module.

export {
    createDocxFromVisual,
    exportVisual,
    visualDocx,
    visualExportCapabilities,
    visualSnapshot,
} from "./visuals.export";
