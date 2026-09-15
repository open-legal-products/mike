"use client";

import { useEffect, useRef, useState } from "react";
import type { Project } from "@/app/components/shared/types";
import { listProjects } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

export function useProjectPicker() {
    const [open, setOpen] = useState(false);
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const loadingRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    async function openPicker() {
        setOpen(true);
        setError(null);
        if (projects !== null || loadingRef.current) return;
        loadingRef.current = true;
        setLoading(true);
        try {
            const loaded = await listProjects();
            if (mountedRef.current) setProjects(loaded);
        } catch (error) {
            if (!mountedRef.current) return;
            setOpen(false);
            setError(
                userFacingApiError(
                    error,
                    "Projects could not be loaded. Please try again.",
                ),
            );
        } finally {
            loadingRef.current = false;
            if (mountedRef.current) setLoading(false);
        }
    }

    return {
        open,
        projects,
        selectedId,
        setSelectedId,
        loading,
        error,
        openPicker,
        closePicker: () => setOpen(false),
        clearError: () => setError(null),
    };
}
