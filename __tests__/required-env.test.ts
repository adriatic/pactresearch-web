import { describe, expect, test } from "vitest";
import {
  ENCRYPTION_KEY_BYTES,
  encryptionSecretProblem,
  findEnvProblems,
  formatEnvProblems,
  OPTIONAL_ENV_VARS,
  PRODUCTION_SUPABASE_PUBLISHABLE_KEY,
  PRODUCTION_SUPABASE_REF,
  REQUIRED_ENV_VARS,
} from "@/lib/requiredEnv";

const GOOD_SECRET = Buffer.alloc(ENCRYPTION_KEY_BYTES, 7).toString("base64");

function completeEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOiJIUzI1NiJ9.fake.fake",
    API_KEY_ENCRYPTION_SECRET: GOOD_SECRET,
  };
}

describe("what counts as required", () => {
  test("a fully configured environment has no problems", () => {
    expect(findEnvProblems(completeEnv())).toEqual([]);
  });

  // The list is the deliverable, so it is asserted rather than trusted.
  // Adding a variable to it is a deliberate act that has to be made here
  // too -- which is the moment to ask whether it is REQUIRED or merely
  // used.
  test("exactly these three are enforced", () => {
    expect(REQUIRED_ENV_VARS.map((v) => v.name)).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "API_KEY_ENCRYPTION_SECRET",
    ]);
  });

  test("every required variable explains what breaks without it", () => {
    for (const variable of REQUIRED_ENV_VARS) {
      expect(variable.why.length).toBeGreaterThan(20);
    }
  });

  // The brief's "don't wrongly fail environments that intentionally omit
  // optional vars". Analytics and Vercel's system variables are absent
  // on a developer's machine by design.
  test("optional variables are not enforced, even all of them missing", () => {
    const env = completeEnv();
    for (const optional of OPTIONAL_ENV_VARS) {
      expect(REQUIRED_ENV_VARS.map((v) => v.name)).not.toContain(optional.name);
    }
    expect(findEnvProblems(env)).toEqual([]);
  });

  test("unrelated variables present in .env.local are not enforced", () => {
    // These sit in a real .env.local but no application code reads them.
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "STRIPE_SECRET_KEY",
      "RESEND_API_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(REQUIRED_ENV_VARS.map((v) => v.name)).not.toContain(name);
    }
  });
});

describe("absent values", () => {
  test("a missing variable is reported by name", () => {
    const env = completeEnv();
    delete env.API_KEY_ENCRYPTION_SECRET;
    expect(findEnvProblems(env)).toEqual([
      expect.objectContaining({
        name: "API_KEY_ENCRYPTION_SECRET",
        detail: "missing",
      }),
    ]);
  });

  test("an empty string counts as missing", () => {
    const env = { ...completeEnv(), API_KEY_ENCRYPTION_SECRET: "" };
    expect(findEnvProblems(env)[0].name).toBe("API_KEY_ENCRYPTION_SECRET");
  });

  // A variable set to a space in a dashboard is one someone meant to
  // set and did not.
  test("whitespace counts as missing", () => {
    const env = { ...completeEnv(), NEXT_PUBLIC_SUPABASE_URL: "   " };
    expect(findEnvProblems(env)[0]).toMatchObject({
      name: "NEXT_PUBLIC_SUPABASE_URL",
      detail: "missing",
    });
  });

  test("several missing variables are all reported, not just the first", () => {
    expect(findEnvProblems({}).map((p) => p.name)).toEqual(
      REQUIRED_ENV_VARS.map((v) => v.name),
    );
  });
});

