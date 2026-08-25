# جلسهٔ بعد: Joy Code providers + Admin V3 repolish

این سند یک handoff اجرایی است؛ هنوز هیچ provider جدیدی یا تغییر UI در این
جلسه پیاده‌سازی نشده است.

## خلاصهٔ تصمیم معماری

دو مفهوم را جدا نگه دار:

1. **Editing host:** فقط **KiloCode** است. این تصمیم در
   `docs/adr/0020-kilocode-as-sole-editing-agent-host.md` ثبت شده و Joy Code
   نباید برای Mistral، Copilot یا Hermes یک editing host دوم بسازد.
2. **Reasoning model / media provider:** مدل‌ها و سرویس‌های پشت KiloCode هستند.
   Mistral باید در این لایه اضافه شود، نه به‌عنوان یک پنل یا agent host موازی.

Mistral Vibe که در code-server نصب شده، یک surface توسعه‌دهنده با login خود
است؛ آن به‌تنهایی provider قابل فراخوانی برای اپ JOY Media نیست.

## وضعیت واقعی فعلی

- Joy Code در `apps/editor-web/src/AgentPanel.tsx` یک shell مکالمه روی KiloCode
  است.
- تنظیمات آن در `apps/editor-web/src/agent-settings.ts` فقط `activeHost:
'kilocode'` را می‌پذیرد، اما فیلدهای `reasoningModel` و `mediaProvider`
  آماده‌اند.
- `packages/agent-tools/src/kilocode-host.ts` از قبل امکان تزریق
  `ReasoningModelReference[]` و `MediaProviderReference[]` را در manifest
  KiloCode دارد.
- `packages/provider-sdk` قرارداد provider، انتخاب provider، privacy preflight،
  lifecycle، cost، idempotency و provenance را دارد؛ هنوز adapter زندهٔ Mistral
  یا endpoint JOY Media برای `llm.complete` وجود ندارد.
- در VPS یک reference برای secret Mistral در محیط Hermes وجود دارد، اما آن
  secret متعلق به مرز Hermes است و نباید خوانده، چاپ، commit یا خودکار به JOY
  Media منتقل شود.
- admin مقصد این کار، **Admin V3** در `joy-vps/webapp/admin-v2/` است که در
  `admin.joyteam.ir` و `joyteam.ir/admin-v2/` سرو می‌شود؛ این کار مربوط به
  editor JOY Media نیست.

## چیزی که از مالک لازم است

برای provider زندهٔ Mistral در Joy Code، یک **Mistral API key اختصاصی برای
JOY Media** لازم است. آن را در داشبورد Mistral با billing/limits مناسب بساز و
به‌صورت runtime-only در VPS قرار بده.

- نام پیشنهادی env: `JOY_MEDIA_MISTRAL_API_KEY`
- محل نهایی: `/etc/joy-media/api.env` با مجوز موجودِ server-only
- هرگز در `.env` محلی، Git، bundle مرورگر، تنظیمات Joy Code، prompt، لاگ یا
  GBrain قرار نگیرد.
- کلید Hermes را reuse نکن مگر مالک صریحاً همین کار را تأیید کند. حتی در آن
  حالت، مقدار کلید نباید از طریق چت یا checkout منتقل شود؛ یک ادمین VPS باید
  آن را مستقیم و محرمانه در runtime env مقصد وارد کند.

اگر فعلاً فقط می‌خواهیم Mistral Vibe کنار Kilo در Studio برای کار توسعه باشد،
هیچ API جدیدی لازم نیست. API key فقط برای فراخوانی برنامه‌نویسی‌شده از Joy
Code / Joy Media API لازم است.

## Milestone A — Mistral reasoning provider (اول انجام شود)

هدف: Joy Code همچنان از مسیر KiloCode فرمان‌های ساختاریافته را اجرا کند، اما
برای `llm.complete` بتواند Mistral را به‌عنوان provider server-side انتخاب کند.

### محدوده

1. یک adapter در provider layer بساز، مثلاً `packages/adapter-mistral` یا یک
   adapter هم‌مکان با API، فقط اگر قراردادهای workspace چنین مکانی را تأیید
   کنند.
2. provider manifest با این خصوصیات:
   - `id: 'mistral'` یا نام versioned معادل آن؛
   - `execution: 'remote-api'`؛
   - capability اولیه فقط `llm.complete`؛
   - model allowlist و metadata صریح؛
   - privacy disclosure، timeout، cancellation behavior و usage/cost mapping.
3. secret فقط در Joy Media API resolve شود؛ browser فقط provider/model ID و
   وضعیت masked دریافت کند.
4. یک API داخلی authenticated برای شروع job یا completion بساز. از browser به
   Mistral مستقیم call نزن.
5. خروجی را به pipeline job/provenance موجود وصل کن؛ request hash,
   idempotencyKey, provider/model/version, زمان و cost باید ثبت شوند.
