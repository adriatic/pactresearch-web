import { describe, expect, test } from "vitest";
import { buildInfoFrom } from "@/lib/buildInfo";

const SHA = "6b649df1234567890abcdef1234567890abcdef1";

describe("buildInfoFrom", () => {
  test("production shows the environment and the short sha", () => {
    const info = buildInfoFrom({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: SHA,
      VERCEL_GIT_REPO_OWNER: "adriatic",
      VERCEL_GIT_REPO_SLUG: "pactresearch-web",
    });
    expect(info.label).toBe("Production · 6b649df");
    expect(info.shortSha).toBe("6b649df");
    expect(info.fullSha).toBe(SHA);
    expect(info.commitUrl).toBe(
      `https://github.com/adriatic/pactresearch-web/commit/${SHA}`,
    );
  });

  // Both environments go through the same path -- the task was explicit
  // that neither should be special-cased.
  test("preview is handled identically, with its own sha", () => {
    const info = buildInfoFrom({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "abcdef01234567890",
      VERCEL_GIT_REPO_OWNER: "adriatic",
      VERCEL_GIT_REPO_SLUG: "pactresearch-web",
    });
    expect(info.label).toBe("Preview · abcdef0");
    expect(info.environment).toBe("preview");
    expect(info.commitUrl).toContain("/commit/abcdef01234567890");
  });

  // The failure the task called out by name: a placeholder must not
  // quietly stand in for a real value.
  test("on Vercel with no sha it reads as broken, not as a plausible build", () => {
    const info = buildInfoFrom({ VERCEL_ENV: "production" });
    expect(info.label).toBe("Production · unknown build");
    expect(info.shortSha).toBeNull();
    expect(info.commitUrl).toBeNull();
    // Must not invent something that looks like a commit.
    expect(info.label).not.toMatch(/[0-9a-f]{7}/);
  });

  test("off Vercel it says so rather than claiming an environment", () => {
    const info = buildInfoFrom({});
    expect(info.label).toBe("Local dev");
    expect(info.environment).toBeNull();
  });

  test("a local build with a sha available still shows it", () => {
    const info = buildInfoFrom({ VERCEL_GIT_COMMIT_SHA: SHA });
    expect(info.label).toBe("Local · 6b649df");
    // No repo coordinates, so no link -- but the text still stands.
    expect(info.commitUrl).toBeNull();
  });

  test("no link when repo coordinates are missing, but the label survives", () => {
    const info = buildInfoFrom({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: SHA,
    });
    expect(info.label).toBe("Preview · 6b649df");
    expect(info.commitUrl).toBeNull();
  });

  test("an empty-string sha is treated as absent, not as a build named ''", () => {
    const info = buildInfoFrom({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "",
    });
    expect(info.label).toBe("Production · unknown build");
  });
});
