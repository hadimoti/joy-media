# SETTINGS-WORDING.md — the Joy Code Settings wording, in plain English (T-P07)

**How to read this**

1. This file lists **every word the Joy Code Settings dialog shows**, with the old text on the left and the new text on the right.
2. The new text is plain English: sentence case, no jargon, one idea per line.
3. **Where** says which page and which control the text belongs to, so it can be found on screen without reading the code.
4. The last column is empty on purpose. **This table is for one reading.** If any new text is wrong for you, write your answer in that column and hand the table back; the change is then made as written.
5. The new text is already in the code on branch `v111/settings-wording`. The table says what changed and why, so nobody has to guess what a word meant.

Written 12 Nov 2026 by MC (the UI and document helper) on branch `v111/settings-wording`, worktree `v111-ui`.
Read from the code, not from memory: `apps/editor-web/src/JoyAgentSettingsDialog.tsx`, `apps/editor-web/src/settings-wording.ts` (the wording now lives in one file, so it can be read in one place), `apps/editor-web/src/agent-policy-settings.ts`, `packages/agent-tools/src/approval.ts`.

---

## 1. The five pages (the list on the left)

The owner asked for these five names. They are the plain names of what each page is for.

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| AI Models & APIs | **AI models** | Left list, first entry | |
| Execution & Safety | **Safety and limits** | Left list, second entry | |
| Live Experience | **Live preview** | Left list, third entry | |
| Tools & Perms | **Tools and permissions** | Left list, fourth entry | |
| Media Diagnostics | **Media support check** | Left list, fifth entry | |

Each page also has a heading on the right. The heading now says the same name as the list, so the page has one name and not two.

| Old text (the small line above the heading) | New text | Where it is | Owner's answer |
|---|---|---|---|
| Provider & Model Configuration | Models and connections | AI models page | |
| Autonomy & Cost Limits | How much Joy Code does on its own | Safety and limits page | |
| Real-time Interaction | What you see while it works | Live preview page | |
| Granular Engine Access | What Joy Code may change | Tools and permissions page | |
| Engine & Probe Telemetry | How your computer handles it | Media support check page | |

| Old text (the line under the heading) | New text | Where it is | Owner's answer |
|---|---|---|---|
| Configure endpoints, discover available models behind any link, and switch active reasoning brains. | Choose the model Joy Code uses, and the service and key it connects with. | AI models page | |
| Control how autonomously Joy Code applies timeline edits, cuts, and visual effects. | Choose how much Joy Code does on its own, and how much a single run may spend. | Safety and limits page | |
| Tune real-time visual ghost overlays and editor presence during agent runs. | Choose whether you see a live preview on the canvas while Joy Code works. | Live preview page | |
| Toggle permissions for timeline modification, audio processing, and generative vision tools. | Choose what Joy Code is allowed to read and change. | Tools and permissions page | |
| Run synthetic modality probes and inspect local GPU hardware acceleration telemetry. | Check that your computer draws the picture, and that the model understands pictures, sound and video. | Media support check page | |

| Old text (the big heading) | New text | Where it is | Owner's answer |
|---|---|---|---|
| AI Models & Custom Links | AI models | AI models page | |
| Execution Policy & Run Budgets | Safety and limits | Safety and limits page | |
| Live Previews & Experience | Live preview | Live preview page | |
| Tool Capabilities & Access Gates | Tools and permissions | Tools and permissions page | |
| System Health & Modality Probes | Media support check | Media support check page | |

---

## 2. The header and the footer

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Professional AI Engine Workspace | **Settings for Joy Code** | The small line under the dialog title | |
| Policy saved locally in browser. Sensitive keys secured in Windows DPAPI vault. | **Saved on this computer. Your keys are stored encrypted on this PC.** | The line at the bottom of the dialog | |
| Keys are encrypted via Windows DPAPI and never logged or proxied. | **Your keys are stored encrypted on this PC.** | Under the API key field | |
| (Saved in desktop vault) | **(Saved on this computer)** | Under the API key field, when a key is already saved | |

Why: the app is a desktop app, not a website, so "saved locally in browser" was wrong. "Windows DPAPI vault" is a name only the makers of Windows know. The owner asked for exactly these two sentences.

---

## 3. The four ways Joy Code can work

