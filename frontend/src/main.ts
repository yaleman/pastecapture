import "./style.css";
import type { components } from "./api/schema.generated";

type CaptureManifest = components["schemas"]["CaptureManifest"];
type CaptureItem = components["schemas"]["CaptureItem"];

const app = document.querySelector<HTMLDivElement>("#app");

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

async function handlePaste(event: ClipboardEvent): Promise<void> {
  event.preventDefault();
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return;
  }

  const payloads: Blob[] = [];
  const items: CaptureItem[] = [];

  for (const [slot, item] of Array.from(clipboardData.items).entries()) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (!file) {
        continue;
      }

      payloads.push(file);
      items.push(fileCaptureItem(slot, payloads.length - 1, file, null));
      continue;
    }

    if (item.kind === "string") {
      const text = await readClipboardText(item);
      const mimeType = item.type || "text/plain";
      const blob = new Blob([text], { type: mimeType });
      payloads.push(blob);
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

  await uploadCapture(
    {
      source: "paste",
      items,
    },
    payloads,
  );
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) {
    return;
  }

  const payloads: Blob[] = [];
  const items: CaptureItem[] = [];

  if (hasFileSystemHandleAccess(dataTransfer.items)) {
    for (const [slot, item] of Array.from(dataTransfer.items).entries()) {
      const handle = await item.getAsFileSystemHandle?.();
      if (!handle) {
        const file = item.getAsFile();
        if (file) {
          payloads.push(file);
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
          payloads.push(file);
          items.push(fileCaptureItem(slot, payloads.length - 1, file, null));
        }
        continue;
      }

      await collectWebkitEntries(entry, slot, payloads, items, "");
    }
  } else {
    for (const [slot, file] of Array.from(dataTransfer.files).entries()) {
      payloads.push(file);
      items.push(fileCaptureItem(slot, payloads.length - 1, file, file.webkitRelativePath || null));
    }
  }

  if (items.length === 0) {
    return;
  }

  await uploadCapture(
    {
      source: "drop",
      items,
    },
    payloads,
  );
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

async function uploadCapture(manifest: CaptureManifest, payloads: Blob[]): Promise<void> {
  const formData = new FormData();
  formData.append("manifest", JSON.stringify(manifest));

  for (const [index, payload] of payloads.entries()) {
    const fileName = payload instanceof File ? payload.name : `payload-${index}`;
    formData.append("files", payload, fileName);
  }

  const response = await fetch("/api/capture-events", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    console.error("capture failed", response.status, await response.text());
  }
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
  payloads: Blob[],
  items: CaptureItem[],
  prefix: string,
): Promise<void> {
  if (handle.kind === "file") {
    const fileHandle = handle as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    payloads.push(file);
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
  payloads: Blob[],
  items: CaptureItem[],
  prefix: string,
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    payloads.push(file);
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
