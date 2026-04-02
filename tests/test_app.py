import json
from pathlib import Path

from fastapi.testclient import TestClient
from uuid6 import UUID

from pastecapture import storage
from pastecapture.app import create_app


def test_text_paste_creates_timestamped_text_file_and_metadata(tmp_path):
    client = TestClient(create_app(capture_dir=tmp_path / "captures"))

    manifest = {
        "source": "paste",
        "items": [
            {
                "slot": 0,
                "payload_index": 0,
                "kind": "string",
                "mime_type": "text/plain",
                "text_format": "text/plain",
            }
        ],
    }

    response = client.post(
        "/api/capture-events",
        data={"manifest": json.dumps(manifest)},
        files={"files": ("clipboard.txt", b"hello world", "text/plain")},
        headers={"x-test-header": "present"},
    )

    assert response.status_code == 200
    payload = response.json()
    stored_item = payload["stored_items"][0]
    stored_path = Path(stored_item["stored_path"])
    metadata_path = tmp_path / stored_item["metadata_path"]
    event_id = payload["event_id"]
    unix_timestamp = UUID(event_id).time // 1000

    assert stored_path.parent == Path("captures")
    assert stored_path.name == f"{event_id}-{unix_timestamp}.txt"
    assert metadata_path.exists()
    assert metadata_path.name == f"{stored_path.name}-metadata.json"
    assert (tmp_path / stored_item["stored_path"]).read_text(encoding="utf-8") == "hello world"


