import json
import mimetypes
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, TypeVar

from .schemas import CaptureItem, CaptureManifest


FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
PATH_SPLIT_RE = re.compile(r"[\\\\/]+")
DEFAULT_CAPTURE_DIR = Path("captures")
DEFAULT_FRONTEND_DIST_DIR = Path("frontend/dist")
WRITE_RETRY_DELAYS_SECONDS = (0.05, 0.1, 0.2)
STRING_EXTENSION_MAP = {
    "text/plain": ".txt",
    "text/html": ".html",
    "text/uri-list": ".uri-list.txt",
}
T = TypeVar("T")


@dataclass(slots=True)
class StoredCapture:
    stored_path: str
    metadata_path: str
    original_name: str | None
    original_relative_path: str | None
    mime_type: str | None
    size: int


def retry_operation(fn: Callable[[], T]) -> T:
    last_error: OSError | None = None

    for attempt, delay in enumerate((0.0, *WRITE_RETRY_DELAYS_SECONDS), start=1):
        if delay > 0:
            time.sleep(delay)

        try:
            return fn()
        except OSError as error:
            last_error = error
            if attempt == len(WRITE_RETRY_DELAYS_SECONDS) + 1:
                break

    raise last_error if last_error is not None else OSError("retry operation failed")


def sanitize_component(value: str | None, fallback: str) -> str:
    if not value:
        return fallback

    sanitized = FILENAME_SAFE_RE.sub("_", value).strip("._")
    return sanitized or fallback


def flatten_relative_path(relative_path: str | None, fallback_name: str) -> str:
    if not relative_path:
        return sanitize_component(fallback_name, "file")

    parts = [
        sanitize_component(part, "part")
        for part in PATH_SPLIT_RE.split(relative_path)
        if part and part not in {".", ".."}
    ]
    if not parts:
        return sanitize_component(fallback_name, "file")

    return "__".join(parts)


def display_path(root: Path, file_name: str) -> str:
    return (Path(root.name) / file_name).as_posix()


def extension_for_string(item: CaptureItem) -> str:
    mime_type = item.mime_type or item.text_format or ""
    if mime_type in STRING_EXTENSION_MAP:
        return STRING_EXTENSION_MAP[mime_type]

    if mime_type.startswith("text/"):
        suffix = sanitize_component(mime_type.split("/", maxsplit=1)[1], "text")
        return f".{suffix}.txt"

    guessed = mimetypes.guess_extension(mime_type)
    return guessed or ".bin"


def file_name_for_item(event_id: str, event_time: datetime, item: CaptureItem) -> str:
    unix_timestamp = int(event_time.timestamp())
    if item.kind == "string":
        return f"{event_id}-{unix_timestamp}{extension_for_string(item)}"

    original_name = item.original_name or "file"
    flattened_name = (
        flatten_relative_path(item.original_relative_path, original_name)
        if item.original_relative_path
        else sanitize_component(original_name, "file")
    )
    return f"{event_id}-{flattened_name}"


def ensure_unique_name(root: Path, file_name: str) -> str:
    candidate = root / file_name
    if not candidate.exists():
        return file_name

    path = Path(file_name)
    counter = 1
    while True:
        next_name = f"{path.stem}-{counter}{path.suffix}"
        if not (root / next_name).exists():
            return next_name
        counter += 1


def metadata_payload(
    *,
    event_id: str,
    received_at: datetime,
    request_headers: dict[str, str],
    client_host: str | None,
    item: CaptureItem,
    stored_path: str,
    size: int,
    source: str,
) -> dict[str, Any]:
    return {
        "event_id": event_id,
        "received_at": received_at.isoformat(),
        "source": source,
        "client_ip": client_host,
        "request_headers": request_headers,
        "item": {
            "slot": item.slot,
            "payload_index": item.payload_index,
            "kind": item.kind,
            "mime_type": item.mime_type,
            "original_name": item.original_name,
            "original_relative_path": item.original_relative_path,
            "text_format": item.text_format,
            "size": size,
        },
        "stored_path": stored_path,
    }


def store_capture(
    *,
    root: Path,
    event_id: str,
    event_time: datetime,
    manifest: CaptureManifest,
    item: CaptureItem,
    payload: bytes,
    request_headers: dict[str, str],
    client_host: str | None,
) -> StoredCapture:
    retry_operation(lambda: root.mkdir(parents=True, exist_ok=True))

    base_name = file_name_for_item(event_id, event_time, item)
    file_name = ensure_unique_name(root, base_name)
    file_path = root / file_name
    retry_operation(lambda: file_path.write_bytes(payload))

    stored_path = display_path(root, file_name)
    metadata_name = f"{file_name}-metadata.json"
    metadata_path = root / metadata_name
    metadata_display = display_path(root, metadata_name)
    metadata = metadata_payload(
        event_id=event_id,
        received_at=event_time,
        request_headers=request_headers,
        client_host=client_host,
        item=item,
        stored_path=stored_path,
        size=len(payload),
        source=manifest.source,
    )
    metadata_json = json.dumps(metadata, indent=2, sort_keys=True)
    retry_operation(lambda: metadata_path.write_text(metadata_json, encoding="utf-8"))

    return StoredCapture(
        stored_path=stored_path,
        metadata_path=metadata_display,
        original_name=item.original_name,
        original_relative_path=item.original_relative_path,
        mime_type=item.mime_type,
        size=len(payload),
    )


def event_time_from_uuid_ms(uuid_time_ms: int) -> datetime:
    return datetime.fromtimestamp(uuid_time_ms / 1000, tz=UTC)