The four modes stay. Each one now has one short sentence that says what it does, and the default is marked.

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Suggest only | **Suggest only** | Safety and limits page, mode card | |
| Joy Code suggests creative plans and edits in chat without touching the timeline. | **Joy Code writes out what it would change and waits for you. It never touches your project by itself.** | Safety and limits page, under "Suggest only" | |
| Preview and approve | **Preview and approve (default)** | Safety and limits page, mode card | |
| Edits are previewed visually in the editor and require explicit approval before applying. | **Joy Code shows the change in the editor first, and only makes it when you say yes.** | Safety and limits page, under "Preview and approve" | |
| Auto-apply low risk | **Apply safe changes** | Safety and limits page, mode card | |
| Automatically executes non-destructive edits (cuts, trims, labeling) while gating large changes. | **Joy Code applies small, reversible changes such as cuts and trims on its own, and asks before anything bigger.** | Safety and limits page, under "Apply safe changes" | |
| Full auto within limits | **Work on its own** | Safety and limits page, mode card | |
| Autonomous multi-step execution within your configured cost and token budget limits. | **Joy Code works through a whole task on its own, as long as it stays inside the limits you set.** | Safety and limits page, under "Work on its own" | |

**(default)** is on **Preview and approve** and on no other mode. That is the mode a fresh install starts in.

---

## 4. The cost limit (this is the one number that changed)

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Run Budget & Spend Safety | **Cost limit for each run** | Safety and limits page, second block | |
| Max Cost per Run (USD) | **Maximum spend per run (USD)** | Safety and limits page, the field | |
| Limits API provider token consumption per autonomous execution session. | **JOY Media stops a run that would cost more than this. Prices are estimates from the provider. JOY Media itself charges nothing.** | Safety and limits page, under the field | |
| Max $10.00/run | **Up to $10.00 per run** | Safety and limits page, the small tag on the block | |

**The default limit per run changes from $10.00 to $0.50.**

- A **fresh install** starts at $0.50.
- **A limit you already saved stays as it is.** Nothing is raised or lowered behind your back; only the default for a new install changes.
- The line "Prices are estimates from the provider. JOY Media itself charges nothing." is there because the number is an estimate set by the provider, not a bill from JOY Media.

---

## 5. The media support check

The check answers one question: does the model you chose understand pictures, sound and video?

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Synthetic Media Capability Probe | **Media support check** | AI models page, third block | |
| Runs three tiny product-owned synthetic samples to verify multimodal image, audio, and video understanding. This check never sends your project, owner, or uploaded media to the provider, but your provider may charge or log these requests under its standard usage terms. | **Sends three tiny test clips to the model to see whether it understands pictures, sound and video. Your project and your media are never sent. Your provider may still charge for these three small requests.** | AI models page, under the block title | |
| Probe Verified | **Checked** | AI models page, the small tag | |
| Unprobed | **Not checked yet** | AI models page, the small tag | |
| Active Model Synthetic Modality Probe | **Does the model understand media?** | Media support check page | |
| Tests whether the active reasoning model parses image, audio, and video inputs. | **Checks whether the model you chose understands pictures, sound and video.** | Media support check page | |
| No probe run yet for the active model. | **Not checked yet for this model.** | Media support check page | |

The buttons stay as they were: **Check media support**, **Checking media support…**, **Checking…**.

---

## 6. What Joy Code may change (the tools list)

The list showed the internal names of the permissions. Each one now has a sentence a person can read.

| Old text | New text | Owner's answer |
|---|---|---|
| timeline.read | **Read the timeline** | |
| timeline.write | **Change the timeline** | |
| assets.read | **Read your media** | |
| assets.import | **Bring in new media** | |
| filesystem.read | **Read files** | |
| filesystem.write | **Write files** | |
| provider.generate | **Ask the model to create media** | |
| provider.spend | **Spend money at the provider** | |
| render.preview | **Draw previews** | |
| export.write | **Write the exported file** | |
| project.overwrite | **Overwrite the project** | |
| plugin.invoke | **Run plugins** | |

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Tool Capabilities Grid | **What Joy Code may change** | Tools and permissions page | |
| 12/12 Allowed | **12 of 12 allowed** | Tools and permissions page, the small tag | |

The names behind the list did not change: the same twelve permissions, the same keys, the same behaviour. Only the words on screen changed.

---

