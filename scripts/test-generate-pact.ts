// scripts/test-generate-pact.ts
//
// Standalone local test for utils/generatePactFile.ts.
// Run with: npx tsx scripts/test-generate-pact.ts
//
// Bypasses the full app.pactresearch.net pipeline (form submission, deploy,
// email delivery) entirely — calls generatePactFile() directly with a
// sample request and writes the resulting .pact JSON to disk for inspection.

import { writeFileSync } from "fs";
import { join } from "path";
import { generatePactFile, generateShortSlug } from "../utils/generatePactFile";

const sampleRequest = {
  requestId: "test-request-001",
  researchQuestion:
    "What are the cardiovascular effects of long-term SSRI use in elderly patients?",
  context: "Focused on patients over 65 with pre-existing heart conditions.",
  modelTier: "standard",
  userEmail: "nik@congral.us",
};

console.log("── Input ──────────────────────────────────────────────");
console.log(sampleRequest);

console.log("\n── generateShortSlug() output ─────────────────────────");
console.log(generateShortSlug(sampleRequest.researchQuestion));

const pactJson = generatePactFile(sampleRequest);
const parsed = JSON.parse(pactJson);

console.log("\n── generatePactFile() parsed output ───────────────────");
console.log(JSON.stringify(parsed, null, 2));

console.log("\n── Spot checks ─────────────────────────────────────────");
console.log("notebook.category:", parsed.notebook.category ?? "(missing)");
console.log("notebook.executionMode:", parsed.notebook.executionMode);
console.log("notebook.name:", parsed.notebook.name);
console.log("cells[0].model:", parsed.cells[0].model);
console.log("cells[0].promptText:", parsed.cells[0].promptText);

const outPath = join(process.cwd(), "scripts", "test-output.pact");
writeFileSync(outPath, pactJson, "utf-8");
console.log(`\n── Wrote full output to: ${outPath}`);
