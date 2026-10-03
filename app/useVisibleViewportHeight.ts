"use client";

import { useEffect } from "react";

// Task 75. Keeps the workspace sized to what is actually visible, and the
// document unscrolled, while an on-screen keyboard is up.
//
// On iPadOS the software keyboard overlays the page: neither 100vh nor
// 100dvh changes when it opens -- only window.visualViewport shrinks. A
// workspace fixed at 100vh therefore stays taller than the visible area,
// WebKit scrolls the whole document to make room for the keyboard, and
// because every outer container is overflow: hidden there is nothing the
// user can drag to scroll it back. Nik's capture showed exactly that:
// <body> at y -159, the 758px workspace minus the 599px left visible.
//
// So this publishes the visible height as --visible-height on <html>
// (Workspace sizes its root Group from it, falling back to 100dvh before
// this runs or where visualViewport is missing), and puts any document
// scroll back to the top whenever the visual viewport changes or focus
// leaves a field. A CSS variable rather than React state: the keyboard
// animates through many resize events, and none of them needs a render.
//
// On a desktop browser visualViewport.height * scale is the window's own
// height, so the layout comes out the same as 100vh did.
export function useVisibleViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;

    function sync() {
      // * scale: pinch-zoom shrinks visualViewport.height without any less
      // of the page being on screen, and must not shrink the layout.
      root.style.setProperty(
        "--visible-height",
        `${Math.round(vv!.height * vv!.scale)}px`,
      );
      // Not while pinch-zoomed: there the visual viewport pans over the
      // page on purpose, and snapping it back would fight the user.
      if (Math.abs(vv!.scale - 1) < 0.01 && window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    }

    // focusout: blurring the composer closes the keyboard, and WebKit can
    // finish its own scroll after the last resize event. One frame later
    // catches that.
    function syncNextFrame() {
      requestAnimationFrame(sync);
    }

    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    document.addEventListener("focusout", syncNextFrame);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      document.removeEventListener("focusout", syncNextFrame);
      root.style.removeProperty("--visible-height");
    };
  }, []);
}
