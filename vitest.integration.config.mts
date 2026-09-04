import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["__tests__/integration/**/*.test.ts"],
    // Each integration file resets the local Supabase DB in its own
    // beforeAll; running files in parallel would let one file's reset wipe
    // data another file is mid-test with.
    fileParallelism: false,
  },
});
