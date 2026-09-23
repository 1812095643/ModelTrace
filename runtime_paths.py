from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


RESOURCE_ROOT = Path(__file__).resolve().parent


def resolve_data_directory() -> Path:
    override = os.environ.get("MODELTRACE_DATA_DIR")
    if override:
        destination = Path(override).expanduser().resolve()
    elif getattr(sys, "frozen", False):
        local_data = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        destination = local_data / "ModelTrace" / "data"
    else:
        return RESOURCE_ROOT / "data"

    destination.mkdir(parents=True, exist_ok=True)
    bundled_data = RESOURCE_ROOT / "data"
    if destination.resolve() != bundled_data.resolve():
        for source in bundled_data.iterdir():
            if source.is_file() and source.suffix in {".json", ".jsonl"}:
                target = destination / source.name
                if not target.exists():
                    shutil.copy2(source, target)
    return destination


DATA_DIR = resolve_data_directory()
