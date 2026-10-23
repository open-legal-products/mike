import type { Metadata } from "next";
// Self-hosted Inter and EB Garamond; sets --font-inter and --font-eb-garamond.
import "./fonts/fonts.css";
import "./globals.css";
import { Providers } from "@/app/components/providers";
import {
    APP_DESCRIPTION,
    APP_NAME,
    APP_TAGLINE,
    APP_URL,
    appTitle,
} from "@/shared/lib/branding";

export const metadata: Metadata = {
    metadataBase: new URL(APP_URL),
    title: appTitle(APP_TAGLINE),
    description: APP_DESCRIPTION,
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: APP_URL,
        siteName: APP_NAME,
        title: appTitle(APP_TAGLINE),
        description: APP_DESCRIPTION,
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: APP_NAME,
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: appTitle(APP_TAGLINE),
        description: APP_DESCRIPTION,
        images: ["/link-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className="font-sans antialiased"
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
