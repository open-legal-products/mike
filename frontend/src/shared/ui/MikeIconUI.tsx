"use client";

import React, { useId, useSyncExternalStore } from "react";

const DEGREES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const STOP_TRANSITION = "stop-color 220ms ease, stop-opacity 220ms ease";

type IconPalette = {
    fillStops: [string, string, string, string];
    fillOpacities: [number, number, number, number];
    specularStops: [number, number, number, number];
    borderStops: [string, string, string];
    borderOpacities: [number, number, number];
    innerStops: [string, string, string, string];
    innerOpacities: [number, number, number, number];
};

const DEFAULT_PALETTE: IconPalette = {
    fillStops: ["#0a0a0a", "#151515", "#080808", "#111111"],
    fillOpacities: [0.9, 0.8, 0.85, 0.9],
    specularStops: [0.5, 0.2, 0, 0],
    borderStops: ["#ffffff", "#666666", "#ffffff"],
    borderOpacities: [0.3, 0.1, 0.2],
    innerStops: ["#ffffff", "#777777", "#222222", "#ffffff"],
    innerOpacities: [0, 0.08, 0.05, 0],
};

const DONE_PALETTE: IconPalette = {
    fillStops: ["#4ade80", "#86efac", "#22c55e", "#bbf7d0"],
    fillOpacities: [0.95, 0.88, 0.9, 0.94],
    specularStops: [0.68, 0.32, 0.03, 0],
    borderStops: ["#f0fdf4", "#86efac", "#dcfce7"],
    borderOpacities: [0.42, 0.24, 0.3],
    innerStops: ["#ffffff", "#dcfce7", "#4ade80", "#ffffff"],
    innerOpacities: [0, 0.16, 0.08, 0],
};

const ERROR_PALETTE: IconPalette = {
    fillStops: ["#f87171", "#fca5a5", "#ef4444", "#fecaca"],
    fillOpacities: [0.95, 0.88, 0.9, 0.94],
    specularStops: [0.68, 0.32, 0.03, 0],
    borderStops: ["#fef2f2", "#fca5a5", "#fee2e2"],
    borderOpacities: [0.42, 0.24, 0.3],
    innerStops: ["#ffffff", "#fee2e2", "#f87171", "#ffffff"],
    innerOpacities: [0, 0.16, 0.08, 0],
};

// The dark mark, inverted for dark surfaces: white glass blades, with the
// depth cues (inner shading, hairline border) darkened instead of lightened
// so overlapping blades stay readable against a dark background.
const WHITE_PALETTE: IconPalette = {
    fillStops: ["#ffffff", "#eef2f7", "#f8fafc", "#ffffff"],
    fillOpacities: [0.95, 0.85, 0.9, 0.95],
    specularStops: [0.7, 0.3, 0, 0],
    borderStops: ["#0f172a", "#475569", "#0f172a"],
    borderOpacities: [0.28, 0.12, 0.18],
    innerStops: ["#0f172a", "#334155", "#e2e8f0", "#0f172a"],
    innerOpacities: [0, 0.1, 0.06, 0],
};

// The mark is inline SVG, so the neutral-palette dark remapping in
// globals.css cannot reach it; it watches the document theme class itself.
// One observer serves every icon on the page. Targets that never set the
// class (the Word add-in) always read false and keep the dark mark.
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeToTheme(listener: () => void): () => void {
    themeListeners.add(listener);
    if (!themeObserver && typeof MutationObserver !== "undefined") {
        themeObserver = new MutationObserver(() => {
            themeListeners.forEach((notify) => notify());
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class"],
        });
    }

    return () => {
        themeListeners.delete(listener);
        if (themeListeners.size === 0) {
            themeObserver?.disconnect();
            themeObserver = null;
        }
    };
}

function readDarkTheme(): boolean {
    return (
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark")
    );
}

function readDarkThemeOnServer(): boolean {
    return false;
}

function useDarkTheme(): boolean {
    return useSyncExternalStore(
        subscribeToTheme,
        readDarkTheme,
        readDarkThemeOnServer,
    );
}

