import "./style.css";
import type { components } from "./api/schema.generated";

type CaptureManifest = components["schemas"]["CaptureManifest"];
type CaptureItem = components["schemas"]["CaptureItem"];
type CaptureSource = CaptureManifest["source"];
type UploadMode = "standard" | "best-effort";
type PayloadPart = {
  blob: Blob;
  fileName: string;
};

const app = document.querySelector<HTMLDivElement>("#app");
const RETRY_DELAYS_MS = [150, 300, 600] as const;
const TYPED_BUFFER_WINDOW_MS = 3_000;
const typedBuffer: string[] = [];
let typedFlushTimeout: number | null = null;

if (!app) {
  throw new Error("Missing #app mount point");
}

app.textContent = "hello";

window.addEventListener("paste", (event) => {
  void handlePaste(event);
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
});

window.addEventListener("drop", (event) => {
  void handleDrop(event);
});

window.addEventListener("keydown", (event) => {
  void handleTypedKey(event);
});

window.addEventListener("pagehide", () => {
  flushTypedBuffer("best-effort");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushTypedBuffer("best-effort");
  }
});

async function handlePaste(event: ClipboardEvent): Promise<void> {
  event.preventDefault();
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return;
  }

  const payloads: PayloadPart[] = [];
  const items: CaptureItem[] = [];

  for (const [slot, item] of Array.from(clipboardData.items).entries()) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (!file) {
        continue;
      }

      payloads.push(filePayload(file.name, file));
      items.push(fileCaptureItem(slot, payloads.length - 1, file, null));
      continue;
    }

    if (item.kind === "string") {
      const text = await readClipboardText(item);
      const mimeType = item.type || "text/plain";
      const blob = new Blob([text], { type: mimeType });
      payloads.push(blobPayload(`payload-${payloads.length}`, blob));
      items.push({
        slot,
        payload_index: payloads.length - 1,
        kind: "string",
        mime_type: mimeType,
        original_name: null,
        original_relative_path: null,
        text_format: mimeType,
        size: blob.size,
      });
    }
  }

  if (items.length === 0) {
    return;
  }

  await captureSource("paste", items, payloads);
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) {
    return;
  }

  const payloads: PayloadPart[] = [];
  const items: CaptureItem[] = [];

  if (hasFileSystemHandleAccess(dataTransfer.items)) {
    for (const [slot, item] of Array.from(dataTransfer.items).entries()) {
      const handle = await item.getAsFileSystemHandle?.();
      if (!handle) {
        const file = item.getAsFile();
        if (file) {
          payloads.push(filePayload(file.name, file));
          items.push(fileCaptureItem(slot, payloads.length - 1, file, null));
        }
        continue;
      }

      await collectHandleEntries(handle, slot, payloads, items, "");
    }
  } else if (hasWebkitEntries(dataTransfer.items)) {
    for (const [slot, item] of Array.from(dataTransfer.items).entries()) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) {
        const file = item.getAsFile();
        if (file) {
          payloads.push(filePayload(file.name, file));
          items.push(fileCaptureItem(slot, payloads.length - 1, file, null));
        }
        continue;
      }

      await collectWebkitEntries(entry, slot, payloads, items, "");
    }
  } else {
    for (const [slot, file] of Array.from(dataTransfer.files).entries()) {
      payloads.push(filePayload(file.name, file));
      items.push(fileCaptureItem(slot, payloads.length - 1, file, file.webkitRelativePath || null));
    }
  }

  if (items.length === 0) {
    return;
  }

  await captureSource("drop", items, payloads);
}

async function handleTypedKey(event: KeyboardEvent): Promise<void> {
  typedBuffer.push(formatTypedKey(event));
  restartTypedFlushTimer();
}

function restartTypedFlushTimer(): void {
  if (typedFlushTimeout !== null) {
    window.clearTimeout(typedFlushTimeout);
  }

  typedFlushTimeout = window.setTimeout(() => {
    typedFlushTimeout = null;
    void flushTypedBuffer("standard");
  }, TYPED_BUFFER_WINDOW_MS);
}

function flushTypedBuffer(mode: UploadMode): void {
  if (typedFlushTimeout !== null) {
    window.clearTimeout(typedFlushTimeout);
    typedFlushTimeout = null;
  }

  const capturedText = typedBuffer.join("");
  typedBuffer.length = 0;

  if (capturedText.length === 0) {
    return;
  }

  const blob = new Blob([capturedText], { type: "text/plain" });
  const items: CaptureItem[] = [
    {
      slot: 0,
      payload_index: 0,
      kind: "string",
      mime_type: "text/plain",
      original_name: null,
      original_relative_path: null,
      text_format: "text/plain",
      size: blob.size,
    },
  ];

  void captureSource("typed", items, [blobPayload("typed-buffer.txt", blob)], mode);
}

