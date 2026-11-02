import Image, { type ImageProps, type StaticImageData } from "next/image";

export type SvgAssetIconProps = Omit<ImageProps, "alt" | "src" | "unoptimized">;

/** Small UI icons load with their labels, using build-hashed, immutable assets. */
export function SvgAssetIcon({
    src,
    className,
    ...props
}: SvgAssetIconProps & { src: StaticImageData }) {
    return (
        <Image
            src={src}
            alt=""
            width={64}
            height={64}
            unoptimized
            loading="eager"
            decoding="sync"
            aria-hidden="true"
            draggable={false}
            className={`${className ?? ""} object-contain`}
            {...props}
        />
    );
}
