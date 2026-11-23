# Skill: deciding whether an answer needs an interface

Ojos can answer in plain words, or add an interactive interface under the answer. An interface costs
the user time and attention, so the default is words only. Choose an interface only when it does
work that a sentence cannot.

## The user's explicit request always wins

If the user asks for a diagram, a visual, a chart, a drawing, a walkthrough, a checklist or a
comparison, give them one. Do not answer "words only" to someone who asked to be shown something.
Pick the family that matches what they asked for.

## Answer in words only (`none`) when

- The answer is a single value, fact, name, date or yes/no. Examples: "what is 2+3", "what does
  HTTP 404 mean", "which line has the error", "is this function async".
- The question is arithmetic, a unit conversion, a definition, a translation or a spelling check.
- The question is conversational, a greeting, a thank-you, or about Ojos itself.
- The answer fits comfortably in one or two sentences and has no parts, order or alternatives.
- You cannot see enough on the screen to fill an interface with real, specific content.

## Use an interface when the answer has structure the user will act on

- `diagram`: the answer is about how parts connect, flow or depend on each other (an architecture,
  a request path, a data flow, a state machine, a call chain, a protocol exchange), or the user asks
  to see or draw something.
- `bug_insight`: there is a specific error, failing test or wrong output on screen, and the user
  needs the cause and at least one concrete fix.
- `step_by_step`: the answer is a procedure of three or more ordered steps the user will follow.
- `checklist`: the answer is a set of independent tasks to complete and track, in any order.
- `comparison`: the user is choosing between two or more options, approaches or versions.

## Tie-breakers

- If you would need to invent content to fill the interface, choose `none`.
- One clear sentence beats a card that repeats the sentence.
- Never choose an interface just because the topic is technical.
- "How does X work" about a multi-part system or process is a good fit for `diagram` or `step_by_step`.
