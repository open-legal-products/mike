// Public surface of @mike/ui: the React primitives the web app and the Word
// add-in render in common. Consumers import from "@mike/ui" only; a file in
// this directory that is not re-exported here is internal to the package.
//
// Every component is framework-light (React, lucide-react, clsx,
// tailwind-merge, Radix dropdown) and may depend on @mike/client, never on an
// application. docs/design-system.md describes how to add one.

// Liquid-glass surfaces and class-name constants
export * from "./LiquidGlassUI";
export * from "./AuthStylesUI";
export * from "./ComposerSendButtonUI.styles";

// Buttons and pills
export * from "./PillButtonUI.styles";
export * from "./PillButtonUI";
export * from "./TextButtonUI.styles";
export * from "./TextButtonUI";
export * from "./TabPillButtonUI";
export * from "./GlassIconButtonUI";
export * from "./HeaderButtonsUI";
export * from "./CloseButton";
export * from "./ToggleSwitchUI";

// Inputs
export * from "./InputUI";
export * from "./dropdown";
export * from "./ModelToggleUI";
export * from "./WorkflowSlashCommandUI";
export * from "./ChatHistoryDropdownUI";

// Surfaces and cards
export * from "./GlassCardUI";
export * from "./TextCardUI";
export * from "./TextSlabUI";
export * from "./NoticeCardUI";
export * from "./ModalUI";
export * from "./ToastUI";

// Assistant message blocks
export * from "./EditCardUI";
export * from "./EditCardsSectionUI";
export * from "./PreResponseWrapperUI";
export * from "./DocumentEventBlocksUI";
export * from "./CitationPillUI";
export * from "./ExcerptPillUI";
export * from "./ExcerptModalUI";
export * from "./ResponseSelectionMenuUI";
export * from "./PlaybookPillUI";
export * from "./useReasoningDisclosure";

// Brand and auth
export * from "./MikeIconUI";
export * from "./GoogleIconUI";
export * from "./AuthDividerUI";
