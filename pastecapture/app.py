from collections.abc import Mapping
import os
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import Json
from uuid6 import uuid7

from .schemas import CaptureEventResponse, CaptureManifest, StoredItemResponse
from .storage import (
    DEFAULT_CAPTURE_DIR,
    DEFAULT_FRONTEND_DIST_DIR,
    event_time_from_uuid_ms,
    store_capture,
)


INDEX_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>pastecapture</title>
  </head>
  <body>hello</body>
</html>
"""


def request_headers(headers: Mapping[str, str]) -> dict[str, str]:
    return {key: value for key, value in headers.items()}


def resolve_capture_dir(capture_dir: Path | None = None) -> Path:
    configured = capture_dir or os.getenv("PASTECAPTURE_CAPTURE_DIR")
    return Path(configured) if configured else DEFAULT_CAPTURE_DIR


def resolve_frontend_dist(frontend_dist: Path | None = None) -> Path:
    configured = frontend_dist or os.getenv("PASTECAPTURE_FRONTEND_DIST")
    return Path(configured) if configured else DEFAULT_FRONTEND_DIST_DIR


def create_app(
    capture_dir: Path | None = None,
    frontend_dist: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="pastecapture")
    app.state.capture_root = resolve_capture_dir(capture_dir)
    app.state.frontend_dist = resolve_frontend_dist(frontend_dist)

    @app.post("/api/capture-events", response_model=CaptureEventResponse)
    async def capture_event(
        request: Request,
        manifest: Annotated[Json[CaptureManifest], Form(...)],
        files: Annotated[list[UploadFile], File(...)],
    ) -> CaptureEventResponse:
        items_by_payload_index = {item.payload_index: item for item in manifest.items}
        if len(items_by_payload_index) != len(manifest.items):
            raise HTTPException(status_code=422, detail="payload_index values must be unique")

        if len(files) != len(manifest.items):
            raise HTTPException(status_code=422, detail="files and manifest items must match")

        event_uuid = uuid7()
        event_id = str(event_uuid)
        received_at = event_time_from_uuid_ms(event_uuid.time)
        stored_items: list[StoredItemResponse] = []
        headers = request_headers(request.headers)
        client_host = request.client.host if request.client else None

        for payload_index, upload in enumerate(files):
            item = items_by_payload_index.get(payload_index)
            if item is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"missing manifest item for payload index {payload_index}",
                )

            payload = await upload.read()
            if item.original_name is None and upload.filename:
                item = item.model_copy(update={"original_name": upload.filename})
            if item.mime_type is None and upload.content_type:
                item = item.model_copy(update={"mime_type": upload.content_type})

            stored_capture = store_capture(
                root=request.app.state.capture_root,
                event_id=event_id,
                event_time=received_at,
                manifest=manifest,
                item=item,
                payload=payload,
                request_headers=headers,
                client_host=client_host,
            )
            stored_items.append(
                StoredItemResponse(
                    stored_path=stored_capture.stored_path,
                    metadata_path=stored_capture.metadata_path,
                    original_name=stored_capture.original_name,
                    original_relative_path=stored_capture.original_relative_path,
                    mime_type=stored_capture.mime_type,
                    size=stored_capture.size,
                )
            )

        return CaptureEventResponse(event_id=event_id, stored_items=stored_items)

    @app.get("/{path:path}", include_in_schema=False, response_model=None)
    async def serve_frontend(request: Request, path: str) -> Response:
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")

        frontend_dist_dir = request.app.state.frontend_dist
        candidate = frontend_dist_dir / path if path else frontend_dist_dir / "index.html"
        if candidate.is_file():
            return FileResponse(candidate)

        index_path = frontend_dist_dir / "index.html"
        if index_path.is_file():
            return FileResponse(index_path)

        return HTMLResponse(INDEX_HTML)

    return app


app = create_app()