def test_multiple_items_share_event_id_prefix(tmp_path):
    client = TestClient(create_app(capture_dir=tmp_path / "captures"))

    manifest = {
        "source": "paste",
        "items": [
            {
                "slot": 0,
                "payload_index": 0,
                "kind": "string",
                "mime_type": "text/plain",
                "text_format": "text/plain",
            },
            {
                "slot": 1,
                "payload_index": 1,
                "kind": "file",
                "mime_type": "image/png",
                "original_name": "sample.png",
            },
        ],
    }

    response = client.post(
        "/api/capture-events",
        data={"manifest": json.dumps(manifest)},
        files=[
            ("files", ("clipboard.txt", b"hello", "text/plain")),
            ("files", ("sample.png", b"\x89PNG", "image/png")),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    event_id = payload["event_id"]
    assert all(Path(item["stored_path"]).name.startswith(f"{event_id}-") for item in payload["stored_items"])


def test_folder_paths_are_flattened_and_recorded(tmp_path):
    client = TestClient(create_app(capture_dir=tmp_path / "captures"))

    manifest = {
        "source": "drop",
        "items": [
            {
                "slot": 0,
                "payload_index": 0,
                "kind": "file",
                "mime_type": "text/plain",
                "original_name": "notes.txt",
                "original_relative_path": "folder/sub/notes.txt",
            }
        ],
    }

    response = client.post(
        "/api/capture-events",
        data={"manifest": json.dumps(manifest)},
        files={"files": ("notes.txt", b"folder text", "text/plain")},
    )

    assert response.status_code == 200
    payload = response.json()
    stored_item = payload["stored_items"][0]
    stored_name = Path(stored_item["stored_path"]).name
    assert "folder__sub__notes.txt" in stored_name
    assert stored_item["original_relative_path"] == "folder/sub/notes.txt"


def test_metadata_includes_headers_and_client_ip(tmp_path):
    client = TestClient(create_app(capture_dir=tmp_path / "captures"))

    manifest = {
        "source": "drop",
        "items": [
            {
                "slot": 0,
                "payload_index": 0,
                "kind": "file",
                "mime_type": "application/octet-stream",
                "original_name": "raw.bin",
                "original_relative_path": "nested/raw.bin",
            }
        ],
    }

    response = client.post(
        "/api/capture-events",
        data={"manifest": json.dumps(manifest)},
        files={"files": ("raw.bin", b"\x00\x01", "application/octet-stream")},
        headers={"x-forwarded-for": "203.0.113.10"},
    )

    assert response.status_code == 200
    payload = response.json()
    metadata_path = tmp_path / payload["stored_items"][0]["metadata_path"]
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["request_headers"]["x-forwarded-for"] == "203.0.113.10"
    assert metadata["client_ip"] == "testclient"
    assert metadata["item"]["original_relative_path"] == "nested/raw.bin"


def test_typed_source_is_stored_as_text(tmp_path):
    client = TestClient(create_app(capture_dir=tmp_path / "captures"))

    manifest = {
        "source": "typed",
        "items": [
            {
                "slot": 0,
                "payload_index": 0,
                "kind": "string",
                "mime_type": "text/plain",
                "text_format": "text/plain",
            }
        ],
    }

    response = client.post(
        "/api/capture-events",
        data={"manifest": json.dumps(manifest)},
        files={"files": ("typed-buffer.txt", b"a[Enter][Shift]", "text/plain")},
    )

    assert response.status_code == 200
    payload = response.json()
    stored_item = payload["stored_items"][0]
    metadata_path = tmp_path / stored_item["metadata_path"]
    assert (tmp_path / stored_item["stored_path"]).read_text(encoding="utf-8") == "a[Enter][Shift]"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["source"] == "typed"


def test_store_capture_retries_transient_write_failure(monkeypatch, tmp_path):
    calls = {"count": 0}
    original_write_bytes = Path.write_bytes

    def flaky_write_bytes(self: Path, data: bytes) -> int:
        calls["count"] += 1
        if calls["count"] == 1:
            raise OSError("transient failure")
        return original_write_bytes(self, data)

    monkeypatch.setattr(storage, "WRITE_RETRY_DELAYS_SECONDS", (0.0, 0.0))
    monkeypatch.setattr(Path, "write_bytes", flaky_write_bytes)

    result = storage.store_capture(
        root=tmp_path / "captures",
        event_id="event-id",
        event_time=storage.event_time_from_uuid_ms(1_775_098_447_960),
        manifest=storage.CaptureManifest(
            source="typed",
            items=[
                storage.CaptureItem(
                    slot=0,
                    payload_index=0,
                    kind="string",
                    mime_type="text/plain",
                    text_format="text/plain",
                )
            ],
        ),
        item=storage.CaptureItem(
            slot=0,
            payload_index=0,
            kind="string",
            mime_type="text/plain",
            text_format="text/plain",
        ),
        payload=b"typed text",
        request_headers={},
        client_host="127.0.0.1",
    )

    assert calls["count"] == 2
    assert (tmp_path / result.stored_path).read_text(encoding="utf-8") == "typed text"


def test_storage_failure_surfaces_as_non_200(monkeypatch, tmp_path):
    client = TestClient(create_app(capture_dir=tmp_path / "captures"))

    def always_fail(self: Path, data: bytes) -> int:
        raise OSError("permanent failure")

    monkeypatch.setattr(storage, "WRITE_RETRY_DELAYS_SECONDS", (0.0, 0.0))
    monkeypatch.setattr(Path, "write_bytes", always_fail)

    manifest = {
        "source": "typed",
        "items": [
            {
                "slot": 0,
                "payload_index": 0,
                "kind": "string",
                "mime_type": "text/plain",
                "text_format": "text/plain",
            }
        ],
    }

    response = client.post(
        "/api/capture-events",
        data={"manifest": json.dumps(manifest)},
        files={"files": ("typed-buffer.txt", b"typed text", "text/plain")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "capture storage failed"


def test_app_uses_environment_capture_directory(monkeypatch, tmp_path):
    capture_root = tmp_path / "env-captures"
    monkeypatch.setenv("PASTECAPTURE_CAPTURE_DIR", str(capture_root))
    client = TestClient(create_app())

    manifest = {
        "source": "paste",
        "items": [
            {
                "slot": 0,
                "payload_index": 0,
                "kind": "string",
                "mime_type": "text/plain",
                "text_format": "text/plain",
            }
        ],
    }

    response = client.post(
        "/api/capture-events",
        data={"manifest": json.dumps(manifest)},
        files={"files": ("clipboard.txt", b"env capture", "text/plain")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert (capture_root / Path(payload["stored_items"][0]["stored_path"]).name).exists()