6. KiloCode host manifest را با `ReasoningModelReference` واقعی پر کن؛
   `activeHost` همچنان `kilocode` بماند.
7. در Agent Settings فقط مدل‌های configured/healthy را نشان بده؛ input آزاد
   کنونی را به picker یا constrained value تبدیل کن، بدون نمایش secret.

### معیارهای پذیرش

- بدون `JOY_MEDIA_MISTRAL_API_KEY`: provider حالت `unconfigured` دارد و UI
  honest است؛ هیچ موفقیت fake نمایش داده نمی‌شود.
- با کلید runtime-only و policy مجاز: یک `llm.complete` read-only test از API
  تا provenance اجرا می‌شود.
- `local-only` و `ask-before-remote` قبل از خروج داده privacy preflight را
  enforce می‌کنند.
- spend و remote processing بدون approval مناسب اجرا نمی‌شوند.
- کلید در source، test fixtures، response، log و browser storage وجود ندارد.
- tests، typecheck و production build clean هستند.

### عمداً خارج از scope

- Mistral را editing host دوم نکن.
- Hermes را به editor tools وصل نکن.
- برای Copilot یا هر provider دیگر adapter نساز؛ ابتدا Mistral end-to-end را
  کوچک و قابل‌آزمون تمام کن.
- model/provider selection را به یک dropdown تزئینی بدون backend واقعی تبدیل
  نکن.

## Milestone B — provider registry و health UI

بعد از Milestone A:

1. registry server-side برای providerهای configured بساز.
2. health، unconfigured، unauthorized، degraded و offline را با contract
   `ProviderLifecycleState` نشان بده.
3. provider انتخاب‌شده را با policy، cost budget و privacy constraints به
   resolver موجود بده.
4. برای هر invocation، approval و audit trail قابل‌خواندن نگه دار.
5. برای providerهای بعدی (OpenAI/Claude/Gemini/local) فقط همان contract را
   reuse کن؛ به Joy Code host جدید احتیاج نیست.

## Milestone C — Admin V3 repolish (کاملاً جدا از provider work)

هدف: Admin V3 تمیزتر، آرام‌تر و minimal شود، **بدون تغییر architecture، route،
API contract، information architecture، navigation یا visual identity**.

### قواعد غیرقابل‌تغییر

- فقط در `joy-vps/webapp/admin-v2/` کار کن؛ legacy `/admin/` را دست نزن.
- page/route/tab/action/API جدید نساز.
- چیدمان صفحات، نام بخش‌ها، semantics و مسیرهای approve/propose/reject ثابت
  می‌مانند.
- graphها، topology و data density حذف یا redesign نمی‌شوند؛ فقط خوانایی و
  hierarchy بهتر می‌شود.
- ابتدا screenshot baseline و inventory کامپوننت‌ها را بگیر، سپس یک صفحه در
  هر بار اصلاح کن.

### تغییرات مجاز

- یکسان‌سازی spacing، radius، border، shadow، surface contrast و typography
  با tokenهای موجود؛
- کاهش visual noise در cardها، badgeها، جدول‌ها، headerها و empty/loading
  stateها؛
- بهبود focus، hover، disabled، truncation و responsive behavior؛
- حذف only dead/redundant decorative CSS پس از visual regression check؛
- بهینه‌سازی label/copy کوتاه، بدون تغییر معنا یا workflow.

### ترتیب اجرا

1. `docs/JOY-ADMIN-V3-STATE-2026-08-03.md` و component/API inventory را بخوان.
2. baseline desktop + narrow viewport برای Command Center، Agents، Access و
   Observability بگیر.
3. token audit و inventory duplicate CSS انجام بده.
4. ابتدا shared shell/navigation/tokens، سپس cards/tables/forms، سپس هر صفحه
   را با visual regression بررسی کن.
5. build، tests، keyboard navigation و هر gate مربوط به write actions را
   بررسی کن.
6. فقط بعد از تأیید owner deploy کن؛ API/backend deployment برای repolish
   front-end لازم نیست.

## دستور شروع برای جلسهٔ بعد

```text
Open C:\Users\HadiMoti\joy-media\docs\NEXT-SESSION-JOYCODE-PROVIDERS-ADMIN-REPOLISH-2026-08-06.md first.

Implement only Milestone A: the smallest production-honest Mistral reasoning
provider behind the existing KiloCode Joy Code host. Do not add a second editing
agent host, do not connect Hermes to editor tools, and do not read/copy any
existing Hermes secret. If JOY_MEDIA_MISTRAL_API_KEY is not configured in the
VPS runtime environment, implement the fail-closed unconfigured path and stop
before any live invocation. Use provider-sdk contracts, server-side secret
resolution, privacy/approval gates, provenance, and focused tests.

Do not begin the Admin V3 repolish until Milestone A is committed, tested, and
explicitly approved for deployment.
```
