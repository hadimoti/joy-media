# Joy Code messages (T-J01, v1.1.1)

Owner items OB-13a and OB-13c. Plain messages for every Joy Code failure, shown as one calm card.

**Where the table lives:** `apps/editor-web/src/joy-code-messages.ts` (`JOY_CODE_MESSAGES`).
Every reason, failure code and run error code has one entry: a title, one plain sentence and one
action button. The chat shows the entry as a card (`apps/editor-web/src/joy-code-failure-card.tsx`),
and the card's button labels are the ones in section 1, so this document and the screen agree.

A raw code is never shown in the chat. A code goes to the console log only, as
`[joy-code] failure code: <CODE>`. A value that is not a plain code (it may carry a path, a key or a
provider payload) is logged as `unrecognised`, never as text. The unit tests
`apps/editor-web/src/joy-code-messages.test.ts` and `apps/editor-web/src/joy-code-failure-card.test.tsx`
read the runtime lists behind the unions, so a new reason or code without an entry fails the test. The
table is typed against the same unions, so it fails the typecheck first.

## 1. Every message in the table

| Key                               | Kind                                         | Title                                            | Sentence the owner reads                                                                                                  | Button label (on the card) |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `cancelled`                       | recipe stop reason                           | Run stopped                                      | You stopped this run. No edits were applied.                                                                              | Try again                  |
| `stale-authority`                 | recipe stop reason                           | The project changed                              | The project changed while Joy Code was working. No edits were applied.                                                    | Try again                  |
| `adapter-unavailable`             | recipe stop reason                           | Part of Joy Code is missing                      | This step needs a part of Joy Code that this build does not have. No edits were applied.                                  | Dismiss                    |
| `adapter-failed`                  | recipe stop reason                           | Joy Code could not finish                        | Joy Code could not finish this step. No edits were applied.                                                               | Try again                  |
| `invalid-artifact`                | recipe stop reason                           | The result was not safe to use                   | Joy Code's result did not pass its safety check. No edits were applied.                                                   | Try again                  |
| `OBSERVATION_MISSING_EVIDENCE`    | host failure code                            | Joy Code could not read the source               | Joy Code could not read enough of the source to finish. No edits were applied.                                            | Try again                  |
| `OBSERVATION_MISSING_COVERAGE`    | host failure code                            | Joy Code could not read the source               | (same as above)                                                                                                           | Try again                  |
| `OBSERVATION_INCOMPLETE_COVERAGE` | host failure code                            | Joy Code could not read the source               | (same as above)                                                                                                           | Try again                  |
| `OBSERVATION_MISSING_MOMENT`      | host failure code                            | Joy Code could not read the source               | (same as above)                                                                                                           | Try again                  |
| `NO_PREPARED_CHANGE`              | host failure code                            | No change was ready                              | Joy Code could not prepare a change for this request. No edits were applied.                                              | Try again                  |
| `PREVIEW_WITHOUT_PREPARED_CHANGE` | host failure code                            | The preview is not ready                         | The preview was asked for before a change was ready. No edits were applied.                                               | Try again                  |
| `PREVIEW_NOT_RENDERED`            | host failure code                            | The preview did not appear                       | The preview could not be shown on screen. No edits were applied.                                                          | Try again                  |
| `JOY_AGENT_ABORTED`               | run error code                               | Run stopped                                      | You stopped this run. No edits were applied.                                                                              | Try again                  |
| `JOY_AGENT_TIMEOUT`               | run error code                               | The model took too long                          | The model did not answer in time. No edits were applied.                                                                  | Try again                  |
| `JOY_AGENT_CORS_OR_NETWORK`       | run error code                               | You are offline                                  | You appear to be offline, or the model cannot be reached. No edits were applied.                                          | Retry                      |
| `JOY_AGENT_AUTH_FAILED`           | run error code                               | Your sign-in has expired                         | Your sign-in has expired, or the model rejected your key. No edits were applied.                                          | Sign in again              |
| `JOY_AGENT_BILLING_REQUIRED`      | run error code (usage limit)                 | The model account needs attention                | Your model account is out of credit or has reached its usage limit. No edits were applied.                                | Open Agent Settings        |
| `JOY_AGENT_RESPONSE_TOO_LARGE`    | run error code                               | The model answer was too large                   | The model's answer was too large to use. No edits were applied.                                                           | Try again                  |
| `JOY_AGENT_INVALID_TOOL`          | run error code (refused tool)                | The model asked for something Joy Code cannot do | The model asked for an action Joy Code cannot run. No edits were applied.                                                 | Try again                  |
| `JOY_AGENT_INVALID_PROPOSAL`      | run error code                               | Joy Code could not check the change              | Joy Code could not check this change safely. No edits were applied.                                                       | Try again                  |
| `JOY_AGENT_STALE_REVISION`        | run error code                               | The project changed                              | The project changed while Joy Code was working. No edits were applied.                                                    | Try again                  |
| `JOY_AGENT_PROVIDER_INCOMPATIBLE` | run error code                               | This model cannot run Joy Code                   | This model cannot run Joy Code's edit tools. No edits were applied.                                                       | Choose another model       |
| `JOY_AGENT_INTERRUPTED`           | run error code                               | The run was interrupted                          | Joy Code was interrupted before it finished. No edits were applied.                                                       | Try again                  |
| `JOY_AGENT_VERIFICATION_FAILED`   | run error code                               | The edit did not pass its checks                 | The finished edit did not pass its checks. No edits were applied.                                                         | Try again                  |
| `no-model`                        | surface                                      | Joy Code needs a model                           | No AI model is connected. Connect one in Agent Settings to edit by describing what you want.                              | Connect a model            |
| `recipe-unavailable`              | surface                                      | Recipe not available                             | This recipe needs a part of Joy Code that this build does not have yet. No edits were applied.                            | Dismiss                    |
| `recipe-temporarily-unavailable`  | surface                                      | Recipes are paused                               | Recipes are paused while Joy Code finishes its safety checks. Describe the change in Edit instead. No edits were applied. | Dismiss                    |
| `look-no-operations`              | Look stop reason                             | No change to apply                               | The request did not produce a change Joy Code can apply. No edits were applied.                                           | Try again                  |
| `look-invalid-proposal`           | Look stop reason                             | Joy Code could not check the change              | Joy Code could not check this change safely. No edits were applied.                                                       | Try again                  |
| `look-compile-failed`             | Look stop reason (any `LOOK_COMPILE_*` code) | The look could not be built                      | Joy Code could not turn this look into a safe change. No edits were applied.                                              | Try again                  |
| `look-staging-failed`             | Look stop reason                             | The preview could not be prepared                | Joy Code could not prepare the preview. No edits were applied.                                                            | Try again                  |
| `look-unknown`                    | Look stop reason (anything else)             | Joy Code could not prepare this                  | Joy Code could not prepare a safe change from this request. No edits were applied.                                        | Try again                  |
| `audio-not-prepared`              | surface (composition audio)                  | The audio could not be read                      | Joy Code could not read the audio in this composition. No edits were applied.                                             | Try again                  |
| `unexpected-failure`              | fallback for anything unknown                | Joy Code stopped                                 | Joy Code could not finish this run safely. No edits were applied.                                                         | Try again                  |

