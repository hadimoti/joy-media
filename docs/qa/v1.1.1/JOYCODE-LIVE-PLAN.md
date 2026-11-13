Worst case: 29 model calls (29 model prompts at 1 call each; 30 rows with the Undo press, which makes no call). Written before any live call (T-J05, REQ-02a).

# Joy Code live prompt list (v1.1.1)

This list is written first, so the live pass (T-J06) runs from it and not from memory. Each row is one prompt with a limit of one model call. A repair or retry the app makes counts as a fail for that row, not a second call.

## Rules for every row

- **One call per row.** The Calls column is the most model calls the row may make. The Looks preset and the Undo press make no call and are not prompts.
- **No pictures.** No row asks for a picture or video. ChatGPT sign-in cannot make pictures (`ADDENDUM-03`: `image_generation` is refused by OpenAI), so every refused-tool row uses an editing request instead.
- **`web_search` is allowed** with the ChatGPT sign-in. No row needs it, and it is not used in this list.
- **Scratch profile only.** The sign-out row (SI) and the provider-switch row (NN) run in the scratch profile, never with the owner's real ChatGPT sign-in or provider keys.
- **No network switch-off.** The "no network" row is simulated by a provider switch inside the app (row NN). The PC network is never turned off.
- **Screenshots** are taken after the reply has settled, with the Edit or other tab visible, and the timeline in the same frame where the row names a timeline change.
- **Fixtures.** `F1`: a new project at 1920×1080, 30 fps, with one 10 s video clip on V1 (its sound on A1) and one text title at 0–3 s. Made from the test media fixture pack (T-A04). `F2`: `F1` with a second 8 s clip placed after the first. Both are built in the scratch library (see the launch rule in section 0 of `03-TASK-CARDS.md`), never the owner's library.
- **Settings** rows read the slots and modes in the desktop app (the agent slots are set up there, per the settings wording).

## Edit tab: three natural-language edits (plan, approve, apply, undo)

These three rows are also turns 1 to 3 of the ten-turn conversation (LC-1 to LC-3), so they are counted once.

| #   | Tab  | Exact prompt                                  | Start timeline | Expected reply                                             | Timeline change                                                           | Screenshot                                                | Calls |
| --- | ---- | --------------------------------------------- | -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | ----- |
| E1  | Edit | `Make the first clip 2 seconds shorter.`      | F1             | A preview card: "Review the live preview before applying." | Preview only (clip 8 s). Approve: clip 8 s. Undo: back to 10 s.           | Preview card; timeline after approve; timeline after undo | 1     |
| E2  | Edit | `Set the title text to "Summer Sale".`        | F1             | A preview card                                             | Preview only. Approve: the title reads "Summer Sale". Undo: the old text. | Preview card; Inspector after approve                     | 1     |
| E3  | Edit | `Add a one second fade-in to the first clip.` | F1             | A preview card                                             | Preview only. Approve: a 1 s fade-in on the clip.                         | Preview card; timeline after approve                      | 1     |

## Creative Brief tab

| #   | Tab            | Exact prompt                                                  | Start timeline | Expected reply                                                            | Timeline change                                                   | Screenshot                                          | Calls |
| --- | -------------- | ------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- | ----- |
| CB1 | Creative Brief | `Suggest how to make the 10 second clip feel more energetic.` | F1             | A brief with facts, inferences and recommendations, marked as review only | None. The brief is attached to the next Edit prompt, not applied. | The brief card; the "Brief attached" dot on the tab | 1     |

## Recipes tab: each catalogue recipe once (Run, no typed prompt)

The Recipes tab lists the full catalogue, which includes a "Creative Brief" entry. That entry is covered by CB1 and is not run again here. If the live pass finds it runs as a recipe too, the duplicate is dropped and the count stays at or below 30.

