"""Cloud Run endpoints for clip analysis and the desktop's Gemini model calls."""

import hmac
import os
import re
import shutil
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .baseline import DEFAULT_BASELINE_MODEL, BaselineAnalyzer
from .gemini import GeminiProvider, ProviderError
from .media import load_bundle
from .server import MAX_BODY_BYTES, _json_bytes, _multipart, _parse_bearer

GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com"
MODEL_ROUTE = re.compile(
    r"/v1beta/models/([a-z0-9.-]+):(generateContent|streamGenerateContent|countTokens)(\?alt=sse)?"
)
CLIP_FIELDS = {"manifest", "gaze", "video"}
MODEL_BODY_LIMIT = 8 * 1024 * 1024


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class CloudHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(45)
        super().setup()

    def log_message(self, _format, *_args):
        pass

    def json_response(self, status, payload):
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.json_response(HTTPStatus.OK, {"status": "ok", "gemini_configured": bool(self.server.key())})
        else:
            self.json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self):
        try:
            self._post()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def _post(self):
        bearer = _parse_bearer(self.headers.get("Authorization")).encode()
        if not hmac.compare_digest(bearer, self.server.token):
            self.json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        clip = self.path == "/v1/analyze"
        upstream = self.path.removeprefix("/gemini") if self.path.startswith("/gemini/") else ""
        match = MODEL_ROUTE.fullmatch(upstream)
        model_request = match and match[1] in self.server.models
        if not (clip or model_request or upstream == "/v1beta/decisions"):
            self.json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        key = self.server.key()
        if not key:
            self.json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "gemini_unconfigured"})
            return
        limit = MAX_BODY_BYTES if clip else MODEL_BODY_LIMIT
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = 0
        if length <= 0 or length > limit:
            status = HTTPStatus.REQUEST_ENTITY_TOO_LARGE if length > limit else HTTPStatus.BAD_REQUEST
            self.json_response(status, {"error": "invalid_content_length"})
            return

        body = self.rfile.read(length)
        if len(body) != length:
            self.json_response(HTTPStatus.BAD_REQUEST, {"error": "incomplete_request"})
        elif clip:
            self._analyze(key, body)
        else:
            self._model(key, upstream, body)

    def _analyze(self, key, body):
        try:
            fields = _multipart(body, self.headers.get("Content-Type", ""), CLIP_FIELDS)
            with tempfile.TemporaryDirectory(prefix="ojos-cloud-") as path:
                bundle = Path(path)
                for field, name in (("manifest", "manifest.json"), ("gaze", "gaze.json"), ("video", "video.mp4")):
                    (bundle / name).write_bytes(fields[field])
                clip = load_bundle(bundle)
                result = self.server.analyzer(key).analyze(clip)
        except (ValueError, UnicodeError):
            self.json_response(HTTPStatus.BAD_REQUEST, {"error": "invalid_clip"})
            return
        except ProviderError as error:
            self.json_response(HTTPStatus.BAD_GATEWAY, {"error": "provider_error", "message": str(error)})
            return
        self.json_response(HTTPStatus.OK, result.screen_analysis)

    def _model(self, key, path, body):
        # Forward only model methods used by Ojos. Discard client headers and reject redirects.
        request = Request(GOOGLE_ENDPOINT + path, data=body, method="POST",
                          headers={"Content-Type": "application/json", "x-goog-api-key": key})
        try:
            response = self.server.upstream.open(request, timeout=90)
        except HTTPError as error:
            with error:
                status = error.code if 400 <= error.code <= 599 else HTTPStatus.BAD_GATEWAY
                self.json_response(status, {"error": {"code": status, "message": "Gemini model request failed."}})
            return
        except (OSError, URLError):
            self.json_response(HTTPStatus.BAD_GATEWAY, {"error": "provider_unavailable"})
            return

        with response:
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            # read1 sends whatever the provider has already streamed without waiting for a full buffer.
            while chunk := response.read1(64 * 1024):
                self.wfile.write(chunk)


def gemini_key():
    secret_file = os.environ.get("OJOS_GEMINI_KEY_FILE")
    if secret_file:
        try:
            key = Path(secret_file).read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return ""
    else:
        key = os.environ.get("GEMINI_API_KEY", "").strip()
    return "" if key == "unconfigured" else key


def build_server(port, token, key, analyzer, *, host="127.0.0.1", model=DEFAULT_BASELINE_MODEL):
    token = token.strip()
    if len(token) < 32:
        raise ValueError("A cloud access token of at least 32 characters is required")
    server = ThreadingHTTPServer((host, port), CloudHandler)
    server.token = token.encode()
    server.key = key
    server.analyzer = analyzer
    server.models = {model, "gemini-4-hydrogen", "gemini-4-neon",
                     *os.environ.get("OJOS_ALLOWED_MODELS", "").split(",")} - {""}
    server.upstream = build_opener(_NoRedirect())
    return server


def main():
    if not shutil.which("ffprobe") or not shutil.which("ffmpeg"):
        raise SystemExit("Ojos Cloud Run requires FFmpeg and FFprobe.")
    model = os.environ.get("OJOS_CLIP_MODEL", DEFAULT_BASELINE_MODEL)
    with build_server(
        int(os.environ.get("PORT", "8080")),
        os.environ.get("OJOS_CLOUD_TOKEN", ""),
        gemini_key,
        lambda key: BaselineAnalyzer(
            GeminiProvider(key, model, timeout=60),
            include_audio=os.environ.get("OJOS_CLIP_PLAYBACK_AUDIO") == "1",
        ),
        host="0.0.0.0",
        model=model,
    ) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