// Present-but-wrong fails exactly as opaquely as absent, and is a real
// case: `vercel env pull` writes an 11-character placeholder for
// Secret-type variables, which nearly got read as a corrupted secret.
describe("present but unusable values", () => {
  test("a secret that is not 32 bytes is rejected, saying the length", () => {
    const env = {
      ...completeEnv(),
      API_KEY_ENCRYPTION_SECRET: Buffer.alloc(16, 1).toString("base64"),
    };
    const [problem] = findEnvProblems(env);
    expect(problem.name).toBe("API_KEY_ENCRYPTION_SECRET");
    expect(problem.detail).toContain("got 16");
  });

  test("the 11-character placeholder shape is caught", () => {
    expect(encryptionSecretProblem("**********")).toContain("got");
    expect(encryptionSecretProblem(GOOD_SECRET)).toBeNull();
  });

  test("a Supabase URL that is not a URL is rejected", () => {
    const env = { ...completeEnv(), NEXT_PUBLIC_SUPABASE_URL: "127.0.0.1" };
    expect(findEnvProblems(env)[0]).toMatchObject({
      name: "NEXT_PUBLIC_SUPABASE_URL",
      detail: "is not a valid URL",
    });
  });

  // This string goes into build logs. It must never carry the value.
  test("no reported problem ever quotes the value", () => {
    const secret = Buffer.alloc(16, 9).toString("base64");
    const message = formatEnvProblems(
      findEnvProblems({
        ...completeEnv(),
        API_KEY_ENCRYPTION_SECRET: secret,
        NEXT_PUBLIC_SUPABASE_URL: "http://super-secret-host.invalid:1/x",
      }),
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("super-secret-host");
  });
});

describe("the message", () => {
  test("names the variable in the exact shape the brief asked for", () => {
    const message = formatEnvProblems(
      findEnvProblems({ ...completeEnv(), API_KEY_ENCRYPTION_SECRET: "" }),
    );
    expect(message).toContain(
      "Missing required environment variable: API_KEY_ENCRYPTION_SECRET",
    );
  });

  test("says what the variable is for, so the fix is obvious", () => {
    const message = formatEnvProblems(findEnvProblems({}));
    for (const variable of REQUIRED_ENV_VARS) {
      expect(message).toContain(variable.name);
      expect(message).toContain(variable.why);
    }
    expect(message).toContain(".env.local.example");
  });

  test("singular and plural both read correctly", () => {
    expect(
      formatEnvProblems(
        findEnvProblems({ ...completeEnv(), API_KEY_ENCRYPTION_SECRET: "" }),
      ),
    ).toContain("1 problem.");
    expect(formatEnvProblems(findEnvProblems({}))).toContain("3 problems.");
  });
});

// Task 67: Preview and Production on separate Supabase projects.
describe("Preview and Production use separate databases", () => {
  const PROD_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
  const PREVIEW_URL = "https://abcdefghijklmnopqrst.supabase.co";

  function deployment(vercelEnv: string | undefined, url: string) {
    return {
      ...completeEnv(),
      NEXT_PUBLIC_SUPABASE_URL: url,
      VERCEL_ENV: vercelEnv,
    };
  }

  test("a Preview build pointed at Production's project fails, naming why", () => {
    const [problem] = findEnvProblems(deployment("preview", PROD_URL));
    expect(problem.name).toBe("NEXT_PUBLIC_SUPABASE_URL");
    expect(problem.detail).toMatch(/Preview deployment at the Production/);
    expect(problem.why).toMatch(/separate Supabase projects/);
  });

  test("a Preview build on its own project passes", () => {
    expect(findEnvProblems(deployment("preview", PREVIEW_URL))).toEqual([]);
  });

  test("a Production build on Production's project passes", () => {
    expect(findEnvProblems(deployment("production", PROD_URL))).toEqual([]);
  });

  test("a Production build pointed anywhere else fails", () => {
    const [problem] = findEnvProblems(deployment("production", PREVIEW_URL));
    expect(problem.detail).toMatch(/other than Production's/);
  });

  test("local development and CI (no VERCEL_ENV) are not checked", () => {
    expect(findEnvProblems(deployment(undefined, PROD_URL))).toEqual([]);
    expect(
      findEnvProblems(deployment(undefined, "http://127.0.0.1:54321")),
    ).toEqual([]);
  });

  test("the message never quotes the URL", () => {
    const text = formatEnvProblems(
      findEnvProblems(deployment("preview", PROD_URL)),
    );
    expect(text).not.toContain(PRODUCTION_SUPABASE_REF);
  });
});

// Task 67, second check: Preview was first switched with the new project's
// URL but Production's publishable key, which the URL check passed.
describe("Preview does not use Production's publishable key", () => {
  const PREVIEW_URL = "https://abcdefghijklmnopqrst.supabase.co";
  const PROD_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;

  function deployment(vercelEnv: string | undefined, url: string, key: string) {
    return {
      ...completeEnv(),
      NEXT_PUBLIC_SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
      VERCEL_ENV: vercelEnv,
    };
  }

  test("a Preview build with Production's key fails, naming the key", () => {
    const problems = findEnvProblems(
      deployment("preview", PREVIEW_URL, PRODUCTION_SUPABASE_PUBLISHABLE_KEY),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].name).toBe("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(problems[0].detail).toMatch(/Production's publishable key/);
  });

  test("Production's URL and key in a Preview build are both reported", () => {
    expect(
      findEnvProblems(
        deployment("preview", PROD_URL, PRODUCTION_SUPABASE_PUBLISHABLE_KEY),
      ).map((p) => p.name),
    ).toEqual([
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
    ]);
  });

  test("a Preview build with its own key passes", () => {
    expect(
      findEnvProblems(
        deployment("preview", PREVIEW_URL, "sb_publishable_preview"),
      ),
    ).toEqual([]);
  });

  test("Production with its own key passes", () => {
    expect(
      findEnvProblems(
        deployment("production", PROD_URL, PRODUCTION_SUPABASE_PUBLISHABLE_KEY),
      ),
    ).toEqual([]);
  });

  test("local development and CI are not checked", () => {
    expect(
      findEnvProblems(
        deployment(undefined, PREVIEW_URL, PRODUCTION_SUPABASE_PUBLISHABLE_KEY),
      ),
    ).toEqual([]);
  });

  test("the message never quotes the key", () => {
    const text = formatEnvProblems(
      findEnvProblems(
        deployment("preview", PREVIEW_URL, PRODUCTION_SUPABASE_PUBLISHABLE_KEY),
      ),
    );
    expect(text).not.toContain(PRODUCTION_SUPABASE_PUBLISHABLE_KEY);
  });
});
