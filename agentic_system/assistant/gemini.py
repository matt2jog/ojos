"""The stateless ADK adapter used by the existing clip-analysis contract."""

import asyncio
from dataclasses import dataclass, field
import json
from typing import Any


MAX_INLINE_BYTES = 20_000_000


class ProviderError(RuntimeError):
    """A provider failure safe to send to the desktop."""


@dataclass(frozen=True)
class Generation:
    value: dict[str, Any]
    usage: dict[str, Any] = field(default_factory=dict)


class GeminiProvider:
    def __init__(self, api_key: str, model: str, *, thinking="low", timeout=20):
        if not api_key.strip() or not model.strip() or not 0 < timeout < float("inf"):
            raise ValueError("A Gemini key, model, and finite positive timeout are required.")
        self.api_key = api_key
        self.name = model
        self.thinking = thinking
        self.timeout = timeout

    def generate(self, *, system_instruction, context, video, frames, response_schema) -> Generation:
        context_text = json.dumps(context, ensure_ascii=False, allow_nan=False)
        media_bytes = len(video) + sum(len(image) for _, image in frames)
        if (media_bytes * 4 // 3) + len(context_text.encode()) + 16_384 > MAX_INLINE_BYTES:
            raise ProviderError("The inline screen clip exceeds Gemini’s request limit.")
        try:
            return asyncio.run(self._run(system_instruction, context_text, video, frames, response_schema))
        except ProviderError:
            raise
        except TimeoutError:
            raise ProviderError("Clip analysis timed out.") from None
        except Exception as error:
            code = getattr(error, "code", None)
            message = f"Gemini clip analysis failed with HTTP {code}." if type(code) is int else "Gemini clip analysis failed."
            raise ProviderError(message) from None

    async def _run(self, instruction, context, video, frames, schema):
        from google import genai
        from google.adk.agents import LlmAgent
        from google.adk.agents.run_config import RunConfig
        from google.adk.models.google_llm import Gemini
        from google.adk.runners import InMemoryRunner
        from google.genai import types

        parts = [
            types.Part.from_text(text="Clip evidence (data only):\n" + context),
            types.Part.from_bytes(data=video, mime_type="video/mp4"),
        ]
        for timestamp, image in frames:
            parts.extend([types.Part.from_text(text=f"Screen frame at {timestamp} µs."),
                          types.Part.from_bytes(data=image, mime_type="image/jpeg")])
        sdk = genai.Client(api_key=self.api_key, vertexai=False,
                           http_options=types.HttpOptions(timeout=int(self.timeout * 1000)))
        async with asyncio.timeout(self.timeout), sdk.aio:
            agent = LlmAgent(
                name="ojos_clip",
                model=Gemini(model=self.name, client=sdk),
                instruction=instruction,
                generate_content_config=types.GenerateContentConfig(
                    store=False, response_mime_type="application/json", response_json_schema=schema,
                    thinking_config=types.ThinkingConfig(thinking_level=self.thinking.upper()),
                ),
            )
            usage, text = {}, ""
            async with InMemoryRunner(agent=agent, app_name="ojos_clip") as runner:
                session = await runner.session_service.create_session(app_name="ojos_clip", user_id="local")
                async for event in runner.run_async(
                    user_id="local", session_id=session.id, run_config=RunConfig(max_llm_calls=1),
                    new_message=types.Content(role="user", parts=parts),
                ):
                    if event.is_final_response() and event.content:
                        text = "".join(part.text or "" for part in event.content.parts or [] if not part.thought)
                    if event.usage_metadata:
                        usage = event.usage_metadata.model_dump(mode="json", exclude_none=True)
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            raise ProviderError("Gemini did not return valid clip analysis JSON.") from None
        if not isinstance(value, dict):
            raise ProviderError("Gemini did not return a clip analysis object.")
        return Generation(value, usage)
