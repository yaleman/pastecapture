interface DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
  webkitGetAsEntry?: () => FileSystemEntry | null;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterable<FileSystemHandle>;
}

interface FileSystemEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly name: string;
  readonly fullPath: string;
}

interface FileSystemFileEntry extends FileSystemEntry {
  file(
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ): void;
}

interface FileSystemDirectoryEntry extends FileSystemEntry {
  createReader(): FileSystemDirectoryReader;
}

interface FileSystemDirectoryReader {
  readEntries(
    successCallback: (entries: FileSystemEntry[]) => void,
    errorCallback?: (error: DOMException) => void,
  ): void;
}
