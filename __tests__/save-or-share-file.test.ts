// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isAppleTouchDevice, saveOrShareFile } from "@/lib/saveOrShareFile";

// Task 100. Both tree exports end here. jsdom has neither a share sheet
// nor object URLs, so navigator.share/canShare and the anchor click are
// stubbed; the decisions are the real code.

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPAD_DESKTOP_MODE = MAC_SAFARI; // iPadOS asks for desktop sites
const IPAD_CHROME =
  "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

let clicked: HTMLAnchorElement[] = [];
let share: ReturnType<typeof vi.fn>;
let canShare: ReturnType<typeof vi.fn>;

function device(userAgent: string, maxTouchPoints: number) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    get: () => maxTouchPoints,
  });
}

function pactFile() {
  return new File(['{"version":1}'], "T100.pact", {
    type: "application/json",
  });
}

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  URL.createObjectURL = vi.fn(() => "blob:fake/1");
  URL.revokeObjectURL = vi.fn();
  share = vi.fn(async () => undefined);
  canShare = vi.fn(() => true);
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: share,
  });
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: canShare,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("which devices get the share sheet", () => {
  test.each([
    ["iPad in desktop mode", IPAD_DESKTOP_MODE, 5, true],
    ["iPad Chrome", IPAD_CHROME, 5, true],
    ["iPhone Chrome", IPHONE_CHROME, 5, true],
    ["Mac Safari", MAC_SAFARI, 0, false],
    ["Mac Chrome", MAC_CHROME, 0, false],
    ["Windows touch laptop", WINDOWS_CHROME, 10, false],
  ])("%s → %s", (_label, userAgent, touchPoints, expected) => {
    device(userAgent, touchPoints);
    expect(isAppleTouchDevice()).toBe(expected);
  });
});

describe("on the Mac and other desktops", () => {
  // Mac Safari and Chrome 128+ can share files, so this is the case that
  // keeps the Mac on today's download.
  test("downloads, even though the browser could share", async () => {
    device(MAC_SAFARI, 0);
    expect(await saveOrShareFile(pactFile())).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("T100.pact");
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  test("a Windows touch laptop downloads too", async () => {
    device(WINDOWS_CHROME, 10);
    expect(await saveOrShareFile(pactFile())).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
  });
});

describe("on an iPad", () => {
  beforeEach(() => device(IPAD_DESKTOP_MODE, 5));

  test("opens the share sheet with the file, and does not download", async () => {
    const file = pactFile();
    expect(await saveOrShareFile(file)).toBe("shared");
    expect(share).toHaveBeenCalledWith({ files: [file] });
    expect(share.mock.calls[0][0].files[0].name).toBe("T100.pact");
    expect(clicked).toHaveLength(0);
  });

  test("Cancel does nothing: no download, no error", async () => {
    share.mockRejectedValue(new DOMException("cancelled", "AbortError"));
    expect(await saveOrShareFile(pactFile())).toBe("cancelled");
    expect(clicked).toHaveLength(0);
  });

  test("a stale tap (NotAllowedError) falls back to the download", async () => {
    share.mockRejectedValue(new DOMException("no gesture", "NotAllowedError"));
    expect(await saveOrShareFile(pactFile())).toBe("downloaded");
    expect(clicked).toHaveLength(1);
  });

  test("a file the sheet rejects (TypeError) falls back to the download", async () => {
    share.mockRejectedValue(new TypeError("unsupported"));
    expect(await saveOrShareFile(pactFile())).toBe("downloaded");
    expect(clicked).toHaveLength(1);
  });

  test("canShare saying no means the download", async () => {
    canShare.mockReturnValue(false);
    expect(await saveOrShareFile(pactFile())).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
  });

  test("an older iPad without canShare downloads", async () => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: undefined,
    });
    expect(await saveOrShareFile(pactFile())).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
  });

  test("any other share failure is passed on, and nothing downloads", async () => {
    share.mockRejectedValue(new DOMException("target failed", "DataError"));
    await expect(saveOrShareFile(pactFile())).rejects.toThrow("target failed");
    expect(clicked).toHaveLength(0);
  });
});