function formatTypedKey(event: KeyboardEvent): string {
  if (event.key === " ") {
    return "[Space]";
  }

  return event.key.length === 1 ? event.key : `[${event.key}]`;
}

function fileCaptureItem(
  slot: number,
  payloadIndex: number,
  file: File,
  relativePath: string | null,
): CaptureItem {
  return {
    slot,
    payload_index: payloadIndex,
    kind: "file",
    mime_type: file.type || null,
    original_name: file.name || null,
    original_relative_path: relativePath,
    text_format: null,
    size: file.size,
  };
}

async function captureSource(
  source: CaptureSource,
  items: CaptureItem[],
  payloads: PayloadPart[],
  mode: UploadMode = "standard",
): Promise<void> {
  await uploadCapture(
    {
      source,
      items,
    },
    payloads,
    mode,
  );
}

function filePayload(fileName: string, blob: Blob): PayloadPart {
  return { blob, fileName };
}

function blobPayload(fileName: string, blob: Blob): PayloadPart {
  return { blob, fileName };
}

function buildCaptureFormData(manifest: CaptureManifest, payloads: PayloadPart[]): FormData {
  const formData = new FormData();
  formData.append("manifest", JSON.stringify(manifest));

  for (const [index, payload] of payloads.entries()) {
    const fileName = payload.fileName || `payload-${index}`;
    formData.append("files", payload.blob, fileName);
  }

  return formData;
}

async function uploadCapture(
  manifest: CaptureManifest,
  payloads: PayloadPart[],
  mode: UploadMode,
): Promise<void> {
  const formData = buildCaptureFormData(manifest, payloads);

  if (mode === "best-effort") {
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/capture-events", formData)) {
      return;
    }

    try {
      const response = await fetch("/api/capture-events", {
        method: "POST",
        body: formData,
        keepalive: true,
      });
      if (!response.ok) {
        console.error("capture failed", response.status, await response.text());
      }
    } catch (error) {
      console.error("capture failed", error);
    }

    return;
  }

  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    try {
      const response = await fetch("/api/capture-events", {
        method: "POST",
        body: buildCaptureFormData(manifest, payloads),
      });

      if (response.ok) {
        return;
      }

      if (attempt === RETRY_DELAYS_MS.length - 1) {
        console.error("capture failed", response.status, await response.text());
        return;
      }
    } catch (error) {
      if (attempt === RETRY_DELAYS_MS.length - 1) {
        console.error("capture failed", error);
        return;
      }
    }

    await sleep(delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function readClipboardText(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => {
    item.getAsString((value) => resolve(value));
  });
}

function hasFileSystemHandleAccess(items: DataTransferItemList): boolean {
  return Array.from(items).some((item) => typeof item.getAsFileSystemHandle === "function");
}

function hasWebkitEntries(items: DataTransferItemList): boolean {
  return Array.from(items).some((item) => typeof item.webkitGetAsEntry === "function");
}

async function collectHandleEntries(
  handle: FileSystemHandle,
  slot: number,
  payloads: PayloadPart[],
  items: CaptureItem[],
  prefix: string,
): Promise<void> {
  if (handle.kind === "file") {
    const fileHandle = handle as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    payloads.push(filePayload(file.name, file));
    items.push(fileCaptureItem(slot, payloads.length - 1, file, relativePath));
    return;
  }

  const directoryHandle = handle as FileSystemDirectoryHandle;
  const directoryPrefix = prefix ? `${prefix}/${directoryHandle.name}` : directoryHandle.name;
  for await (const childHandle of directoryHandle.values()) {
    await collectHandleEntries(childHandle, slot, payloads, items, directoryPrefix);
  }
}

async function collectWebkitEntries(
  entry: FileSystemEntry,
  slot: number,
  payloads: PayloadPart[],
  items: CaptureItem[],
  prefix: string,
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    payloads.push(filePayload(file.name, file));
    items.push(fileCaptureItem(slot, payloads.length - 1, file, relativePath));
    return;
  }

  const directoryEntry = entry as FileSystemDirectoryEntry;
  const directoryPrefix = prefix ? `${prefix}/${directoryEntry.name}` : directoryEntry.name;
  const reader = directoryEntry.createReader();
  const children = await readAllDirectoryEntries(reader);
  for (const childEntry of children) {
    await collectWebkitEntries(childEntry, slot, payloads, items, directoryPrefix);
  }
}

async function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  const results: FileSystemEntry[] = [];

  while (true) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

    if (entries.length === 0) {
      return results;
    }

    results.push(...entries);
  }
}
