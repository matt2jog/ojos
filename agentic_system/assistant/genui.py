"""Generative UI for the chat agent, using A2UI (Agent-to-User Interface) v0.9.

1. A skill (skills/when_to_show_ui.md) says when an interface is worth showing at all.
2. gemini-decision-1 (Decisions API) applies that skill to the screen frame and the question:
   a yes/no "is an interface worth it" plus a choice of interface family.
3. For anything but "none", the ADK agent gets one extra tool, render_ui. It composes components
   from the Ojos catalog as an A2UI component tree; this module validates the tree and emits
   standard A2UI v0.9 messages (createSurface, updateComponents, updateDataModel).
4. The desktop renders those messages with @a2ui/react and its own React components. Button
   presses come back as A2UI actions, which the agent answers in the next turn.
"""

import base64
import json
import logging
import os
import re
import time
import urllib.request
from pathlib import Path

LOG = logging.getLogger(__name__)
DECISION_MODEL = os.environ.get("GEMINI_DECISION_MODEL", "gemini-decision-1")
DECISIONS_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"
A2UI_VERSION = "v0.9"
CATALOG_ID = "https://github.com/matt2jog/ojos/catalogs/assist/v1.json"
SKILL = (Path(__file__).parent / "skills" / "when_to_show_ui.md").read_text(encoding="utf-8")
WORTH_IT = 0.55
MAX_COMPONENTS = 24
MAX_SPEC = 20_000

UI_KINDS = {
    "none": "Words only. A single value, fact, definition, calculation, yes/no, or anything that fits in one or "
            "two sentences with no parts, order or alternatives.",
    "bug_insight": "A specific error, failing test or wrong output is visible, and the user needs its cause and a concrete fix.",
    "step_by_step": "The answer is a procedure of three or more ordered steps the user will follow.",
    "checklist": "The answer is a set of independent tasks to complete and track, in any order.",
    "comparison": "The user is choosing between two or more options, approaches or versions.",
}
LEAD = {"bug_insight": "BugInsight", "step_by_step": "StepByStepGuide", "checklist": "ActionChecklist",
        "comparison": "ComparisonCard"}

# name -> (required props, optional props). Kept in step with the desktop catalog (a2ui/catalog.tsx).
CATALOG = {
    "Stack": ({"children"}, set()),
    "Note": ({"text"}, {"tone"}),
    "ActionButton": ({"label", "action"}, set()),
    "BugInsight": ({"title", "explanation"}, {"location", "severity", "code", "fixes", "children"}),
    "StepByStepGuide": ({"title", "steps"}, {"onDone", "children"}),
    "ActionChecklist": ({"title", "items"}, {"progress", "onSubmit"}),
    "ComparisonCard": ({"title", "options"}, set()),
}

CATALOG_DOC = """Ojos A2UI catalog. Each component is a JSON object {"id": "<unique id>", "component": "<Name>", ...props}.
Exactly one component must have id "root". Children are referenced by id.
String props accept a literal or a data binding {"path": "/some/key"} into the data model.
An action is {"event": {"name": "<snake_case_name>", "context": {"label": "<what the user chose>", ...}}}.
Pressing it sends you that name and context as the next user turn, so you can respond and update the interface.

- Stack: {"children": ["id", ...]}  Vertical group. Use it as root to compose several components.
- Note: {"text": str, "tone"?: "info"|"success"|"warning"}  One short line of context.
- ActionButton: {"label": str, "action": Action}  A follow-up the user can trigger.
- BugInsight: {"title": str, "explanation": str, "location"?: str (file:line or where on screen),
    "severity"?: "error"|"warning"|"info", "code"?: str (the offending snippet),
    "fixes"?: [{"label": str, "detail"?: str, "code"?: str (the corrected snippet), "action"?: Action}],
    "children"?: ["id", ...]}
- StepByStepGuide: {"title": str, "steps": [{"title": str, "detail": str, "code"?: str}], "onDone"?: Action,
    "children"?: ["id", ...]}
- ActionChecklist: {"title": str, "items": [{"label": str, "detail"?: str}], "progress"?: {"path": "/checklist/done"},
    "onSubmit"?: Action}  Bind progress to a path and reference the same path in onSubmit's context to learn what is done.
- ComparisonCard: {"title": str, "options": [{"name": str, "summary"?: str, "pros"?: [str], "cons"?: [str],
    "recommended"?: bool, "action"?: Action}]}

Example call argument (a JSON string):
{"components": [
  {"id": "root", "component": "Stack", "children": ["bug", "next"]},
  {"id": "bug", "component": "BugInsight", "title": "user is None on line 14", "severity": "error",
   "location": "app.py:14", "explanation": "get_user() returns None when no row matches, so user['name'] fails.",
   "code": "name = user['name']",
   "fixes": [{"label": "Guard against None", "code": "if user is None:\\n    return not_found()",
              "action": {"event": {"name": "apply_fix", "context": {"label": "Guard against None"}}}}]},
  {"id": "next", "component": "ActionButton", "label": "Show me how to test this",
   "action": {"event": {"name": "explain_testing", "context": {"label": "How to test the fix"}}}}
], "data": {}}"""

