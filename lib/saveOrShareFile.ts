// Task 100. The last step of both tree exports (notebook .pact and
// discussion markdown): hand a ready-made file to the person.
//
// On an iPad or iPhone it opens the system share sheet with the file
// attached, so "Save to Files" is one tap instead of Chrome's
// "Save…" / "Save in…" detour. Everywhere else -- the Mac above all,
// where the Task 90 helper picks .pact files up from Downloads -- it does
// exactly what both exports did before: a hidden download link.
//
// Browser-only (navigator, document, URL.createObjectURL).

export type SaveOrShareOutcome = "shared" | "cancelled" | "downloaded";

// The share sheet is for Apple touch devices only. Safari on the Mac and
// Chrome 128+ on desktops can share files too, so canShare alone would
// change the Mac; this check keeps it on the download. iPadOS reports
// itself as a Mac, so an iPad is "Macintosh" plus a touch screen (a Mac
// reports 0 touch points).
export function isAppleTouchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1;
}

function canShareFile(file: File): boolean {
  if (typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Resolves with what happened; rejects only for a share that failed after
// the sheet was asked for (the caller shows its usual "Failed to export"
// message).
export async function saveOrShareFile(file: File): Promise<SaveOrShareOutcome> {
  if (isAppleTouchDevice() && canShareFile(file)) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      // The person closed the sheet. Nothing is saved, nothing is said,
      // and no download follows -- that would save behind their back.
      if (name === "AbortError") return "cancelled";
      // Refused before any sheet appeared: the tap went stale while the
      // export was fetched (WebKit allows about 5 s), or the file was
      // rejected after all. Falling back can't save twice.
      if (name !== "NotAllowedError" && !(error instanceof TypeError)) {
        throw error;
      }
    }
  }
  downloadFile(file);
  return "downloaded";
}
