from __future__ import annotations
from pydantic import BaseModel, Field


class ClusterFilesInput(BaseModel):
    folder_path: str = Field(description="Absolute or relative path to the folder containing documents")
    extensions: list[str] = Field(min_length=1, description="Validated supported document suffixes")
