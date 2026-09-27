"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Task 54. The per-row "⋮" actions menu in the Explorer tree.
//
// This replaces the inline buttons each row used to carry (Export /
// Delete notebook on a notebook row, Delete discussion on a discussion
// row). Two reasons beyond the task asking for it: the buttons already
// overflowed the sidebar at its default width -- "Delete notebook" was
// visibly clipped -- so a third one was never going to fit, and a row
// full of destructive buttons sitting under the cursor is easy to hit
// by accident while clicking around the tree.
//
// Positioned `fixed` off the trigger's own bounding rect rather than
// absolutely inside the row. The tree lives in a scrollable, resizable
// panel; an absolutely-positioned popup gets clipped by that panel the
// moment a row is near its bottom edge, which is exactly where the
// last notebook in a long list sits. The cost of `fixed` is that the
// menu doesn't follow its row, so any scroll closes it.
//
// Deliberately a plain popup, not a full ARIA menu widget with roving
// focus and type-ahead: role="menu"/"menuitem" plus Escape, outside
// click and focus return covers what this actually is (three buttons),
// and hand-rolling arrow-key focus management is how half-broken
// keyboard traps get shipped.

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  // Destructive items are marked rather than just coloured, so the
  // distinction survives for anyone who can't see the colour.
  destructive?: boolean;
}

export function RowMenu({
  // Names the row this menu belongs to, e.g. "Actions for Alpha" --
  // every row has its own trigger, so an unqualified "Actions" would
  // make them indistinguishable to assistive tech and to tests.
  label,
  items,
}: {
  label: string;
  items: RowMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Before paint, so the menu never renders at 0,0 for a frame first.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    // Right-aligned to the trigger, flipped above it when there isn't
    // room below -- a menu opened from the last row of a full-height
    // tree would otherwise run off the bottom of the window.
    const left = Math.max(
      4,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 4),
    );
    const below = rect.bottom + 2;
    const top =
      below + menuHeight > window.innerHeight - 4
        ? Math.max(4, rect.top - menuHeight - 2)
        : below;
    setPosition({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        // Focus goes back where it came from, rather than to the top of
        // the document, so dismissing a menu doesn't lose the user's
        // place in the tree.
        triggerRef.current?.focus();
      }
    }

    // Capture phase: the tree rows stop propagation on their own
    // handlers, so a bubble-phase listener would miss clicks on them.
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    // See the positioning note above -- a fixed menu can't follow its
    // row, so it closes instead of drifting away from it. Capture
    // phase, because the tree's own scroll container scrolls, not the
    // window.
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          // The row underneath is a tree item that selects on click.
          // Opening its menu must not also switch the active discussion.
          event.stopPropagation();
          setOpen((wasOpen) => !wasOpen);
        }}
        style={{ padding: "2px 6px", lineHeight: 1 }}
      >
        <span aria-hidden="true">⋮</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onClick={(event) => event.stopPropagation()}
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            zIndex: 1100,
            background: "#fff",
            border: "1px solid #999",
            borderRadius: 4,
            padding: 4,
            minWidth: 160,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
              style={{
                textAlign: "left",
                border: "none",
                background: "transparent",
                borderRadius: 3,
                color: item.destructive ? "#a00" : "inherit",
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
