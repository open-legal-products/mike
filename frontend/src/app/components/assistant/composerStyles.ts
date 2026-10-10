/**
 * The round black send button of the chat composer, without its size. Shared
 * so every place that sends something into the chat uses the same control.
 */
export const COMPOSER_SEND_BUTTON_CLASS =
    "relative flex cursor-pointer items-center justify-center rounded-full border-0 bg-gradient-to-b from-neutral-700 to-black text-white transition-all duration-150 active:enabled:scale-95 disabled:from-neutral-600 disabled:to-black shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)]";
