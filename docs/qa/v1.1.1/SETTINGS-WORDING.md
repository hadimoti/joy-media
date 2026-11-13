# SETTINGS-WORDING.md — the Joy Code Settings wording, in plain English (T-P07)

**How to read this**

1. This file lists **every word the Joy Code Settings dialog shows**: the pages, the modes, the labels, the buttons, the notices and the refusals.
2. Every row has the **old text**, the **new text** and **where** the text is on screen, so it can be found without reading the code.
3. The new text is plain English: sentence case, no jargon, one idea per line.
4. The last column is empty on purpose. **This table is for one reading.** If any new text is wrong for you, write your answer in that column and hand the table back; the change is then made as written.
5. Rows where the old and the new text are the same were left alone on purpose. They are listed so the table is complete and you do not have to guess whether a word was considered.
6. The new text is already in the code on branch `v111/settings-wording`, in one file: `apps/editor-web/src/settings-wording.ts`. A test holds a snapshot of every string in that file and of every word the five pages show, so a later change shows up in the diff instead of slipping in.

Written 12 Nov 2026 by MC (the UI and document helper) on branch `v111/settings-wording`, worktree `v111-ui`.
Read from the code, not from memory: `apps/editor-web/src/JoyAgentSettingsDialog.tsx`, `apps/editor-web/src/settings-wording.ts`, `apps/editor-web/src/agent-policy-settings.ts`, `packages/agent-tools/src/approval.ts` (the code that decides when JOY Media asks you).

---

## 1. The dialog frame

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Joy Code Settings | Joy Code Settings | The title at the top of the dialog | |
| Professional AI Engine Workspace | **Settings for Joy Code** | The small line under the title | |
| Categories | Categories | The label above the list of pages | |
| Settings categories | Settings categories | The name of the list of pages, read by a screen reader | |
| Close settings | Close settings | The small cross at the top right | |
| Done | Done | The gold button at the bottom right | |

---

## 2. The five pages

### The names in the list on the left

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| AI Models & APIs | **AI models** | Left list, first entry | |
| Execution & Safety | **Safety and limits** | Left list, second entry | |
| Live Experience | **Live preview** | Left list, third entry | |
| Tools & Perms | **Tools and permissions** | Left list, fourth entry | |
| Media Diagnostics | **Media support check** | Left list, fifth entry | |

### The small line above the heading of each page

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Provider & Model Configuration | **Models and connections** | AI models page | |
| Autonomy & Cost Limits | **How much Joy Code does on its own** | Safety and limits page | |
| Real-time Interaction | **What you see while it works** | Live preview page | |
| Granular Engine Access | **What Joy Code may change** | Tools and permissions page | |
| Engine & Probe Telemetry | **How your computer handles it** | Media support check page | |

### The heading of each page

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| AI Models & Custom Links | **AI models** | AI models page | |
| Execution Policy & Run Budgets | **Safety and limits** | Safety and limits page | |
| Live Previews & Experience | **Live preview** | Live preview page | |
| Tool Capabilities & Access Gates | **Tools and permissions** | Tools and permissions page | |
| System Health & Modality Probes | **Media support check** | Media support check page | |

### The line under the heading of each page

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Configure endpoints, discover available models behind any link, and switch active reasoning brains. | **Choose the model Joy Code uses, and the service and key it connects with.** | AI models page | |
| Control how autonomously Joy Code applies timeline edits, cuts, and visual effects. | **Choose how much Joy Code does on its own, and when it should ask you before it spends.** | Safety and limits page | |
| Tune real-time visual ghost overlays and editor presence during agent runs. | **Choose whether you see a live preview on the canvas while Joy Code works.** | Live preview page | |
| Toggle permissions for timeline modification, audio processing, and generative vision tools. | **Choose what Joy Code is allowed to read and change.** | Tools and permissions page | |
| Run synthetic modality probes and inspect local GPU hardware acceleration telemetry. | **Check that your computer draws the picture, and that the model understands pictures, sound and video.** | Media support check page | |

---

## 3. The four ways Joy Code can work