**The card's actions** (`JoyCodeFailureCard`):

- **Try again** and **Retry** re-run the request that failed: the last prompt, the last recipe, or the
  last Look. The panel keeps that request when it starts, and the card calls it with the panel's current
  state. The card stays if the request fails again.
- **Connect a model**, **Sign in again**, **Open Agent Settings** and **Choose another model** open
  Agent Settings (the panel's Settings action).
- **Dismiss** closes the card in this view. The card comes back if the panel is rebuilt, because the
  chat keeps the message.
- A card whose action has no handler in this panel shows its sentence without a button.

## 2. Every chat message that now uses the table

"Old text" is what the owner saw before. `{...}` marks a value filled in at run time. The engine and
host text that used to appear in these lines is no longer shown; it never reaches the chat.

| Where (`apps/editor-web/src/AgentPanel.tsx`)                                      | Old text                                                                                                                                                     | New text (a card: title, sentence, button)                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run failed, engine sent an error code (`failed` event)                            | `{engine text} No edits were applied.`                                                                                                                       | The entry for that run error code. An unknown or missing code gets "Joy Code stopped" (`unexpected-failure`). The engine text is never shown.    |
| Run threw an error (local consistency failure)                                    | `{error message} No edits were applied.` or "JOY run failed safely. No edits were applied."                                                                  | The entry for the error's code, or "Joy Code stopped" when there is no code.                                                                     |
| Natural-language prompt with no model route                                       | Connect a model in Agent Settings to run natural-language JOY edits. No unfenced fallback recipe route is available.                                         | "Joy Code needs a model", with the Connect a model button.                                                                                       |
| Recipe route temporarily off                                                      | This local recipe is temporarily unavailable while JOY finishes its durable approval and receipt boundary. Connect a model to use the guarded JOY edit path. | "Recipes are paused", with Dismiss.                                                                                                              |
| Recipe not available                                                              | "{recipe title}" is unavailable: missing {capability and operation names}.                                                                                   | "Recipe not available", with Dismiss. The recipe name and the missing names are not in the card.                                                 |
| Recipe stopped with a reason                                                      | "{recipe title}" was blocked ({reason}). No edit was applied.                                                                                                | The entry for the host or run code the step carried, if the runner kept one; otherwise the entry for the block reason. The code goes to the log. |
| Recipe prepared a change but its preview was lost                                 | The recipe prepared a change but its preview authority was lost. Try again.                                                                                  | "The project changed", with Try again.                                                                                                           |
| Recipe run threw an error                                                         | {error message or "The recipe run failed safely."} No edits were applied.                                                                                    | The entry for the error's code, or "Joy Code stopped".                                                                                           |
| Look could not be prepared (blocked)                                              | "{look title}" could not be prepared ({reason}). No edit was applied. + diagnostic lines                                                                     | The entry for the Look reason. The diagnostic lines are not shown; their codes (for example `LOOK_COMPILE_BAKE_KEYS`) go to the log.             |
| Look prepared a change but its preview was lost (manual Look, and the agent Look) | The Look prepared a change but its preview authority was lost. Try again.                                                                                    | "The project changed", with Try again.                                                                                                           |
| Look run threw an error (manual Look, and the agent Look)                         | {error message or "The Look run failed safely."} No edits were applied.                                                                                      | The entry for the error's code, or "Joy Code stopped".                                                                                           |
| Agent Look request failed (engine or host)                                        | The Look request could not be prepared ({message}). No edit was applied.                                                                                     | The entry for the run error code the engine sent, or "Joy Code stopped".                                                                         |
| Composition audio could not be read (Look bake)                                   | The composition audio could not be prepared ({loader message}). No bake was applied.                                                                         | "The audio could not be read", with Try again. The loader's text is not shown; the log gets `AUDIO_PREPARE_FAILED`.                              |
| Look bake found nothing to bake                                                   | Nothing to bake: {diagnostic text}                                                                                                                           | "No change to apply", with Try again. The diagnostic codes go to the log; the text does not.                                                     |
| Apply failed (approval path, thrown error)                                        | JOY apply failed: {error message} (or "JOY apply failed safely.")                                                                                            | The entry for the error's code, or "Joy Code stopped".                                                                                           |
| Edit not applied (thrown error in the plan path)                                  | The edit was not applied: {error message}                                                                                                                    | The entry for the error's code, or "Joy Code stopped".                                                                                           |

**Also changed:** while a run is in the `failed` phase, the grey live-status strip ("JOY failed · Live
engine activity") is hidden, so the failure card is the one message. Other phases keep the strip.

**Logging:** every failure that shows a card logs one line, `[joy-code] failure code: <CODE>`, through
`reportJoyCodeFailure`. Look diagnostics and the bake diagnostic log their code-shaped tokens the same
way. Nothing else is logged: no message text, no key, no path, no provider payload.

## 3. Still open in T-J01

- **Screenshots.** The card asks for a screenshot of each card. None were taken in this round: the
  screenshots need the running app under the launch rule, and this helper did not launch it.
- **Messages left as they were** (not failure cards): the plan approval reason in
  "The plan is ready, but execution policy blocked it: {reason}" (plan path, not the recipe or Look
  path); the readiness notices (for example "The model capability is untested"); the "JOY run
  cancelled. No edits were applied." line after a Stop; the guard lines before a run starts
  (credential, privacy, a plan or preview still waiting); the Look answer text the model returns.
- **The sign-in sentence.** The card's example said "Your ChatGPT sign-in has expired." The table says
  "Your sign-in has expired, or the model rejected your key." because the same failure can come from
  several providers, and the text should not name one of them.
- **Dismiss is per view.** It does not remove the message from the saved conversation.
