import { SvgAssetIcon, type SvgAssetIconProps } from "@/app/components/ui/svg-asset-icon";
import folderClosed from "../../../../public/icons/file-system/folder-closed.svg";
import folderOpen from "../../../../public/icons/file-system/folder-open.svg";
import projectClosed from "../../../../public/icons/file-system/project-closed.svg";
import projectOpened from "../../../../public/icons/file-system/project-opened.svg";

type FolderSvgIconProps = Omit<SvgAssetIconProps, "width" | "height">;

const icons = {
    "folder-closed": folderClosed,
    "folder-open": folderOpen,
    "project-closed": projectClosed,
    "project-opened": projectOpened,
};

type FolderStateIconProps = FolderSvgIconProps & { open?: boolean };

function FolderSvgIcon({ name, ...props }: FolderSvgIconProps & { name: keyof typeof icons }) {
    return <SvgAssetIcon src={icons[name]} {...props} />;
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