Each one has one plain sentence, and the default says so.

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Suggest only | **Suggest only** | Safety and limits page, the first mode card | |
| Joy Code suggests creative plans and edits in chat without touching the timeline. | **Joy Code writes out what it would change and waits for you, and it never touches your project by itself.** | Safety and limits page, under "Suggest only" | |
| Preview and approve | **Preview and approve (default)** | Safety and limits page, the second mode card | |
| Edits are previewed visually in the editor and require explicit approval before applying. | **Joy Code shows the change in the editor first, and only makes it when you say yes.** | Safety and limits page, under "Preview and approve" | |
| Auto-apply low risk | **Apply safe changes** | Safety and limits page, the third mode card | |
| Automatically executes non-destructive edits (cuts, trims, labeling) while gating large changes. | **Joy Code applies small, reversible changes such as cuts and trims on its own, and asks before anything bigger.** | Safety and limits page, under "Apply safe changes" | |
| Full auto within limits | **Work on its own** | Safety and limits page, the fourth mode card | |
| Autonomous multi-step execution within your configured cost and token budget limits. | **Joy Code works through a whole task on its own, and asks you first when one step may cost more than your limit.** | Safety and limits page, under "Work on its own" | |

**(default)** is on **Preview and approve** and on no other mode. That is the mode a fresh install starts in.

---

## 4. The cost number — what it really does

**The code does not stop a run.** The number is the point at which JOY Media asks you, and only in the mode "Work on its own": the approval engine looks at the estimate of one step, and a step that may cost more than the number is sent to you for approval. It is not a limit on what a whole run may spend. The words below say exactly that.

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Run Budget & Spend Safety | **When to ask you about cost** | Safety and limits page, the second block | |
| Max $10.00/run | **Ask above $0.50 for one step** | Safety and limits page, the small tag on that block | |
| Max Cost per Run (USD) | **Ask me before a step that may cost more than this (USD)** | Safety and limits page, the field | |
| Limits API provider token consumption per autonomous execution session. | **In "Work on its own", JOY Media asks for your approval when one step of a run may cost more than this. It is not a limit on what a whole run may spend. Prices are estimates from the provider. JOY Media itself charges nothing.** | Safety and limits page, under the field | |

**The default number changes from $10.00 to $0.50.**

- A **fresh install** starts at $0.50.
- **A number you already saved stays as it is.** Nothing is raised or lowered behind your back; only the default for a new install changes.
- The line "Prices are estimates from the provider. JOY Media itself charges nothing." is there because the number is an estimate set by the provider, not a bill from JOY Media.

---

## 5. Where the settings and the keys are kept

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Policy saved locally in browser. Sensitive keys secured in Windows DPAPI vault. | **Saved on this computer. Your keys are stored encrypted on this PC.** | The line at the bottom of the dialog | |
| Keys are encrypted via Windows DPAPI and never logged or proxied. | **Your keys are stored encrypted on this PC.** | Under the API key field | |
| (Saved in desktop vault) | **(Saved on this computer)** | Under the API key field, when a key is already saved | |

Why: the app is a desktop app, not a website, so "saved locally in browser" was wrong. "Windows DPAPI vault" is a name only the makers of Windows know. The owner asked for exactly these two sentences.

---

## 6. The media support check

