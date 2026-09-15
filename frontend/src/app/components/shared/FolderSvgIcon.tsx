import Image, { type ImageProps } from "next/image";

type FolderSvgIconProps = Omit<
    ImageProps,
    "alt" | "src" | "width" | "height" | "unoptimized"
>;

type FolderIconName =
    | "folder-closed"
    | "folder-open"
    | "project-closed"
    | "project-opened";

type FolderStateIconProps = FolderSvgIconProps & {
    open?: boolean;
};

const FOLDER_ICON_VERSION = "20";
const FOLDER_ICON_BASE_PATH = "/icons/file-system";

function FolderSvgIcon({
    name,
    className,
    ...props
}: FolderSvgIconProps & { name: FolderIconName }) {
    return (
        <Image
            src={`${FOLDER_ICON_BASE_PATH}/${name}.svg?v=${FOLDER_ICON_VERSION}`}
            alt=""
            width={64}
            height={64}
            unoptimized
            aria-hidden="true"
            draggable={false}
            className={`${className ?? ""} object-contain`}
            {...props}
        />
    );
}

function ClosedSubfolderSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon name="folder-closed" {...props} />;
}

function OpenSubfolderSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon name="folder-open" {...props} />;
}

export function SubfolderSvgIcon({
    open = false,
    ...props
}: FolderStateIconProps) {
    return open ? (
        <OpenSubfolderSvgIcon {...props} />
    ) : (
        <ClosedSubfolderSvgIcon {...props} />
    );
}

export function ClosedProjectSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon name="project-closed" {...props} />;
}

export function OpenProjectSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon name="project-opened" {...props} />;
}

export function ProjectSvgIcon({
    open = false,
    ...props
}: FolderStateIconProps) {
    return open ? (
        <OpenProjectSvgIcon {...props} />
    ) : (
        <ClosedProjectSvgIcon {...props} />
    );
}

export function ClosedFolderSvgIcon(props: FolderSvgIconProps) {
    return <ClosedSubfolderSvgIcon {...props} />;
}
