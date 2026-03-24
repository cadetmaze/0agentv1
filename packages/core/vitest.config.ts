import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: [
      "../../tests/unit/**/*.test.ts",
      "../../tests/convergence/**/*.test.ts",
      "../../tests/capabilities/**/*.test.ts",
    ],
    testTimeout: 30000,
  },
});