The check answers one question: does the model you chose understand pictures, sound and video?

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Synthetic Media Capability Probe | **Media support check** | AI models page, the third block | |
| Runs three tiny product-owned synthetic samples to verify multimodal image, audio, and video understanding. This check never sends your project, owner, or uploaded media to the provider, but your provider may charge or log these requests under its standard usage terms. | **Sends three tiny test clips to the model to see whether it understands pictures, sound and video. Your project and your media are never sent. Your provider may still charge for these three small requests.** | AI models page, under the block title | |
| Probe Verified | **Checked** | AI models page, the small tag | |
| Unprobed | **Not checked yet** | AI models page, the small tag | |
| Check media support | Check media support | The button on both pages | |
| Checking media support… | Checking media support… | The button while it runs | |
| Checking… | Checking… | The button on the Media support check page while it runs | |
| Active Model Synthetic Modality Probe | **Does the model understand media?** | Media support check page, the second block | |
| Tests whether the active reasoning model parses image, audio, and video inputs. | **Checks whether the model you chose understands pictures, sound and video.** | Media support check page | |
| No probe run yet for the active model. | **Not checked yet for this model.** | Media support check page | |
| Configured model: | Configured model: | The line above the three results | |
| Image | Image | The first result | |
| Audio | Audio | The second result | |
| Video | Video | The third result | |
| Supported | Supported | A result the model can do | |
| Unavailable | Unavailable | A result the model cannot do | |
| Media capability check returned an invalid result. Reconnect the model and try again. | Media capability check returned an invalid result. Reconnect the model and try again. | The message when the check answered something impossible | |
| Media capability check could not be completed. Reconnect the model and try again. | Media capability check could not be completed. Reconnect the model and try again. | The message when the check could not run | |
| Media capability check complete for {model}. | Media capability check complete for {model}. | The message when the check is done | |

---

## 7. What Joy Code may change

The list showed the internal names of the permissions. Each one now has a sentence a person can read. The names behind the list did not change: the same twelve permissions, the same keys, the same behaviour.

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| timeline.read | **Read the timeline** | Tools and permissions page, the first switch | |
| timeline.write | **Change the timeline** | Tools and permissions page, the second switch | |
| assets.read | **Read your media** | Tools and permissions page, the third switch | |
| assets.import | **Bring in new media** | Tools and permissions page, the fourth switch | |
| filesystem.read | **Read files** | Tools and permissions page, the fifth switch | |
| filesystem.write | **Write files** | Tools and permissions page, the sixth switch | |
| provider.generate | **Ask the model to create media** | Tools and permissions page, the seventh switch | |
| provider.spend | **Spend money at the provider** | Tools and permissions page, the eighth switch | |
| render.preview | **Draw previews** | Tools and permissions page, the ninth switch | |
| export.write | **Write the exported file** | Tools and permissions page, the tenth switch | |
| project.overwrite | **Overwrite the project** | Tools and permissions page, the eleventh switch | |
| plugin.invoke | **Run plugins** | Tools and permissions page, the twelfth switch | |
| Tool Capabilities Grid | **What Joy Code may change** | Tools and permissions page, the block title | |
| 12/12 Allowed | **12 of 12 allowed** | Tools and permissions page, the small tag | |

---

## 8. The live preview page

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Real-time Previews & Ghost Overlays | **What you see while Joy Code works** | Live preview page, the block title | |
| Show real-time previews on the monitor canvas during agent operations | **Show what Joy Code is doing on the canvas while it works** | Live preview page, the one switch | |

---

## 9. The models page

### The banner and the saved connections

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Browse models & API connections | **Browse models and connections** | The button at the top of the AI models page | |
| Custom BYOK | **Your own API key** | AI models page, the first block | |
| One API-key provider (OpenRouter or a custom endpoint) | **One provider, with a key you enter here** | AI models page, under "Your own API key" | |
| No Active Model Connected | **No model connected** | AI models page, the banner | |
| Tool loop ready · High capabilities | **Ready to edit your project** | AI models page, under the banner | |
| Plan-only ready · Creative brief available | **Ready for a creative brief only** | AI models page, under the banner | |
| Configure an API endpoint below to connect JOY Code. | **Connect a model below to start.** | AI models page, under the banner | |
| Connection failed. See the details below. | Connection failed. See the details below. | AI models page, under the banner | |
| Disconnect | Disconnect | The button on the banner | |
| Saved Vault Profiles (3) | **Saved connections (3)** | AI models page, the block of saved connections | |
| Disabled legacy profile | **Old connection, no longer used** | On an old saved connection | |
| Saved key could not be read. Enter it again. | Saved key could not be read. Enter it again. | On a saved connection whose key cannot be read | |
| Enter the key again to confirm this endpoint. | Enter the key again to confirm this endpoint. | On a saved connection whose key needs confirming | |
| Use | Use | The button on a saved connection | |
| Later | Later | The button on an old saved connection | |
| Working… | Working… | The button while it works | |
| Reauthorize | **Sign in again** | The button on a saved ChatGPT connection | |
| Sign out & revoke | **Sign out and remove access** | The button on a saved ChatGPT connection | |
| Remove ChatGPT profile locally | Remove ChatGPT profile locally | The small cross on a saved ChatGPT connection | |
| Remove {name} profile | Remove {name} profile | The small cross on any other saved connection | |

