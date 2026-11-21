# Ojos product brief

**Work in progress.** The MVP, product direction, assistant approach, UI, and proposed repo layout can evolve as we build and test. Use the [version 1 shared data contract](protocol.md) as the stable baseline for current integration. Coordinate changes to payloads, timestamps, or gaze coordinates with the teams that produce and consume them, then update the protocol and replay fixtures together.

## Product goal

Longer term, Ojos aims to offer timely help across everyday desktop tasks, such as reading an unfamiliar Wikipedia article, following a tutorial, or debugging. When the vision system reports a possible stuck moment, Ojos uses screen context to understand the specific task and offer a relevant explanation or next step, without requiring the person to type the first question.

> Get help based on what just happened on your screen.

## Current MVP

The participant works through Matt’s demo questions page, which mixes easy questions with deliberately hard or potentially unsolvable ones. For our part of the MVP, assume Matt’s side delivers a signal about when the participant got stuck and the related information it has available. Our job is to use relevant screen context to work out what the participant is doing and offer help with that task.

The current UI direction is an OS-level popup that opens the Ojos help experience. The [overlay prototype](../prototypes/doodle/docs/overlay.md) implements it as a mascot with suggested questions and an answer panel on top of the task. The rest of the app experience is still being scoped. For a question with missing information, useful help could mean explaining what is missing or asking a short follow-up. See the [UI draft](application/ui.md).

Matt’s side owns training, gaze estimation, and figuring out when to send the signal. Our side begins at the handoff and owns screen context, the assistant’s response, and the desktop experience. The shared protocol describes a timed interval and a separate stream of gaze estimates with validity and uncertainty. A replay event can stand in for a live handoff during development. See the [vision design](vision.md) and [shared protocol](protocol.md#vision-to-desktop).

## How the assistant gets context

The assistant needs screen context from around the indicated moment. Timing helps locate the relevant context, and available gaze estimates can narrow down which part of the screen to inspect. On Wikipedia, that could mean matching gaze to a visible paragraph and explaining an unfamiliar term there. The screen content and the task are what the assistant uses to decide what help applies.

The [desktop design](desktop-gemini.md#capture-and-mp4-export) proposes a rolling screen recording and short MP4 exports. That would preserve the lead-up, including scrolling or earlier actions. A still image might be enough for a static question. Choose the context source based on what the assistant needs to answer the demo task. Capture, storage, and any transfer for analysis are open decisions. If a choice changes the [shared data format](protocol.md#desktop-to-backend), review it with the affected components’ owners.

## Fill in as we go

- Pick what useful help looks like on the demo questions. Decide when a hint, explanation, or clarification makes sense.
- Choose the screen context the assistant needs and how it will use that input. Decide how that context is handled before writing capture or analysis copy.
- Scope the popup and desktop app experience.
- After the MVP, refine the target audience and public positioning around the tasks Ojos can help with.

## Where things go

Use this brief for product decisions and [the application UI note](application/ui.md) for interaction and visual direction. Refer to the existing [desktop and Gemini design](desktop-gemini.md), [vision design](vision.md), and [shared protocol](protocol.md) for the technical contracts.

One possible code layout is `vision/` for the vision team’s work, `application/desktop/` for the app and its frontend, and `application/backend/` for jobs and the assistant. Revisit this as we build.
