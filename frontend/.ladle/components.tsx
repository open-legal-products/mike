import { useEffect } from "react";
import { type GlobalProvider, ThemeState } from "@ladle/react";
import "./ladle.css";

/**
 * Mike's dark mode is class-based — `@custom-variant dark (&:is(.dark *))` in
 * globals.css — and the app sets `.dark` on the document root from the
 * Settings > Appearance preference. Ladle's theme toggle only flips its own
 * global state, so it has to drive the same class or every dark-mode token in
 * the catalog stays on its light value.
 *
 * `ladle-canvas` is plain CSS in ladle.css, not Tailwind: this file sits in a
 * dot-directory, which Tailwind v4 does not scan. See ladle.css.
 */
export const Provider: GlobalProvider = ({ children, globalState }) => {
    useEffect(() => {
        document.documentElement.classList.toggle(
            "dark",
            globalState.theme === ThemeState.Dark,
        );
    }, [globalState.theme]);

    return <div className="ladle-canvas">{children}</div>;
};