### The connection and the key

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| API Connection & Authentication | **Connection and sign-in** | AI models page, the first block title | |
| No provider | No provider | The small tag on that block | |
| OpenRouter | OpenRouter | The small tag on that block | |
| Custom Endpoint | **Your own endpoint** | The small tag on that block | |
| Provider Platform | **Provider** | The first drop-down | |
| Choose a provider | Choose a provider | The first drop-down, the empty entry | |
| OpenRouter (BYOK) | **OpenRouter (your own key)** | The first drop-down | |
| Custom S3 / OpenAI Compatible | **Another provider (OpenAI compatible)** | The first drop-down | |
| Region | Region | The drop-down under the provider | |
| Get a key at | Get a key at | The small line under the provider | |
| Connection Profile Name (Optional) | **Name this connection (optional)** | The name field | |
| e.g. My OpenRouter, Local Ollama | e.g. My OpenRouter, Local Ollama | The greyed text in the name field | |
| Base URL / Endpoint | **Service address (base URL)** | The address field | |
| https://... | https://... | The greyed text in the address field | |
| API Secret Key | **Your API key** | The key field | |
| •••••••••••••••• (Leave blank to keep saved) | •••••••••••••••• (Leave blank to keep saved) | The greyed text in the key field, when a key is saved | |
| sk-... | sk-... | The greyed text in the key field | |
| I understand that custom endpoints may log requests according to their own policy. | I understand that custom endpoints may log requests according to their own policy. | The tick box under the key field | |
| Model ID (User Editable) | **Model ID (you can change this)** | The model field | |
| Model ID | Model ID | The name of the model field, read by a screen reader | |
| provider/model | provider/model | The greyed text in the model field | |
| Open Model Drawer | **Show model list** | The button next to the model field | |
| Hide Model Drawer | **Hide model list** | The button next to the model field | |
| Discover models behind API endpoint | **Find the models this service offers** | The tooltip on "Find models" | |
| Scanning… | **Finding models…** | The "Find models" button while it runs | |
| Discover Models | **Find models** | The "Find models" button | |
| Connecting… | Connecting… | The "Connect model" button while it works | |
| Connect model | Connect model | The "Connect model" button | |
| Clear connection | Clear connection | The button next to "Connect model" | |

### The model list

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Discovered Models Drawer | **Models found on this service** | AI models page, the second block title | |
| 3 Models Ready | **3 models ready** | The small tag on that block | |
| Click to Resolve | **Open to find models** | The small tag on that block | |
| Select a discovered model chip to populate the Model ID, or filter by keyword: | **Choose a model to fill in the model ID, or type a word to filter the list.** | Under the block title | |
| Refreshing… | **Checking again…** | The "Look again" button while it runs | |
| Refresh Models | **Look again** | The "Look again" button | |
| Look again for models | Look again for models | The name of the "Look again" button, read by a screen reader | |
| Ask this service for its models again | Ask this service for its models again | The tooltip on the "Look again" button | |
| Filter models (e.g. free, sonnet, 4o)... | Filter models (e.g. free, sonnet, 4o)... | The search field of the model list | |
| All | All | The first filter button | |
| Free | Free | The second filter button | |
| Claude | Claude | The third filter button | |
| GPT | GPT | The fourth filter button | |
| Scanning endpoint for available models... | **Looking for models…** | Inside the model list while it looks | |
| No models discovered yet. Enter Base URL and API Key above, then click "Discover Models". | **No models yet. Enter the service address and your key above, then choose Find models.** | Inside the model list | |
| No models matching current filter. | **No model matches that filter.** | Inside the model list | |

---

## 10. The notices and the refusals