_TRIVIAL = re.compile(
    r"^\s*(?:what(?:'s| is)\s+|calculate\s+|compute\s+|solve\s+)?[\d\s+\-*/×÷^%().,=x]+\??\s*$", re.I)
_SMALL_TALK = re.compile(r"^\s*(?:hi|hello|hey|thanks|thank you|ok|okay|cool|nice|yes|no|bye)\b[\s!.?]*$", re.I)


def trivially_textual(question):
    """Cheap guard applied before any model call: arithmetic and small talk never get an interface."""
    q = question.strip()
    return bool(_TRIVIAL.match(q) or _SMALL_TALK.match(q) or len(q) < 8)


def decide_ui(api_key, jpeg, question):
    """Returns {"kind", "confidence", "worth_it", "probabilities", "ms", "model", "reason"}; "none" on any failure."""
    started = time.monotonic()
    result = {"kind": "none", "confidence": 0.0, "worth_it": 0.0, "probabilities": {}, "model": DECISION_MODEL,
              "reason": "", "ms": 0}
    if question.startswith("[UI action]"):
        # A button press on an interface: let the agent update it without re-deciding.
        return {**result, "kind": "followup", "confidence": 1.0, "worth_it": 1.0, "reason": "ui_action"}
    if trivially_textual(question):
        return {**result, "confidence": 1.0, "reason": "trivial_question"}
    blocks = [{"type": "text", "text": f'The user looked confused at their screen and asked: "{question[:2000]}"'}]
    if jpeg:
        blocks.insert(0, {"type": "image", "data": base64.b64encode(jpeg).decode("ascii"),
                          "mime_type": "image/jpeg", "resolution": "low"})
    body = {"model": DECISION_MODEL, "input": blocks, "questions": {
        "worth_it": {
            "type": "noul",
            "instructions": "Apply this skill. Would an interactive interface do work for this user that one or two "
                            "plain sentences cannot?\n\n" + SKILL,
            "criteria": {"true_description": "The answer has structure the user will act on: a bug with fixes, ordered "
                                             "steps, tasks to track, or options to compare.",
                         "false_description": "A value, fact, calculation, definition or short explanation is enough."},
        },
        "ui": {"type": "choice", "instructions": "Apply this skill and choose the presentation.\n\n" + SKILL,
               "criteria": UI_KINDS},
    }}
    try:
        request = urllib.request.Request(
            DECISIONS_URL, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=8) as response:
            answers = json.loads(response.read())["answers"]
        worth, choice = answers.get("worth_it", {}), answers.get("ui", {})
        result["worth_it"] = float(worth.get("noul") or 0)
        result["probabilities"] = {k: float(v) for k, v in (choice.get("probabilities") or {}).items()}
        kind = choice.get("choice") if choice.get("choice") in UI_KINDS else "none"
        if kind != "none" and result["worth_it"] < WORTH_IT:
            kind, result["reason"] = "none", "not_worth_an_interface"
        result.update(kind=kind, confidence=float(choice.get("confidence") or 0))
    except Exception as error:  # the interface is optional; the written answer must not depend on it
        LOG.warning("UI decision failed (%s); answering in words only", type(error).__name__)
        result["reason"] = "decision_unavailable"
    result["ms"] = round((time.monotonic() - started) * 1000)
    LOG.info("UI decision: %s (worth_it %.2f) in %s ms", result["kind"], result["worth_it"], result["ms"])
    return result


