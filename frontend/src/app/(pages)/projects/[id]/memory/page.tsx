"use client";

import { use } from "react";
import { ProjectMemoryView } from "@/app/components/projects/ProjectMemoryView";

export default function ProjectMemoryPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    use(params);
    return <ProjectMemoryView />;
}