function GlassGradient({
    offsets,
    colors,
    opacities,
    ...props
}: React.SVGProps<SVGLinearGradientElement> & {
    offsets: number[];
    colors: string | string[];
    opacities: number[];
}) {
    return (
        <linearGradient {...props}>
            {offsets.map((offset, index) => (
                <stop
                    key={offset}
                    offset={`${offset}%`}
                    style={{
                        stopColor: typeof colors === "string" ? colors : colors[index],
                        stopOpacity: opacities[index],
                        transition: STOP_TRANSITION,
                    }}
                />
            ))}
        </linearGradient>
    );
}

function Blades({ ids }: { ids: Record<string, string> }) {
    return (
        <g transform="translate(250, 250)">
            {DEGREES.map((deg) => (
                <g key={deg} transform={`rotate(${deg})`}>
                    <use
                        href={`#${ids.blade}`}
                        fill={`url(#${ids.glassFill})`}
                    />
                    <use
                        href={`#${ids.blade}`}
                        fill={`url(#${ids.innerLight})`}
                    />
                    <use
                        href={`#${ids.blade}`}
                        fill={`url(#${ids.specular})`}
                        clipPath={`url(#${ids.topClip})`}
                    />
                    <use
                        href={`#${ids.blade}`}
                        fill="none"
                        stroke={`url(#${ids.glassBorder})`}
                        strokeWidth="0.8"
                    />
                </g>
            ))}
        </g>
    );
}

export function MikeIcon({
    spin = false,
    done = false,
    error = false,
    mike = false,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    mike?: boolean;
    size?: number;
    style?: React.CSSProperties;
}) {
    void mike;
    const id = useId().replace(/:/g, "");
    const darkTheme = useDarkTheme();
    const palette = error
        ? ERROR_PALETTE
        : done
          ? DONE_PALETTE
          : darkTheme
            ? WHITE_PALETTE
            : DEFAULT_PALETTE;
    const m = {
        glassFill: `${id}-m-glassFill`,
        specular: `${id}-m-specular`,
        glassBorder: `${id}-m-glassBorder`,
        innerLight: `${id}-m-innerLight`,
        topClip: `${id}-m-topClip`,
        blade: `${id}-m-blade`,
    };

    return (
        <span
            className="shrink-0 inline-block animate-[spin_3s_linear_infinite]"
            style={{
                animationPlayState: spin ? "running" : "paused",
                ...style,
            }}
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="100 100 300 300"
                width={size}
                height={size}
                style={{ display: "block" }}
            >
                <defs>
                    <GlassGradient
                        id={m.glassFill}
                        x1="0%" y1="0%" x2="100%" y2="100%"
                        offsets={[0, 30, 70, 100]}
                        colors={palette.fillStops}
                        opacities={palette.fillOpacities}
                    />
                    <GlassGradient
                        id={m.specular}
                        x1="0%" y1="0%" x2="0%" y2="100%"
                        offsets={[0, 15, 35, 100]}
                        colors="#ffffff"
                        opacities={palette.specularStops}
                    />
                    <GlassGradient
                        id={m.glassBorder}
                        x1="0%" y1="0%" x2="0%" y2="100%"
                        offsets={[0, 50, 100]}
                        colors={palette.borderStops}
                        opacities={palette.borderOpacities}
                    />
                    <GlassGradient
                        id={m.innerLight}
                        x1="100%" y1="0%" x2="0%" y2="100%"
                        offsets={[0, 40, 60, 100]}
                        colors={palette.innerStops}
                        opacities={palette.innerOpacities}
                    />
                    <clipPath id={m.topClip}>
                        <rect x="30" y="-25" width="130" height="23" />
                    </clipPath>
                    <path
                        id={m.blade}
                        d="M 40,0 A 4,4 0 0 1 43,-3 Q 95,-22 147,-3 A 4,4 0 0 1 150,0 A 4,4 0 0 1 147,3 Q 95,22 43,3 A 4,4 0 0 1 40,0 Z"
                    />
                </defs>

                <Blades ids={m} />
            </svg>
        </span>
    );
}
