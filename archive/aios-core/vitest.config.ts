import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 2,
        minForks: 1,
      },
    },
    // shadow/ holds the real-I/O end-to-end suite (real git/tsc/vitest
    // subprocesses with a rule-based model). It runs real commands per
    // scenario, so it needs a longer timeout than the default 5s.
    testTimeout: 60_000,
    exclude: ["node_modules/**"],
  },
});