def skill(kind):
    """Instruction text added when the decision allows an interface."""
    lead = (f'A decision model chose the interface family "{kind}", so lead with {LEAD[kind]}.' if kind in LEAD else
            "The user pressed a button on the interface you rendered. Respond to it, and call render_ui again "
            "if an updated or follow-up interface helps (for example the next step, or the applied fix).")
    return (
        "\n\nYou can show an interactive interface under your answer with the render_ui tool. " + lead +
        " Call render_ui at most once, BEFORE writing, then give a short written answer as your final message "
        "(never empty, and do not repeat the interface's content). Compose components freely: nest related "
        "components with children, and add ActionButton follow-ups the user is likely to want. Fill every field "
        "with the real names, values, file paths and code visible on the user's screen. Never invent content to "
        "fill a card. If nothing structured is warranted after all, skip the tool.\n\n" + CATALOG_DOC
    )


def _validate(spec):
    if not isinstance(spec, dict) or not isinstance(spec.get("components"), list):
        raise ValueError('Pass a JSON object with a "components" list.')
    components = spec["components"]
    if not 0 < len(components) <= MAX_COMPONENTS:
        raise ValueError(f"Use between 1 and {MAX_COMPONENTS} components.")
    ids = set()
    for item in components:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            raise ValueError('Every component needs a string "id".')
        name = item.get("component")
        if name not in CATALOG:
            raise ValueError(f'Unknown component "{name}". Use one of: {", ".join(CATALOG)}.')
        if item["id"] in ids:
            raise ValueError(f'Duplicate component id "{item["id"]}".')
        ids.add(item["id"])
        required, optional = CATALOG[name]
        props = set(item) - {"id", "component"}
        if missing := required - props:
            raise ValueError(f'{name} "{item["id"]}" is missing: {", ".join(sorted(missing))}.')
        if extra := props - required - optional:
            raise ValueError(f'{name} "{item["id"]}" has unknown properties: {", ".join(sorted(extra))}.')
        for key in ("steps", "items", "options", "fixes"):
            if key in item and (not isinstance(item[key], list) or not all(isinstance(row, dict) for row in item[key])):
                raise ValueError(f'{name}.{key} must be a list of objects.')
        if name == "StepByStepGuide" and len(item["steps"]) < 2:
            raise ValueError("A StepByStepGuide needs at least two steps.")
    if "root" not in ids:
        raise ValueError('One component must have the id "root".')
    for item in components:
        for child in item.get("children") or []:
            if child not in ids or child == item["id"]:
                raise ValueError(f'"{item["id"]}" references a missing child "{child}".')
    data = spec.get("data", {})
    if not isinstance(data, dict):
        raise ValueError('"data" must be an object.')
    return components, data


def messages(surface_id, components, data):
    """The standard A2UI v0.9 message sequence for one surface."""
    return [
        {"version": A2UI_VERSION, "createSurface": {"surfaceId": surface_id, "catalogId": CATALOG_ID}},
        {"version": A2UI_VERSION, "updateComponents": {"surfaceId": surface_id, "components": components}},
        {"version": A2UI_VERSION, "updateDataModel": {"surfaceId": surface_id, "path": "/", "value": data}},
    ]


def ui_tool(surface_id, emit):
    """The one extra tool the agent gets when the decision allows an interface."""
    shown = False

    def render_ui(a2ui_json: str) -> dict:
        """Show an interactive interface under the answer. Pass a JSON string {"components": [...], "data": {...}}
        built from the Ojos A2UI catalog. Call once, before writing the answer."""
        nonlocal shown
        if shown:
            raise ValueError("Only one interface per answer.")
        if len(a2ui_json) > MAX_SPEC:
            raise ValueError("Keep the interface under 20,000 characters.")
        try:
            spec = json.loads(a2ui_json)
        except json.JSONDecodeError as error:
            raise ValueError(f"a2ui_json is not valid JSON: {error.msg} at position {error.pos}.") from None
        components, data = _validate(spec)
        shown = True
        emit("turn.a2ui", {"surfaceId": surface_id, "messages": messages(surface_id, components, data)})
        return {"shown": True, "components": len(components)}

    return render_ui
