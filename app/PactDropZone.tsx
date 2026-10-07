"use client";

import { useEffect, useRef, useState } from "react";

// Task 79, part C. Dropping .pact files from Finder anywhere on the window
// imports them, through the same path as the Import button.
//
// Desktop only: listeners are attached only where the main pointer is a
// mouse or trackpad -- (hover: hover) and (pointer: fine) -- so nothing
// changes on the iPad or any touch device.
//
// It must not get in the way of the composer, which accepts dropped
// images (TipTap FileHandler; it stops the event itself when it takes
// one). So the overlay appears only while the drag carries a file that is
// NOT an image, and the overlay ignores the pointer, so drops still reach
// whatever is underneath. The Explorer tree has no drag-and-drop, and
// drags without files (text, links) are left alone entirely.
//
// A drop of files the composer did not take is always handled here --
// without it the browser would open the file in the tab and leave
// pact-web. Every dropped file goes to the same import run as the Import
// button; a file that is not a .pact is left out there and named in the
// summary ("Not a .pact file, so it was left out.").
export function PactDropZone({
  onFiles,
}: {
  onFiles: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  });

  useEffect(() => {
    if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) {
      return;
    }
    const carriesFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const carriesNonImageFile = (e: DragEvent) =>
      Array.from(e.dataTransfer?.items ?? []).some(
        (item) => item.kind === "file" && !item.type.startsWith("image/"),
      );

    function onDragOver(e: DragEvent) {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // allow the drop (and stop the browser opening the file)
      if (carriesNonImageFile(e)) {
        setOver(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        // dragleave is unreliable across child elements; hide once the
        // drag stops arriving instead.
        hideTimer.current = setTimeout(() => setOver(false), 200);
      }
    }

    function onDrop(e: DragEvent) {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) onFilesRef.current(files);
    }

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (!over) return null;
  return (
    <div
      data-pact-drop-overlay
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        pointerEvents: "none",
        background: "rgba(255, 255, 255, 0.75)",
        border: "3px dashed #888",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "1.4em",
        color: "#333",
      }}
    >
      Drop .pact files to import
    </div>
  );
}
