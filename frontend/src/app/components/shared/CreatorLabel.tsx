import { UserAvatar } from "@/app/components/ui/user-avatar";
import { SkeletonLine } from "./TablePrimitive";

/** A table row's creator: their avatar beside "Me" or their name. */
export function CreatorLabel({
    label,
    photo,
    name,
    email,
}: {
    label: string;
    photo?: string | null;
    name?: string | null;
    email?: string | null;
}) {
    return (
        <span className="flex min-w-0 items-center gap-1.5">
            <UserAvatar size="sm" photo={photo} name={name} email={email} />
            <span className="truncate">{label}</span>
        </span>
    );
}

/** Loading placeholder matching `CreatorLabel`. */
export function CreatorLabelSkeleton({ className }: { className?: string }) {
    return (
        <span className="flex items-center gap-1.5">
            <span className="h-4 w-4 shrink-0 rounded-full bg-gray-100 animate-pulse" />
            <SkeletonLine className={className} />
        </span>
    );
}
