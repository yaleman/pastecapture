from typing import Literal

from pydantic import BaseModel, Field


CaptureSource = Literal["paste", "drop", "typed"]
CaptureKind = Literal["string", "file"]


class CaptureItem(BaseModel):
    slot: int = Field(ge=0)
    payload_index: int = Field(ge=0)
    kind: CaptureKind
    mime_type: str | None = None
    original_name: str | None = None
    original_relative_path: str | None = None
    text_format: str | None = None
    size: int | None = Field(default=None, ge=0)


class CaptureManifest(BaseModel):
    source: CaptureSource
    items: list[CaptureItem] = Field(min_length=1)


class StoredItemResponse(BaseModel):
    stored_path: str
    metadata_path: str
    original_name: str | None = None
    original_relative_path: str | None = None
    mime_type: str | None = None
    size: int = Field(ge=0)


class CaptureEventResponse(BaseModel):
    event_id: str
    stored_items: list[StoredItemResponse]
