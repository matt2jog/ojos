"""Generative UI, gated by the Gemini Decisions API.

gemini-decision-1 sees the screen frame and the question and chooses one presentation from a fixed
list. "none" means a written answer only. Any other choice gives the ADK agent one extra tool,
render_visual, plus the skill text for that presentation type.
"""

import base64
import json
import logging
import os
import time
import urllib.request

LOG = logging.getLogger(__name__)
DECISION_MODEL = os.environ.get("GEMINI_DECISION_MODEL", "gemini-decision-1")
DECISIONS_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"
MAX_HTML = 24_000

# The enumerable the decision model chooses from.
UI_KINDS = {
    "none": "No visual. A short written explanation is enough, or the question is simple, conversational or factual.",
    "diagram": "A static labelled diagram: boxes and arrows, a flow, a structure, or an annotated picture of how "
               "the parts relate. Nothing to click.",
    "steps": "A step-by-step walkthrough the user clicks through one step at a time, for a process, an algorithm "
             "or a sequence of events.",
    "comparison": "A side-by-side or before/after comparison, or a small table contrasting two or more options, "
                  "values or versions.",
    "interactive": "A dynamic widget with a control such as a slider, toggle or input, for a relationship the user "
                   "should explore by changing a value.",
}

# The skill handed to the agent for each choice.
SKILLS = {
    "diagram": "Build a STATIC labelled diagram with inline SVG or HTML/CSS. No <script>, no inputs, no buttons.",
    "steps": "Build a step-by-step walkthrough: 3 to 5 steps, one visible at a time, with Back and Next buttons and "
             "a step indicator. A short inline script may switch steps. No other inputs.",
    "comparison": "Build a STATIC side-by-side or before/after comparison (two columns or a small table) with the "
                  "differences highlighted. No <script>, no inputs.",
    "interactive": "Build a small interactive widget with one or two controls (slider, toggle or number input) that "
                   "update a visual live. Keep the inline script short.",
}

HTML_RULES = (
    "The html argument must be a complete, fully self-contained HTML document: inline <style> only (and inline "
    "<script> only if the presentation type allows it), with no external scripts, stylesheets, fonts, images or "
    "network requests. It renders in a 340px-wide dark panel: body margin 0, transparent background, text #ececec, "
    "13px system-ui, at most about 260px tall, no horizontal scrolling. Accent colors #4285f4, #34a853, #fbbc05, "
    "#ea4335. Use the real names, values and text from the user's screen. End with a one-line caption."
)


def decide_ui(api_key, jpeg, question):
    """Returns {"kind", "confidence", "probabilities", "ms", "model"}. Falls back to "none" on any failure."""
    started = time.monotonic()
    blocks = [{"type": "text", "text": f'The user looked confused at their screen and asked: "{question[:2000]}"'}]
    if jpeg:
        blocks.insert(0, {"type": "image", "data": base64.b64encode(jpeg).decode("ascii"),
                          "mime_type": "image/jpeg", "resolution": "low"})
    body = {
        "model": DECISION_MODEL, "input": blocks,
        "questions": {"ui": {
            "type": "choice",
            "instructions": "Which kind of generated visual, if any, should accompany the written answer to this question?",
            "criteria": UI_KINDS,
        }},
    }
    result = {"kind": "none", "confidence": 0.0, "probabilities": {}, "model": DECISION_MODEL}
    try:
        request = urllib.request.Request(
            DECISIONS_URL, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            answer = json.loads(response.read())["answers"]["ui"]
        if answer.get("choice") in UI_KINDS:
            result.update(kind=answer["choice"], confidence=float(answer.get("confidence") or 0),
                          probabilities={key: float(value) for key, value in (answer.get("probabilities") or {}).items()})
    except Exception as error:  # the visual is optional; the written answer must not depend on it
        LOG.warning("UI decision failed (%s); answering in text only", type(error).__name__)
    result["ms"] = round((time.monotonic() - started) * 1000)
    LOG.info("UI decision: %s (%.0f%%) in %s ms", result["kind"], result["confidence"] * 100, result["ms"])
    return result


def skill(kind):
    """Instruction text added for a non-"none" decision."""
    return (
        f'\n\nA decision model chose the presentation type "{kind}" for this answer. Call render_visual exactly once '
        f"BEFORE writing anything, then give your written answer as your final message (it must not be empty, and "
        f"should not repeat the visual's markup). {SKILLS[kind]} {HTML_RULES}"
    )


def visual_tool(kind, emit):
    """The one extra tool the agent gets when the decision is not "none"."""
    shown = False

    def render_visual(html: str) -> dict:
        """Show a generated visual under the written answer. Call once, before writing the answer."""
        nonlocal shown
        if shown:
            raise ValueError("Only one visual per answer.")
        html = html.strip()
        if not html or len(html) > MAX_HTML or "<" not in html:
            raise ValueError("Provide one self-contained HTML document of at most 24,000 characters.")
        if kind in {"diagram", "comparison"} and "<script" in html.lower():
            raise ValueError(f'The "{kind}" presentation is static. Remove the script and inputs, then call again.')
        shown = True
        emit("turn.widget", {"kind": kind, "html": html})
        return {"shown": True}

    return render_visual
