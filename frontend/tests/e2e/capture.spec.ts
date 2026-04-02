import { expect, test } from "@playwright/test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { captureDir } from "../../playwright.config";

async function waitForMatch(suffix: string): Promise<string> {
  await expect
    .poll(async () => {
      const entries = await readdir(captureDir);
      return entries.find((entry) => entry.endsWith(suffix)) ?? null;
    })
    .not.toBeNull();

  const entries = await readdir(captureDir);
  const match = entries.find((entry) => entry.endsWith(suffix));
  if (!match) {
    throw new Error(`Missing file ending with ${suffix}`);
  }

  return match;
}

test.beforeEach(async () => {
  await rm(captureDir, { force: true, recursive: true });
  await mkdir(captureDir, { recursive: true });
});

async function countCapturedFiles(): Promise<number> {
  const entries = await readdir(captureDir);
  return entries.filter((entry) => !entry.endsWith("-metadata.json")).length;
}

test("page stays visually static while pasted text is captured", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("hello")).toBeVisible();

  await page.evaluate((value) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", value);
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: dataTransfer,
    });
    window.dispatchEvent(pasteEvent);
  }, "playwright clipboard text");

  const storedTextFile = await waitForMatch(".txt");
  const metadataFile = await waitForMatch("-metadata.json");
  const capturedText = await readFile(join(captureDir, storedTextFile), "utf-8");
  const metadata = JSON.parse(await readFile(join(captureDir, metadataFile), "utf-8")) as {
    source: string;
    item: { kind: string; mime_type: string };
  };

  await expect(page.locator("#app")).toHaveText("hello");
  expect(capturedText).toBe("playwright clipboard text");
  expect(metadata.source).toBe("paste");
  expect(metadata.item.kind).toBe("string");
  expect(metadata.item.mime_type).toBe("text/plain");
});

test("dropped files are captured without changing the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("hello")).toBeVisible();

  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    const file = new File(["dropped from playwright"], "notes.txt", {
      type: "text/plain",
    });
    dataTransfer.items.add(file);
    const dropEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    });
    window.dispatchEvent(dropEvent);
  });

  const storedTextFile = await waitForMatch("notes.txt");
  const metadataFile = `${storedTextFile}-metadata.json`;
  const capturedText = await readFile(join(captureDir, storedTextFile), "utf-8");
  const metadata = JSON.parse(await readFile(join(captureDir, metadataFile), "utf-8")) as {
    source: string;
    item: { kind: string; original_name: string };
  };

  await expect(page.locator("#app")).toHaveText("hello");
  expect(capturedText).toBe("dropped from playwright");
  expect(metadata.source).toBe("drop");
  expect(metadata.item.kind).toBe("file");
  expect(metadata.item.original_name).toBe("notes.txt");
});

test("typed keys are buffered for 3 seconds and captured as one event", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("hello")).toBeVisible();

  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift");

  await page.waitForTimeout(3_400);

  const storedTextFile = await waitForMatch(".txt");
  const metadataFile = `${storedTextFile}-metadata.json`;
  const capturedText = await readFile(join(captureDir, storedTextFile), "utf-8");
  const metadata = JSON.parse(await readFile(join(captureDir, metadataFile), "utf-8")) as {
    source: string;
  };

  expect(capturedText).toBe("a[Enter][Shift]");
  expect(metadata.source).toBe("typed");
});

test("typed buffer flushes when the page is hidden", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("hello")).toBeVisible();

  await page.keyboard.press("b");
  await page.keyboard.press("Backspace");
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
  });

  const storedTextFile = await waitForMatch(".txt");
  const capturedText = await readFile(join(captureDir, storedTextFile), "utf-8");
  expect(capturedText).toBe("b[Backspace]");
});

test("empty typed buffers are dropped", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("hello")).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  await page.waitForTimeout(500);

  expect(await countCapturedFiles()).toBe(0);
});

test("capture retries after an initial upload failure", async ({ page }) => {
  let requestCount = 0;
  await page.route("**/api/capture-events", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "temporary failure" }),
      });
      return;
    }

    await route.continue();
  });

  await page.goto("/");
  await page.keyboard.press("r");
  await page.waitForTimeout(3_400);

  const storedTextFile = await waitForMatch(".txt");
  const capturedText = await readFile(join(captureDir, storedTextFile), "utf-8");

  expect(requestCount).toBeGreaterThanOrEqual(2);
  expect(capturedText).toBe("r");
});