These are the sentences the dialog says when it answers, refuses or reports. They were already plain, so most of them did not change; they are listed so the table is complete.

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| The saved profiles did not load in time. | The saved profiles did not load in time. | The notice above the models page | |
| The saved profiles could not be read. Close and reopen settings to try again. | The saved profiles could not be read. Close and reopen settings to try again. | The notice above the models page | |
| The saved profiles are still loading. | The saved profiles are still loading. | The notice above the models page | |
| This agent slot cannot run yet. Save it with a profile and a model. | This agent slot cannot run yet. Save it with a profile and a model. | When an agent slot is run without a model | |
| Live model discovery requires Joy Media Desktop. | Live model discovery requires Joy Media Desktop. | When the model list is asked for in the browser build | |
| Choose a provider before discovering models. | Choose a provider before discovering models. | The notice in the model list | |
| Choose a provider before connecting. | Choose a provider before connecting. | The notice above the buttons | |
| More than one saved profile uses this endpoint. Choose one in the list first. | More than one saved profile uses this endpoint. Choose one in the list first. | The notice in the model list | |
| Enter the custom-provider acknowledgement before discovering models. | Enter the custom-provider acknowledgement before discovering models. | The notice in the model list | |
| Enter the custom-provider acknowledgement before connecting. | Enter the custom-provider acknowledgement before connecting. | The notice above the buttons | |
| Acknowledge this custom endpoint before connecting. | Acknowledge this custom endpoint before connecting. | The notice above the buttons | |
| The key was entered for a different provider or endpoint. Enter it again. | The key was entered for a different provider or endpoint. Enter it again. | The notice in the model list | |
| Enter the API key again to confirm this endpoint. | Enter the API key again to confirm this endpoint. | The notice in the model list | |
| Enter the API key again to confirm this endpoint, then connect. | Enter the API key again to confirm this endpoint, then connect. | The notice above the buttons | |
| Please enter a Base URL before discovering models | Please enter a Base URL before discovering models | The notice in the model list | |
| Failed to discover models behind endpoint | Failed to discover models behind endpoint | The notice in the model list | |
| The connection failed. | The connection failed. | The notice above the buttons | |
| Unable to configure connection | Unable to configure connection | The notice above the buttons | |
| The provider responded, but JOY could not use its tool loop. | The provider responded, but JOY could not use its tool loop. | The notice above the buttons | |
| Connected successfully. JOY is ready to edit in this session. | Connected successfully. JOY is ready to edit in this session. | The notice above the buttons | |
| Connected successfully in plan-only mode. Creative Brief is ready in this session. | Connected successfully in plan-only mode. Creative Brief is ready in this session. | The notice above the buttons | |
| Connection failed: {reason} | Connection failed: {reason} | The notice above the buttons | |
| The saved API key belongs to a different provider or endpoint. Enter a new API key to connect. | The saved API key belongs to a different provider or endpoint. Enter a new API key to connect. | The notice above the buttons | |
| API key is required. | API key is required. | The notice above the buttons | |
| Model ID is required. | Model ID is required. | The notice above the buttons | |
| Base URL is required. | Base URL is required. | The notice above the buttons | |
| Enter {items} before connecting. | Enter {items} before connecting. | The notice above the buttons | |
| the API key again to confirm this endpoint | the API key again to confirm this endpoint | Inside "Enter … before connecting." | |
| a new API key because the saved key belongs to a different provider or endpoint | a new API key because the saved key belongs to a different provider or endpoint | Inside "Enter … before connecting." | |
| an API key | an API key | Inside "Enter … before connecting." | |
| a model ID | a model ID | Inside "Enter … before connecting." | |
| a base URL | a base URL | Inside "Enter … before connecting." | |
| the custom-provider acknowledgement | the custom-provider acknowledgement | Inside "Enter … before connecting." | |
| The saved profile could not be read back. Try connecting again. | The saved profile could not be read back. Try connecting again. | The notice above the buttons | |
| This connection could not be saved in the desktop app. | This connection could not be saved in the desktop app. | The notice above the buttons | |
| Remove this ChatGPT connection from JOY Media without revoking its authorization? This does not revoke access in ChatGPT. | Remove this ChatGPT connection from JOY Media without revoking its authorization? This does not revoke access in ChatGPT. | The confirmation before removing a ChatGPT connection | |
| Remove | Remove | The button of that confirmation | |
| Could not remove the saved profile. | Could not remove the saved profile. | The notice above the buttons | |
| ChatGPT connection reauthorized. | ChatGPT connection reauthorized. | The notice above the buttons | |
| ChatGPT reauthorization did not complete. | ChatGPT reauthorization did not complete. | The notice above the buttons | |
| Sign out of this ChatGPT connection and revoke its saved authorization? JOY Media will remove the saved profile after ChatGPT confirms revocation. | Sign out of this ChatGPT connection and revoke its saved authorization? JOY Media will remove the saved profile after ChatGPT confirms revocation. | The confirmation before signing out | |
| Sign out | Sign out | The button of that confirmation | |
| ChatGPT authorization revoked and the saved connection was removed. | ChatGPT authorization revoked and the saved connection was removed. | The notice above the buttons | |
| ChatGPT could not confirm sign-out. | ChatGPT could not confirm sign-out. | The notice above the buttons | |
| Remove locally | Remove locally | The button of the second confirmation | |
| Remove this connection from JOY Media locally without revoking it? This does not revoke access in ChatGPT. | Remove this connection from JOY Media locally without revoking it? This does not revoke access in ChatGPT. | The second confirmation | |
| ChatGPT connection removed locally. This did not revoke access in ChatGPT. | ChatGPT connection removed locally. This did not revoke access in ChatGPT. | The notice above the buttons | |
| Could not remove the saved profile locally. | Could not remove the saved profile locally. | The notice above the buttons | |
| Connection cleared. Your API key was removed from this page session. | Connection cleared. Your API key was removed from this page session. | The notice above the buttons | |