| #   | Tab     | Action                             | Start timeline | Expected reply                                                                  | Timeline change                                                 | Screenshot                              | Calls |
| --- | ------- | ---------------------------------- | -------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- | ----- |
| R1  | Recipes | Run "Watch and Map"                | F1             | Recipe result: a summary of artefacts                                           | None (a summary)                                                | Recipe list with the result             | 1     |
| R2  | Recipes | Run "Find Moment"                  | F1             | A moment list                                                                   | None until approved                                             | Result list                             | 1     |
| R3  | Recipes | Run "Build Rough Cut"              | F2             | Recipe prepared a reversible change; "Review the live preview before applying." | Preview only. Approve: a rough cut from F2.                     | Preview; timeline after approve         | 1     |
| R4  | Recipes | Run "Title and Caption Polish"     | F1             | Prepared change, as R3                                                          | Preview only, then the title is polished on approve             | Preview; Inspector after approve        | 1     |
| R5  | Recipes | Run "Motion and Transition Polish" | F2             | Prepared change, as R3                                                          | Preview only; transition added between the two clips on approve | Preview; the transition on the timeline | 1     |
| R6  | Recipes | Run "Audio Balance"                | F1             | Prepared change, as R3                                                          | Preview only; the clip's audio level changes on approve         | Preview; Inspector audio row            | 1     |
| R7  | Recipes | Run "Verify Deliverable"           | F1             | A verification result                                                           | None (it reads the project and reports)                         | Result text                             | 1     |

## Looks tab

| #   | Tab   | Exact prompt                                       | Start timeline | Expected reply                          | Timeline change                                             | Screenshot                        | Calls |
| --- | ----- | -------------------------------------------------- | -------------- | --------------------------------------- | ----------------------------------------------------------- | --------------------------------- | ----- |
| LK1 | Looks | `Make this project look like a quiet documentary.` | F1             | A Look proposal for "Quiet Documentary" | Preview only; on approve the Look is applied to the project | The Looks tab; Applied Looks list | 1     |

Not a prompt and not counted: applying the built-in preset "Editorial Clean" from the Looks list with no model. It is checked by hand in the same pass and needs no call.

## Both model slots

Both rows send the same prompt; only the slot changes. The slots are set in the desktop app's AI models page.

| #   | Tab  | Exact prompt                                       | Start timeline | Expected reply                       | Timeline change | Screenshot                                | Calls |
| --- | ---- | -------------------------------------------------- | -------------- | ------------------------------------ | --------------- | ----------------------------------------- | ----- |
| S-A | Edit | `In one sentence, what does this project contain?` | F1             | An answer text, from the first slot  | None            | The reply and the slot name shown with it | 1     |
| S-B | Edit | Same prompt                                        | F1             | An answer text, from the second slot | None            | The reply and the slot name               | 1     |

## The four execution modes (Settings > Tools and permissions)

Each row sets the mode, then sends the same prompt in a new thread. The mode names are the ones the settings page shows.

| #   | Tab  | Mode                          | Exact prompt                        | Start timeline | Expected reply                    | Timeline change                           | Screenshot                      | Calls |
| --- | ---- | ----------------------------- | ----------------------------------- | -------------- | --------------------------------- | ----------------------------------------- | ------------------------------- | ----- |
| M1  | Edit | Suggest only                  | `Trim the first clip to 3 seconds.` | F1             | Writes out the change and waits   | None, ever                                | The reply                       | 1     |
| M2  | Edit | Preview and approve (default) | Same prompt                         | F1             | A preview card                    | Preview only until approved; then 3 s     | Preview; timeline after approve | 1     |
| M3  | Edit | Apply safe changes            | Same prompt                         | F1             | A small change applied on its own | Clip 3 s without an approval step         | Timeline without approving      | 1     |
| M4  | Edit | Work on its own               | Same prompt                         | F1             | Applied within the cost limit     | Clip 3 s; the cost shown within the limit | Timeline; the cost line         | 1     |

## Media support check

| #   | Tab                  | Action                                                                           | Start timeline | Expected reply                                                                  | Timeline change | Screenshot       | Calls |
| --- | -------------------- | -------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- | --------------- | ---------------- | ----- |
| MC  | Settings > AI models | Press "Media support check" for the active model. Text only; no picture is sent. | F1             | A result per model: the media support status, and no hidden upgrade of tool use | None            | The check result | 1     |

## Cancel in the middle of a run

| #   | Tab  | Exact prompt                                                                  | Start timeline | Expected reply                              | Timeline change | Screenshot                                    | Calls |
| --- | ---- | ----------------------------------------------------------------------------- | -------------- | ------------------------------------------- | --------------- | --------------------------------------------- | ----- |
| CN  | Edit | `Build a rough cut from all the clips and add titles.` Press Stop within 3 s. | F2             | "JOY run cancelled. No edits were applied." | None            | The cancelled message; the timeline unchanged | 1     |

