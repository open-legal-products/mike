interface SambanovaLogoProps {
    variant?: "icon-only" | "full";
    size?: number;
    className?: string;
}

const ICON_ASPECT_RATIO = 52.416 / 46.208;
const FULL_LOGO_ASPECT_RATIO = 210 / 46;

export function SambanovaLogo({
    variant = "icon-only",
    size = 24,
    className = "",
}: SambanovaLogoProps) {
    const aspectRatio =
        variant === "full" ? FULL_LOGO_ASPECT_RATIO : ICON_ASPECT_RATIO;
    const width = Math.round(size * aspectRatio);

    return (
        <img
            src={variant === "full" ? "/sambanova-logo.svg" : "/sambanova-icon.svg"}
            alt="SambaNova"
            width={width}
            height={size}
            className={className}
            style={{ display: "block" }}
        />
    );
}