## 7. Smaller words that changed

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Categories | Categories (no change) | Left list, above the five pages | |
| Custom BYOK | **Your own API key** | AI models page, the first block | |
| One API-key provider (OpenRouter or a custom endpoint) | **One provider, with a key you enter here** | AI models page, under "Your own API key" | |
| No Active Model Connected | **No model connected** | AI models page, the banner at the top | |
| Tool loop ready · High capabilities | **Ready to edit your project** | AI models page, under the banner | |
| Plan-only ready · Creative brief available | **Ready for a creative brief only** | AI models page, under the banner | |
| Configure an API endpoint below to connect JOY Code. | **Connect a model below to start.** | AI models page, under the banner | |
| Saved Vault Profiles (3) | **Saved connections (3)** | AI models page, the block of saved connections | |
| Disabled legacy profile | **Old connection, no longer used** | On a saved connection | |
| API Connection & Authentication | **Connection and sign-in** | AI models page, the first block title | |
| Custom Endpoint | **Your own endpoint** | The small tag on that block | |
| Provider Platform | **Provider** | The first drop-down | |
| OpenRouter (BYOK) | **OpenRouter (your own key)** | The first drop-down | |
| Custom S3 / OpenAI Compatible | **Another provider (OpenAI compatible)** | The first drop-down | |
| Connection Profile Name (Optional) | **Name this connection (optional)** | The name field | |
| Base URL / Endpoint | **Service address (base URL)** | The address field | |
| API Secret Key | **Your API key** | The key field | |
| Model ID (User Editable) | **Model ID (you can change this)** | The model field | |
| Open Model Drawer | **Show model list** | Next to the model field | |
| Hide Model Drawer | **Hide model list** | Next to the model field | |
| Discover models behind API endpoint | **Find the models this service offers** | The tooltip on "Find models" | |
| Scanning… | **Finding models…** | The "Find models" button | |
| Discover Models | **Find models** | The "Find models" button | |
| Discovered Models Drawer | **Models found on this service** | AI models page, the second block title | |
| 3 Models Ready | **3 models ready** | The small tag on that block | |
| Click to Resolve | **Open to find models** | The small tag on that block | |
| Select a discovered model chip to populate the Model ID, or filter by keyword: | **Choose a model to fill in the model ID, or type a word to filter the list.** | Under the block title | |
| Refreshing… | **Checking again…** | The "Look again" button | |
| Refresh Models | **Look again** | The "Look again" button | |
| Scanning endpoint for available models... | **Looking for models…** | Inside the model list | |
| No models discovered yet. Enter Base URL and API Key above, then click "Discover Models". | **No models yet. Enter the service address and your key above, then choose Find models.** | Inside the model list | |
| No models matching current filter. | **No model matches that filter.** | Inside the model list | |
| Browse models & API connections | **Browse models and connections** | The button at the top of the AI models page | |
| Reauthorize | **Sign in again** | On a saved ChatGPT connection | |
| Execution Mode | **How much Joy Code does on its own** | Safety and limits page, the first block title | |
| Real-time Previews & Ghost Overlays | **What you see while Joy Code works** | Live preview page, the block title | |
| Show real-time previews on the monitor canvas during agent operations | **Show what Joy Code is doing on the canvas while it works** | Live preview page, the one switch | |
| Local Hardware & Worker Acceleration | **How your computer draws the picture** | Media support check page, the first block title | |
| Direct3D 11 Active | **Hardware acceleration is on** | The small tag on that block | |
| GPU Device | **Graphics card** | Media support check page | |
| Rendering Backend | **How it draws** | Media support check page | |
| Local Asset Library | **Your media folder** | Media support check page | |
| See Asset Library settings | **See the Asset Library settings** | Media support check page | |
| Local Worker SEA | **Background worker** | Media support check page | |

---

## 8. Words that did not change

These are already plain, and they stay:

- **Done** (the button at the bottom right).
- **Connect model**, **Connecting…**, **Clear connection**, **Disconnect**, **Use**, **Later**, **Remove**, **Working…**, **Check media support**, **Filter models (e.g. free, sonnet, 4o)...**, **All**, **Free**, **Claude**, **GPT**, **Image**, **Audio**, **Video**, **Supported**, **Unavailable**, **Configured model:**.
- The provider names themselves (OpenRouter, ChatGPT, and the rest of the provider list), the model names, the keys and the file names.

One more row to decide, because it is the only button whose wording still mixes two ideas:

| Old text | New text | Where it is | Owner's answer |
|---|---|---|---|
| Sign out & revoke | **Sign out and remove access** | On a saved ChatGPT connection | |
---

## 9. Words to avoid in this dialog

For anyone writing more text here later, these are the words the owner did not want, and what to write instead.

| Do not write | Write instead |
|---|---|
| Workspace, engine, brain, reasoning model | Joy Code, or the name of the model |
| BYOK, bring your own key | your own API key |
| Endpoint, base URL | service address (base URL) |
| Probe, modality, telemetry | check, pictures / sound / video |
| Autonomy, execution policy | how much Joy Code does on its own |
| Vault, DPAPI | saved on this computer |
| Capabilities, permissions, access gates | what Joy Code may change |
| Ghost overlays | live preview |

---

## 10. What was not changed, and what was not checked

- **Only the words changed.** No permission, no key, no model, no file and no stored value was touched by this card. The one number that changed is the default cost limit for a fresh install ($10.00 → $0.50); a saved limit stays.
- **The app was not launched.** Every line in this table was read out of the source and the code that renders it, not off a screenshot. The live check of the five pages is another card's job.
- **The wording table is the source of truth for the words**, and `apps/editor-web/src/settings-wording.ts` is the file the dialog reads them from. A test holds a snapshot of every string in that file, so a later change shows up in the diff instead of slipping in.
