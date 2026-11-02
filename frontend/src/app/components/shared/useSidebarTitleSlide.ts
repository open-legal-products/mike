"use client";

import {
    useState,
    useRef,
    type CSSProperties,
    type FocusEvent,
    type MouseEvent,
} from "react";

// Hover slide for titles too long for the row: paced by distance so a long
// title glides at the same unhurried speed as a short one.
const TITLE_SLIDE_MS_PER_PX = 25;
const TITLE_SLIDE_MIN_MS = 800;
const TITLE_SLIDE_BACK_MS = 600;

/** Classes for the sliding title; its parent is the box that clips it. */
export const SIDEBAR_TITLE_SLIDE_CLASS =
    "inline-block transition-transform ease-in-out motion-reduce:transition-none";

/**
 * Slides a History row's clipped title into view on hover and on keyboard
 * focus, so a keyboard user can read it too. The title stays revealed until
 * both have ended; focus from a click does not count, or the opened row would
 * stay slid after the pointer leaves.
 */
export function useSidebarTitleSlide() {
    const titleRef = useRef<HTMLSpanElement>(null);
    const [slide, setSlide] = useState({
        offset: 0,
        duration: TITLE_SLIDE_BACK_MS,
    });

    const reveal = () => {
        const text = titleRef.current;
        const box = text?.parentElement;
        if (!text || !box) return;
        const style = getComputedStyle(box);
        const available =
            box.clientWidth -
            (parseFloat(style.paddingLeft) || 0) -
            (parseFloat(style.paddingRight) || 0);
        const overflow = Math.ceil(text.offsetWidth - available);
        if (overflow <= 0) return;
        setSlide({
            offset: overflow,
            duration: Math.max(
                TITLE_SLIDE_MIN_MS,
                overflow * TITLE_SLIDE_MS_PER_PX,
            ),
        });
    };

    const reset = () => {
        setSlide({ offset: 0, duration: TITLE_SLIDE_BACK_MS });
    };

    const titleStyle: CSSProperties = {
        transform: `translateX(-${slide.offset}px)`,
        transitionDuration: `${slide.duration}ms`,
    };

    /** Spread onto the row's interactive element. */
    const slideHandlers = {
        onMouseEnter: () => reveal(),
        onMouseLeave: (event: MouseEvent<HTMLElement>) => {
            if (!event.currentTarget.matches(":focus-visible")) reset();
        },
        onFocus: (event: FocusEvent<HTMLElement>) => {
            if (event.currentTarget.matches(":focus-visible")) reveal();
        },
        onBlur: (event: FocusEvent<HTMLElement>) => {
            if (!event.currentTarget.matches(":hover")) reset();
        },
    };

    return { titleRef, titleStyle, slideHandlers };
}
