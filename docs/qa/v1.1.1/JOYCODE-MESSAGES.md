# Joy Code messages (T-J01, v1.1.1)

Owner items OB-13a and OB-13c. Plain messages for every Joy Code failure.

**Where the table lives:** `apps/editor-web/src/joy-code-messages.ts` (`JOY_CODE_MESSAGES`).
Every reason and failure code has one entry: a title, one plain sentence and one action button.
A raw code is never shown in the chat. The unit test `apps/editor-web/src/joy-code-messages.test.ts`
reads the runtime lists behind the unions, so a new reason or code without an entry fails the test,
and the table itself is typed against the same unions, so it fails the typecheck first.

## 1. Every message in the table

| Key | Kind | Title | Sentence the owner reads | Button |
|---|---|---|---|---|
| `cancelled` | recipe stop reason | Run stopped | You stopped this run. No edits were applied. | Try again |
| `stale-authority` | recipe stop reason | The project changed | The project changed while Joy Code was working. No edits were applied. | Try again |
| `adapter-unavailable` | recipe stop reason | Part of Joy Code is missing | This step needs a part of Joy Code that this build does not have. No edits were applied. | Dismiss |
| `adapter-failed` | recipe stop reason | Joy Code could not finish | Joy Code could not finish this step. No edits were applied. | Try again |
| `invalid-artifact` | recipe stop reason | The result was not safe to use | Joy Code's result did not pass its safety check. No edits were applied. | Try again |
| `OBSERVATION_MISSING_EVIDENCE` | host failure code | Joy Code could not read the source | Joy Code could not read enough of the source to finish. No edits were applied. | Try again |
| `OBSERVATION_MISSING_COVERAGE` | host failure code | Joy Code could not read the source | (same as above) | Try again |
| `OBSERVATION_INCOMPLETE_COVERAGE` | host failure code | Joy Code could not read the source | (same as above) | Try again |
| `OBSERVATION_MISSING_MOMENT` | host failure code | Joy Code could not read the source | (same as above) | Try again |
| `NO_PREPARED_CHANGE` | host failure code | No change was ready | Joy Code could not prepare a change for this request. No edits were applied. | Try again |
| `PREVIEW_WITHOUT_PREPARED_CHANGE` | host failure code | The preview is not ready | The preview was asked for before a change was ready. No edits were applied. | Try again |
| `PREVIEW_NOT_RENDERED` | host failure code | The preview did not appear | The preview could not be shown on screen. No edits were applied. | Try again |
| `JOY_AGENT_ABORTED` | run error code | Run stopped | You stopped this run. No edits were applied. | Try again |
| `JOY_AGENT_TIMEOUT` | run error code | The model took too long | The model did not answer in time. No edits were applied. | Try again |
| `JOY_AGENT_CORS_OR_NETWORK` | run error code | You are offline | You appear to be offline, or the model cannot be reached. No edits were applied. | Retry |
| `JOY_AGENT_AUTH_FAILED` | run error code | Your sign-in has expired | Your sign-in has expired, or the model rejected your key. No edits were applied. | Sign in again |
| `JOY_AGENT_BILLING_REQUIRED` | run error code (usage limit) | The model account needs attention | Your model account is out of credit or has reached its usage limit. No edits were applied. | Open Agent Settings |
| `JOY_AGENT_RESPONSE_TOO_LARGE` | run error code | The model answer was too large | The model's answer was too large to use. No edits were applied. | Try again |
| `JOY_AGENT_INVALID_TOOL` | run error code (refused tool) | The model asked for something Joy Code cannot do | The model asked for an action Joy Code cannot run. No edits were applied. | Try again |
| `JOY_AGENT_INVALID_PROPOSAL` | run error code | Joy Code could not check the change | Joy Code could not check this change safely. No edits were applied. | Try again |
| `JOY_AGENT_STALE_REVISION` | run error code | The project changed | The project changed while Joy Code was working. No edits were applied. | Try again |
| `JOY_AGENT_PROVIDER_INCOMPATIBLE` | run error code | This model cannot run Joy Code | This model cannot run Joy Code's edit tools. No edits were applied. | Choose another model |
| `JOY_AGENT_INTERRUPTED` | run error code | The run was interrupted | Joy Code was interrupted before it finished. No edits were applied. | Try again |
| `JOY_AGENT_VERIFICATION_FAILED` | run error code | The edit did not pass its checks | The finished edit did not pass its checks. No edits were applied. | Try again |
| `no-model` | surface | Joy Code needs a model | No AI model is connected. Connect one in Agent Settings to edit by describing what you want. | Connect a model |
| `recipe-unavailable` | surface | Recipe not available | This recipe needs a part of Joy Code that this build does not have yet. No edits were applied. | Dismiss |
| `recipe-temporarily-unavailable` | surface | Recipes are paused | Recipes are paused while Joy Code finishes its safety checks. Describe the change in Edit instead. No edits were applied. | Dismiss |
| `look-no-operations` | Look stop reason | No change to apply | The request did not produce a change Joy Code can apply. No edits were applied. | Try again |
| `look-invalid-proposal` | Look stop reason | Joy Code could not check the change | Joy Code could not check this change safely. No edits were applied. | Try again |
| `look-compile-failed` | Look stop reason (any `LOOK_COMPILE_*` code) | The look could not be built | Joy Code could not turn this look into a safe change. No edits were applied. | Try again |
| `look-staging-failed` | Look stop reason | The preview could not be prepared | Joy Code could not prepare the preview. No edits were applied. | Try again |
| `look-unknown` | Look stop reason (anything else) | Joy Code could not prepare this | Joy Code could not prepare a safe change from this request. No edits were applied. | Try again |
| `unexpected-failure` | fallback for anything unknown | Joy Code stopped | Joy Code could not finish this run safely. No edits were applied. | Try again |

