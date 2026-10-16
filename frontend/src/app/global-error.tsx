"use client";

// global-error replaces the root layout, so it imports the layout's CSS
// itself; without these the design-system classes below would not apply.
import "./fonts/fonts.css";
import "./globals.css";
import { CrashScreen } from "@/app/components/shared/CrashScreen";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset?: () => void;
}) {
    return (
        <html lang="en">
            <head>
                <title>Something went wrong – Mike</title>
            </head>
            <body className="font-sans antialiased">
                <CrashScreen
                    error={error}
                    reset={reset}
                    component="global-error-boundary"
                    level="fatal"
                    // Back, not Home: the root layout itself failed, so a
                    // client-side link home would render it again.
                    secondaryAction={(tone) => (
                        <PillButtonUI
                            type="button"
                            tone={tone}
                            size="normal"
                            onClick={() => window.history.back()}
                        >
                            Back
                        </PillButtonUI>
                    )}
                />
            </body>
        </html>
    );
}
