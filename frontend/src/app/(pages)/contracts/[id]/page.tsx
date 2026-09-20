"use client";

import { use } from "react";
import { ReviewWorkspace } from "@/app/components/contracts/ReviewWorkspace";

export default function ContractReviewPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = use(params);
    return <ReviewWorkspace reviewId={id} />;
}
