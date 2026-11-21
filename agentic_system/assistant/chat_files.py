"""Bounded, read-only file tools for explicitly configured roots."""

from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess

from pypdf import PdfReader


_EXTENSIONS = set(".txt .md .rst .py .js .mjs .cjs .ts .tsx .jsx .css .html .json .yaml .yml .toml .ini .csv .tsv .log .sql .pdf".split())
_SENSITIVE = re.compile(r"(^|[._-])(secret[s]?|credential[s]?|passwords?|private[_-]?key|tokens?)([._-]|$)", re.I)
_VALUE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[\w-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}"
                    r"|(?:api[_ -]?key|access[_ -]?token|password|authorization)\s*[:=]\s*['\"]?[^\s'\"]{12,}", re.I)
_MAX_FILE = 512 * 1024


def contains_secret(text: str) -> bool:
    return bool(_VALUE.search(text))


def _allowed_part(part):
    return not part.startswith(".") and not _SENSITIVE.search(part) and part.lower() not in {"node_modules", "__pycache__"}


class FileTools:
    def __init__(self, roots):
        self.roots = {
            f"root{index}": root for index, root in enumerate(
                dict.fromkeys(Path(value).expanduser().resolve() for value in roots), 1
            ) if root.is_dir()
        }
        self.rg = shutil.which("rg")

    def path(self, reference):
        if not isinstance(reference, str) or len(reference) > 600 or ":" in reference or "\x00" in reference:
            raise ValueError("Use a file reference returned by list_files.")
        parts = PurePosixPath(reference.replace("\\", "/")).parts
        if len(parts) < 2 or parts[0] not in self.roots or not all(_allowed_part(part) for part in parts[1:]):
            raise ValueError("The file is outside an approved root or is restricted.")
        root = self.roots[parts[0]]
        file = root.joinpath(*parts[1:]).resolve(strict=True)
        if (not file.is_relative_to(root) or not all(_allowed_part(part) for part in file.relative_to(root).parts)
                or not file.is_file() or file.suffix.lower() not in _EXTENSIONS):
            raise ValueError("The file is outside an approved root or is restricted.")
        if file.stat().st_size > _MAX_FILE:
            raise ValueError("The file exceeds the 512 KiB read limit.")
        return file

    def list_files(self, pattern: str = "") -> dict:
        """List approved relative file references, optionally filtered by a filename substring."""
        output = []
        inspected = 0
        for name, root in self.roots.items():
            for folder, dirs, files in os.walk(root):
                dirs[:] = sorted(directory for directory in dirs if _allowed_part(directory)
                                  and Path(folder, directory).resolve().is_relative_to(root)
                                  and not Path(folder, directory).is_symlink())
                for file in sorted(files):
                    inspected += 1
                    ref = f"{name}/{(Path(folder) / file).relative_to(root).as_posix()}"
                    if pattern.casefold() in ref.casefold():
                        try:
                            self.path(ref)
                            output.append(ref)
                        except (OSError, ValueError):
                            pass
                    if len(output) >= 100 or inspected >= 2000:
                        return {"files": output, "truncated": True}
        return {"files": output, "approved_roots": list(self.roots), "truncated": False}

    def _read(self, reference):
        file = self.path(reference)
        with file.open("rb") as handle:
            data = handle.read(_MAX_FILE + 1)
        if len(data) > _MAX_FILE:
            raise ValueError("The file exceeds the 512 KiB read limit.")
        if file.suffix.lower() == ".pdf":
            from io import BytesIO
            reader = PdfReader(BytesIO(data))
            if reader.is_encrypted:
                raise ValueError("The PDF is encrypted.")
            entries = [f"[Page {index + 1}]\n{page.extract_text() or ''}"
                       for index, page in enumerate(reader.pages[:12])]
            text = "\n".join(entries)[:_MAX_FILE]
        else:
            text = data.decode("utf-8-sig")
        if contains_secret(text):
            raise ValueError("The file appears to contain credentials.")
        return data, text

    def read_file(self, reference: str, start_line: int = 1, max_lines: int = 60) -> dict:
        """Read up to 100 lines. Text-based PDFs include page markers."""
        _, text = self._read(reference)
        lines = text.splitlines()
        start = max(1, start_line)
        selected = lines[start - 1:start - 1 + max(1, min(100, max_lines))]
        return {"source": reference, "lines": [f"{n}: {line[:420]}" for n, line in enumerate(selected, start)],
                "total_lines": len(lines)}

    def search_files(self, query: str, filename_filter: str = "") -> dict:
        """Literal text search in approved files. Returns up to 16 line-numbered matches."""
        if not query.strip() or len(query) > 160 or "\n" in query or contains_secret(query):
            raise ValueError("Use a short literal search string.")
        refs = self.list_files(filename_filter)["files"][:36]
        sources, texts = {}, {}
        for ref in refs:
            try:
                file = self.path(ref)
                _, body = self._read(ref)
            except (OSError, ValueError):
                continue
            texts[ref] = body
            if file.suffix.lower() != ".pdf":
                sources[str(file)] = ref
        matches = []
        if self.rg and sources and sum(map(len, sources)) < 20_000:
            # No shell, config file, or model-controlled options.
            env = {name: value for name, value in os.environ.items() if name.lower() in {"systemroot", "windir"}}
            result = subprocess.run([self.rg, "--no-config", "--json", "--fixed-strings", "--ignore-case",
                                     "--max-count", "2", "--", query, *sources],
                                    capture_output=True, timeout=5, env=env, check=False)
            if result.returncode in (0, 1):
                for line in result.stdout.splitlines():
                    item = json.loads(line)
                    if item.get("type") != "match":
                        continue
                    match = item["data"]
                    ref = sources.get(match["path"].get("text"))
                    value = match["lines"].get("text", "").strip()
                    if ref and not contains_secret(value):
                        matches.append({"source": ref, "line": match["line_number"], "text": value[:420]})
                texts = {ref: text for ref, text in texts.items() if ref.lower().endswith(".pdf")}
        needle = query.casefold()
        for ref, text in texts.items():
            for number, line in enumerate(text.splitlines(), 1):
                if needle in line.casefold():
                    matches.append({"source": ref, "line": number, "text": line[:420]})
        return {"matches": matches[:16], "files_searched": len(refs)}

    def ingest(self, reference):
        data, text = self._read(reference)
        lines = text.splitlines()
        passages = []
        for offset in range(0, min(len(lines), 1600), 25):
            batch = lines[offset:offset + 25]
            passages.append((f"lines {offset + 1}–{offset + len(batch)}", "\n".join(line[:160] for line in batch)))
        if not passages:
            raise ValueError("No text was extracted.")
        return sha256(data).hexdigest(), passages
