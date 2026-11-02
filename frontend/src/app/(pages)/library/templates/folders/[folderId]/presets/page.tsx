"use client";

import { use } from "react";
import { PresetTemplatesPage } from "@/app/components/library/PresetTemplatesPage";

interface Props {
    params: Promise<{ folderId: string }>;
}

export default function LibraryTemplateFolderPresetsPage({ params }: Props) {
    const { folderId } = use(params);
    return <PresetTemplatesPage folderId={folderId} />;
}
