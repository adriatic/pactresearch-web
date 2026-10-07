# pact-convert — one-time converter for older .pact files (Task 77)

Turns `.pact` files written by older PACT apps into the format pact-web
imports today. It's a **one-time migration**, not part of the app: it
shares no code with pact-web, and pact-web's importer still accepts only
the current format.

## What it handles

Every older file found (92, on 2026-10-04) is format version 1, in one of
two wrappings:

| Older file                                                                                                                                                       | What the converter does                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Signed** (`{version, payload, signature, signedAt, signer}`), from the VSCode extension (`pact-local`) or the legacy app.pactresearch.net (`pactresearch.net`) | unwraps `payload`; drops the signature, `xmState` and `notebook.executionMode`, **listing each** |
| **Plain** with fields pact-web has no place for (e.g. `notebook.executionMode`)                                                                                  | drops those fields, **listing each**                                                             |
| **Plain, already current**                                                                                                                                       | copies the file **byte for byte**                                                                |
| Not JSON, truncated, not a .pact, a missing required field, a timestamp that isn't a date                                                                        | **error, no output file**                                                                        |

Everything else is kept as written, including prompts that were never run
(empty response) and literal `\n` in text. Both are reported as notes,
never changed.

## Run it

```bash
# 1. See what would happen. Writes nothing.
node tools/pact-convert/convert.mjs --dry-run --out /tmp/unused  ~/pact/PACT-Exports

# 2. Convert. Originals are only read; output goes to a new folder that
#    mirrors the input layout. Existing output files are never overwritten.
node tools/pact-convert/convert.mjs --out ~/pact/PACT-Exports-converted  ~/pact/PACT-Exports
```

Each run prints, per file, `CONVERTED` / `CURRENT` / `ERROR`, what wasn't
carried over, and any notes. A normal run also writes the same report to
`<out>/conversion-report.txt`. The exit code is 1 if any file errored.

Then import the converted files through pact-web's **Import** button.

**Converted copies of real files stay on this machine.** Never commit
them; some are customer research.

## Delete it

When the migration is done:

```bash
git rm -r tools/pact-convert e2e/pact-convert-import.spec.ts
```

Nothing else references it. Its tests (`convert.test.mjs`) are found by
vitest's default pattern, so no config changes are needed.