## No network (simulated by a provider switch)

| #   | Tab  | Action                                                                                                                                                   | Start timeline | Expected reply                                                                        | Timeline change | Screenshot       | Calls |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- | --------------- | ---------------- | ----- |
| NN  | Edit | Switch the active provider profile to an address that refuses connections (`http://127.0.0.1:9`), then send `Shorten the title.` Switch back afterwards. | F1             | A clear "could not reach the model" failure from the message table; no raw error text | None            | The failure card | 1     |

## Expired sign-in (simulated by signing out in another window)

| #   | Tab  | Action                                                                                                       | Start timeline | Expected reply                                                   | Timeline change | Screenshot                     | Calls |
| --- | ---- | ------------------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------- | --------------- | ------------------------------ | ----- |
| SI  | Edit | In a second window, log out of ChatGPT (Settings > AI models). In the first window send `Shorten the title.` | F1             | A "log in again" message from the message table; no call is sent | None            | The message; the Settings link | 1     |

## A refused tool

| #   | Tab  | Mode         | Exact prompt                                | Start timeline | Expected reply                                               | Timeline change | Screenshot | Calls |
| --- | ---- | ------------ | ------------------------------------------- | -------------- | ------------------------------------------------------------ | --------------- | ---------- | ----- |
| RT  | Edit | Suggest only | `Delete the second clip from the timeline.` | F2             | Explains that it can only suggest; the apply step is refused | None            | The reply  | 1     |

## A long conversation: ten turns in one thread

Turns 1 to 3 are E1 to E3 above, sent in this thread in order (counted there, not again). Turns 4 to 10 are LC-4 to LC-10; turn 7 is the Undo press (LC-7), which makes no call.

| #     | Tab  | Exact prompt                                            | Start timeline | Expected reply             | Timeline change              | Screenshot | Calls |
| ----- | ---- | ------------------------------------------------------- | -------------- | -------------------------- | ---------------------------- | ---------- | ----- |
| LC-4  | Edit | `Summarise the changes so far in three bullets.`        | F1             | Answer text, three bullets | None                         | The thread | 1     |
| LC-5  | Edit | `Set the title to start at 1 second.`                   | F1             | Preview card               | Approve: title starts at 1 s | Timeline   | 1     |
| LC-6  | Edit | `Make the title 10 percent bigger.`                     | F1             | Preview card               | Approve: larger title        | Inspector  | 1     |
| LC-7  | Edit | Press Undo for the last change (a button, not a prompt) | F1             | None (no call)             | The last change is undone    | Timeline   | 0     |
| LC-8  | Edit | `Which clip is the longest?`                            | F1             | Answer text                | None                         | The thread | 1     |
| LC-9  | Edit | `Trim the longest clip by one second.`                  | F1             | Preview card               | Approve: one second shorter  | Timeline   | 1     |
| LC-10 | Edit | `List every change in this chat as a numbered list.`    | F1             | Numbered list              | None                         | The thread | 1     |

## Count

| Group                                                  | Model prompts | Calls (worst case) |
| ------------------------------------------------------ | ------------- | ------------------ |
| Edit (E1 to E3, also turns 1 to 3 of the thread)       | 3             | 3                  |
| Creative Brief (CB1)                                   | 1             | 1                  |
| Recipes (R1 to R7, one run each)                       | 7             | 7                  |
| Looks (LK1)                                            | 1             | 1                  |
| Both model slots (S-A, S-B)                            | 2             | 2                  |
| Execution modes (M1 to M4)                             | 4             | 4                  |
| Media support check (MC)                               | 1             | 1                  |
| Cancel (CN)                                            | 1             | 1                  |
| No network (NN)                                        | 1             | 1                  |
| Expired sign-in (SI)                                   | 1             | 1                  |
| Refused tool (RT)                                      | 1             | 1                  |
| Long thread, turns 4 to 10 (LC-4 to LC-10 except LC-7) | 6             | 6                  |
| Undo press in the thread (LC-7)                        | 0             | 0                  |
| **Total**                                              | **29**        | **29**             |

## Not in this list

- Picture and video generation (no pictures, per addendum 03).
- Provider comparisons and the model quality checks (T-A12, the owner present).
- The desktop-only agent slot setup itself; S-A and S-B only use the slots.
