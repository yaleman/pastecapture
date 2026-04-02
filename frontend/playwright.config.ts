import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export const backendPort = 8000;
export const frontendPort = 4173;
export const captureDir = join(tmpdir(), "pastecapture-playwright");

rmSync(captureDir, { force: true, recursive: true });
mkdirSync(captureDir, { recursive: true });

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `PYTHONPATH=.. uv run --project .. python -m pastecapture.cli --host 127.0.0.1 --port ${backendPort} --capture-dir "${captureDir}"`,
      url: `http://127.0.0.1:${backendPort}/openapi.json`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `pnpm dev --host 127.0.0.1 --port ${frontendPort}`,
      cwd: ".",
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
