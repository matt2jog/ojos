"""Stage or verify the pinned assets without publishing weights or recordings."""

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
from tempfile import NamedTemporaryFile

MANIFEST = Path(__file__).with_name("assets.json")


def verified(path, expected):
    if not path.is_file():
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == expected


def stage(source, target, expected):
    if not verified(source, expected):
        raise ValueError(f"Missing or changed source: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        shutil.copyfile(source, temporary)
        if not verified(temporary, expected):
            raise ValueError(f"Copy checksum mismatch: {target}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["stage", "verify"])
    parser.add_argument("--root", type=Path)
    parser.add_argument("--source-root", type=Path)
    args = parser.parse_args()
    default = Path(os.environ["LOCALAPPDATA"]) / "Ojos" if "LOCALAPPDATA" in os.environ else None
    root = args.root or (default / "model-assets" if default else None)
    source_root = args.source_root or default
    if root is None or (args.command == "stage" and source_root is None):
        parser.error("Provide --root, and --source-root when staging")
    files = json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]
    for item in files:
        path, digest = root / item["path"], item["sha256"]
        if verified(path, digest):
            continue
        if args.command != "stage":
            raise ValueError(f"Missing or changed asset: {path}")
        stage(source_root / item["source"], path, digest)
    print(f"Verified {len(files)} assets in {root.resolve()}")


if __name__ == "__main__":
    main()