Intended button actions: "Try again" and "Retry" re-run the same request; "Connect a model",
"Sign in again" and "Open Agent Settings" open Agent Settings; "Dismiss" closes the card. The card
that shows these buttons is **not built yet** (see section 3), so today the labels are not on screen.

## 2. Every chat message that now uses the table

"Old text" is what the owner saw before. `{...}` marks a value filled in at run time.

| Where (`apps/editor-web/src/AgentPanel.tsx`) | Old text | New text |
|---|---|---|
| Run failed, engine sent an error code (`failed` event) | `{engine text} No edits were applied.` (engine text, e.g. "Provider request failed.") | The table sentence for that code, e.g. "You appear to be offline, or the model cannot be reached. No edits were applied." If no code is sent, the old text is kept. |
| Run threw an error (local consistency failure) | `{error message} No edits were applied.` or "JOY run failed safely. No edits were applied." | The table sentence for the error's code, or "Joy Code could not finish this run safely. No edits were applied." when there is no code. The error text is no longer shown. |
| Natural-language prompt with no model route | Connect a model in Agent Settings to run natural-language JOY edits. No unfenced fallback recipe route is available. | No AI model is connected. Connect one in Agent Settings to edit by describing what you want. |
| Recipe route temporarily off | This local recipe is temporarily unavailable while JOY finishes its durable approval and receipt boundary. Connect a model to use the guarded JOY edit path. | Recipes are paused while Joy Code finishes its safety checks. Describe the change in Edit instead. No edits were applied. |
| Recipe not available | "{recipe title}" is unavailable: missing {capability and operation names}. | "{recipe title}" is not available. This recipe needs a part of Joy Code that this build does not have yet. No edits were applied. |
| Recipe stopped with a reason | "{recipe title}" was blocked ({reason}). No edit was applied. | "{recipe title}" did not finish. {table sentence for the reason} |
| Recipe prepared a change but its preview was lost | The recipe prepared a change but its preview authority was lost. Try again. | The project changed while Joy Code was working. No edits were applied. |
| Recipe run threw an error | {error message or "The recipe run failed safely."} No edits were applied. | The table sentence for the error's code, or the generic unexpected-failure sentence. |
| Look could not be prepared (blocked) | "{look title}" could not be prepared ({reason}). No edit was applied. + diagnostic lines | "{look title}" could not be prepared. {table sentence for the Look reason}. The diagnostic lines are no longer shown in the chat. |
| Look prepared a change but its preview was lost (manual Look, and the agent Look) | The Look prepared a change but its preview authority was lost. Try again. | The project changed while Joy Code was working. No edits were applied. |
| Look run threw an error (manual Look, and the agent Look) | {error message or "The Look run failed safely."} No edits were applied. | The table sentence for the error's code, or the generic unexpected-failure sentence. |

## 3. Not done in T-J01

- **The one calm card.** The table is in place and every failure above uses it, but the card that
  replaces the chat line plus the grey notice is not built. The chat still shows a line. The
  buttons are not wired.
- **Screenshots.** The card asks for a screenshot of each card. None were taken: the card is not
  built, and the app was not launched for this task.
- **Logging of codes.** The card says a raw code goes to the log only. The codes are not logged
  yet; the code is simply not shown.
- **Failure codes are not surfaced.** The host adapter's failure codes (`OBSERVATION_*`,
  `NO_PREPARED_CHANGE`, `PREVIEW_*`) are caught by the recipe runner and reported as
  `adapter-failed`, so the owner sees the `adapter-failed` sentence. The table covers the codes
  for when they are surfaced.
- **Messages left as they were** (failure-like, but outside this card): "The Look request could not
  be prepared ({message})" and "The composition audio could not be prepared ({message})", "JOY apply
  failed safely", "JOY preview rejected", the readiness notices (for example "The model capability
  is untested"), and the plan's approval reason. Each still shows some engine or host text.
- **The sign-in sentence.** The card's example said "Your ChatGPT sign-in has expired." The table says
  "Your sign-in has expired, or the model rejected your key." because the same failure can come from
  several providers, and the text should not name one of them.
