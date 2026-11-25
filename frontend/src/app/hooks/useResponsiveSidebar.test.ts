import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    sidebarWidthTier,
    useResponsiveSidebar,
} from "./useResponsiveSidebar";

function setWidth(width: number) {
    Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: width,
    });
}

function resizeTo(width: number) {
    act(() => {
        setWidth(width);
        window.dispatchEvent(new Event("resize"));
    });
}

describe("sidebarWidthTier", () => {
    it("is a drawer on a phone, icons on a middle window and full above", () => {
        expect(sidebarWidthTier(767)).toBe("drawer");
        expect(sidebarWidthTier(768)).toBe("rail");
        expect(sidebarWidthTier(1023)).toBe("rail");
        expect(sidebarWidthTier(1024)).toBe("full");
    });
});

describe("useResponsiveSidebar", () => {
    const initialWidth = window.innerWidth;
    beforeEach(() => {
        localStorage.clear();
        setWidth(1280);
    });
    afterEach(() => setWidth(initialWidth));

    it("opens on a wide window and starts collapsed on a middle one or a phone", () => {
        expect(renderHook(() => useResponsiveSidebar()).result.current.isOpen).toBe(true);
        setWidth(900);
        expect(renderHook(() => useResponsiveSidebar()).result.current.isOpen).toBe(false);
        setWidth(500);
        expect(renderHook(() => useResponsiveSidebar()).result.current.isOpen).toBe(false);
    });

    it("collapses an open sidebar when the window narrows past the middle width, and opens it again when it widens", () => {
        const { result } = renderHook(() => useResponsiveSidebar());
        resizeTo(1000);
        expect(result.current.isOpen).toBe(false);
        resizeTo(1100);
        expect(result.current.isOpen).toBe(true);
    });

    it("keeps a sidebar the person collapsed collapsed when the window widens again", () => {
        const { result } = renderHook(() => useResponsiveSidebar());
        act(() => result.current.toggle());
        expect(result.current.isOpen).toBe(false);
        resizeTo(900);
        resizeTo(1300);
        expect(result.current.isOpen).toBe(false);
        expect(localStorage.getItem("sidebarOpen")).toBe("false");
    });

    it("can be opened by hand on a middle window, without changing the choice for wide ones", () => {
        const { result } = renderHook(() => useResponsiveSidebar());
        act(() => result.current.toggle()); // collapsed by choice
        resizeTo(900);
        act(() => result.current.toggle());
        expect(result.current.isOpen).toBe(true);
        // Resizing within the middle widths leaves it open.
        resizeTo(950);
        expect(result.current.isOpen).toBe(true);
        // Wider again, the choice holds.
        resizeTo(1200);
        expect(result.current.isOpen).toBe(false);
        expect(localStorage.getItem("sidebarOpen")).toBe("false");
    });

    it("closes on a phone, and a page can close it there but not open it", () => {
        const { result } = renderHook(() => useResponsiveSidebar());
        resizeTo(500);
        expect(result.current.isOpen).toBe(false);
        act(() => result.current.setOpen(true));
        expect(result.current.isOpen).toBe(false);
        act(() => result.current.toggle());
        expect(result.current.isOpen).toBe(true);
        act(() => result.current.setOpen(false));
        expect(result.current.isOpen).toBe(false);
    });

    it("lets a page take the room on a wide window, remembering it", () => {
        const { result } = renderHook(() => useResponsiveSidebar());
        act(() => result.current.setOpen(false));
        expect(result.current.isOpen).toBe(false);
        resizeTo(900);
        resizeTo(1200);
        expect(result.current.isOpen).toBe(false);
    });
});