---

## 11. The page that says how the computer is doing

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Local Hardware & Worker Acceleration | **How your computer draws the picture** | Media support check page, the first block title | |
| Direct3D 11 Active | **Hardware acceleration is on** | The small tag on that block | |
| GPU Device | **Graphics card** | Media support check page | |
| Rendering Backend | **How it draws** | Media support check page | |
| Local Asset Library | **Your media folder** | Media support check page | |
| See Asset Library settings | **See the Asset Library settings** | Media support check page | |
| Local Worker SEA | **Background worker** | Media support check page | |

---

## 12. Words to avoid in this dialog

For anyone writing more text here later, these are the words the owner did not want, and what to write instead.

| Do not write | Write instead |
|---|---|
| Workspace, engine, brain, reasoning model | Joy Code, or the name of the model |
| BYOK, bring your own key | your own API key |
| Endpoint, base URL | service address (base URL) |
| Probe, modality, telemetry | check, pictures / sound / video |
| Autonomy, execution policy | how much Joy Code does on its own |
| Run budget, cost limit | when to ask you about cost |
| Vault, DPAPI | saved on this computer |
| Capabilities, permissions, access gates | what Joy Code may change |
| Ghost overlays | live preview |

---

## 13. What was not changed, and what was not checked

- **Only the words changed.** No permission, no key, no model, no file and no stored value was touched by this card. The one number that changed is the default for a fresh install ($10.00 → $0.50); a saved number stays.
- **No new cap was added.** The cost number is still only the point at which JOY Media asks you, exactly as the code has always done it.
- **The app was not launched**, so there is no screenshot of the five pages with the new words. Every line in this table was read out of the source and out of the rendered dialog in a test, not off a screen. The live look of the five pages belongs to T-L03 and T-J06.
- **The wording of the two child components** (`AgentSlotsSection.tsx`, `ProviderSignInPanel.tsx`) was not rewritten. They are read as part of the models page, and the card says "every string in `JoyAgentSettingsDialog.tsx`". Their words are in the rendered snapshot of the models page.
- **The `JoyAgentSettingsTab` type moved** to the wording file. It is still exported from the dialog with the same name, so nothing outside had to change.
