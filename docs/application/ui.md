# Desktop popup and Ojos app

**Work in progress.** This is the current UI direction for the [Ojos product brief](../product.md). The app experience will take shape as we prototype. The [shared data contract](../protocol.md) is the starting point for integration.

## Current direction

Ojos offers help through an OS-level popup. Opening it brings the user into the Ojos help experience. Gemini is a visual reference for it.

The [overlay prototype](../../prototypes/doodle/docs/overlay.md) is the first working version of this direction. The popup is a mascot that appears at the edge of the screen and shows two or three suggested questions in a thought bubble, one at a time. Picking one shows a short answer in the mascot's own bubble, on top of the task the user is working on. The user can follow up there or open a chat box to type their own question, and can drag the mascot anywhere on screen. A separate setup window handles permissions, display choice and eye calibration, and the app otherwise lives in the menu bar or tray.

## Decisions so far

| Question | Prototype answer | Still open |
| --- | --- | --- |
| How the app appears alongside the task | A transparent, click-through overlay on the selected display. The setup window is standalone. | Whether a standalone app window is also needed for history or longer help |
| How help is presented and what the user can do next | Suggested questions first, never an unprompted answer. The chosen question gets a short streamed answer in the mascot's bubble, with typed or suggested follow-ups below it. Optional doodles can draw on the screen. | Read aloud, and how to show the assistant’s summary and evidence |
| What the popup says and how it behaves | The mascot with a one-at-a-time thought bubble, keyboard shortcuts to pick a question, a chat button, and a 15 s timeout when ignored | Wording when the assistant returns insufficient evidence, and final styling |

The [desktop design](../desktop-gemini.md#sidebar-and-chat) sketches an immediate sidebar. Use it as a technical reference when scoping the popup and app. When screen context is captured or sent for analysis is an open implementation decision alongside that experience.
