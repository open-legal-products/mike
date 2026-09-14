import type { Metadata } from "next";
import { Inter, EB_Garamond } from "next/font/google";
import "./globals.css";
import { Providers } from "@/app/components/providers";

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
    metadataBase: new URL("https://app.mikeoss.com"),
    title: "SambaNova Legal",
    description:
        "AI-powered legal document analysis and contract review platform, powered by SambaNova.",
    icons: {
        icon: [
            { url: "/sambanova-icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/sambanova-icon.svg",
    },
    openGraph: {
        type: "website",
        url: "https://app.mikeoss.com",
        siteName: "SambaNova Legal",
        title: "SambaNova Legal",
        description:
            "AI-powered legal document analysis and contract review platform, powered by SambaNova.",
        images: [
            {
                url: "/sambanova-logo.svg",
                width: 1200,
                height: 651,
                alt: "SambaNova Legal",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "SambaNova Legal",
        description:
            "AI-powered legal document analysis and contract review platform, powered by SambaNova.",
        images: ["/sambanova-logo.svg"],
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
                className={`${inter.variable} ${ebGaramond.variable} font-sans antialiased`}
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
