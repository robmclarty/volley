# volley

<!--
keyframes.md holds the intent behind this project: what it's for, what matters, what must hold,
and how it should feel. People write it. Everyone who works here, human or agent, works from it.
Keep it short enough to read in ten minutes. Every section is optional. Delete these comments
whenever you like, and run `keyframes check` after you edit.
-->

## Intent

<!--
Why does this exist, and who is it for? What should it feel like to use? What does "good" look
like? What is it deliberately not? Write it the way you'd explain it to a new teammate.
-->

## Principles

<!--
The values that settle judgment calls when nothing else does. For example:

- **P1 (no-lost-work)**: Losing someone's work is worse than being slow.
  - because: people forgive a spinner; they don't forgive a blank page.
-->

## Map

<!--
The main parts, seven or fewer: what each is for, and where each lives. For example:

- **M1 (api)**: The HTTP API: requests in, events out.
  - paths: src/api/

A Mermaid diagram is welcome here. It's a picture, and nothing checks it.
-->

## Constraints

<!--
Things that must always be true. Breaking one is a bug. Say what checks it, if anything does:

- **C1 (one-writer)**: Only the sync worker writes to the database.
  - because: two writers made the replay disagree with the live state.
  - held-by: file:test/writes.test.ts#"only the sync worker writes"

Write `held-by: review` if a person checks it. Add (new) after a pointer that doesn't exist yet.
-->

## Scenarios

<!--
Journeys the system must support, a sentence or two each:

- **S1 (offline-edit)**: Someone edits on a plane, lands, and their changes sync without a prompt.
  - held-by: review
-->

## Decisions

<!--
Choices made, and why. When a decision changes, don't delete it: add the new one, and mark the
old one `superseded-by: D2`.

- **D1 (sqlite)**: One SQLite file holds all state.
  - because: one boring database beats two clever ones.
-->

## Taste

<!--
How it should look, read and feel:

- **T1 (calm-errors)**: Error messages are calm, specific, and say what to do next.
-->

## Questions

<!--
Questions that still need an answer. When one is settled, record a decision and mark the question
`resolved-by: D3`.

- **Q1 (sharing)**: Should plans be shareable by link, or is that a different product?
-->

## Ideas

<!--
Things worth considering someday: possibilities, hunches, directions. Writing one down doesn't
mean anyone agreed to it. If one is taken up or turned down, record a decision and mark the idea
`resolved-by: D4`.

- **I1 (dark-mode)**: A dark theme that follows the system setting.
-->
