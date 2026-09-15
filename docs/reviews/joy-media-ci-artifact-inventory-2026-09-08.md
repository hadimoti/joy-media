# GitHub Actions artifact storage — inventory + deletion record

The account's Actions **artifact storage quota was exhausted**, which is why
`actions/upload-artifact` failed on both benchmark-4 real-service passes.

## DONE — 2026-09-09 (owner-approved)

Per the owner's explicit approval ("delete the 44 specifically inventoried,
unreferenced artifacts; preserve the six QA-referenced; recheck references;
stop if the inventory or classification changed"):

- **References re-checked against `docs/qa/`** (the actual closeout/evidence
  records — a naive `docs/` grep is now polluted by _this_ inventory doc). Result
  **unchanged**: the same **6** artifacts are referenced, **44** are not.
- The computed 44-ID delete set was **cross-checked byte-for-byte** against the
  "44 unreferenced" table below — exact match.
- **44 artifacts deleted** (`gh api -X DELETE …/artifacts/<id>`), **0 failures**.
- **6 kept** (`9197194787`, `9153039335`, `9114994065`, `9099815687`,
  `9098859352`, `9097196418`).
- Repo artifact storage now **6 artifacts / 28,985,329 bytes ≈ 27.6 MiB** (was
  50 / 4.62 GiB). No storage purchased.

This doc (the inventory) is retained as the record. The remaining tables are the
pre-deletion state.

## Totals

`gh api repos/hadimoti/joy-media/actions/artifacts` — **50 artifacts,
4,961,371,159 bytes = 4.62 GiB, `expired: false` for all** (90-day auto-expiry
falls 2026-11-09 … 2026-11-13). **Every one is from `.github/workflows/ci.yml`**
(the push CI, on the self-hosted Windows runner), named `playwright-evidence*`,
created **2026-08-11 → 2026-08-15** during the WP-29 / WP-30 / WP-32 / WP-34
browser-audit stabilisation. **None** are from `release-candidate.yml` (which
uploads no artifacts), the Live Director R1/R2 gate, or the CI-opt benchmarks.

## Cross-reference against `docs/`

**6 of the 50** have their owning run id referenced in a `docs/qa/` closeout or
evidence file — these ARE historical debug evidence for prior work packages:

| artifact ID  |   MiB | run         | referenced by                                                                                                                                                                                                    |
| ------------ | ----: | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9097196418` | 10.35 | 31478310783 | `WP-29-closeout-review-log-20260810-0621.md`, `WP-29-gbrain-update-2026-08-10.md`, `WP-29-r6-closeout-20260810-0621.md`, `WP-29-session-features-20260811T101245Z.md`, `gpt-chrome-usage-audit-20260810-wp29.md` |
| `9098859352` | 10.30 | 31482690590 | `WP-29-session-features-20260811T101245Z.md`                                                                                                                                                                     |
| `9099815687` |  0.48 | 31485527770 | `WP-29-session-features-20260811T101245Z.md`                                                                                                                                                                     |
| `9114994065` |  5.41 | 31523239040 | `WP-30-final-live-closeout-20260812061237.md`, `WP-30-review-log-20260811.md`                                                                                                                                    |
| `9153039335` |  0.54 | 31622521087 | `docs/qa/evidence/wp32-20260812T141142Z/` (5 files)                                                                                                                                                              |
| `9197194787` |  0.55 | 31737233944 | `WP-34-final-live-closeout-20260814.md`                                                                                                                                                                          |

Total referenced: **6 artifacts, ~27.6 MiB.**

**44 of the 50** (≈ **4.59 GiB**) have NO reference anywhere in `docs/` — neither
the artifact id nor the owning run id. These are the storage cost.

## The 44 unreferenced artifacts (full list)

| artifact ID  |     bytes |    MiB | created    | run         |
| ------------ | --------: | -----: | ---------- | ----------- |
| `9090756764` |    192189 |   0.18 | 2026-08-11 | 31463471193 |
| `9091364226` |  89013974 |  84.89 | 2026-08-11 | 31463948738 |
| `9092323516` |   5874214 |   5.60 | 2026-08-11 | 31466117507 |
| `9094751941` |   5753654 |   5.49 | 2026-08-11 | 31472178105 |
| `9097026543` |  15708745 |  14.98 | 2026-08-11 | 31477962984 |
| `9100970495` |    507088 |   0.48 | 2026-08-11 | 31488110428 |
| `9102189633` |    507226 |   0.48 | 2026-08-11 | 31491080074 |
| `9112276154` | 118502368 | 113.01 | 2026-08-11 | 31515741022 |
| `9113250869` | 110898799 | 105.76 | 2026-08-11 | 31518690220 |
| `9113326072` |  82354851 |  78.54 | 2026-08-11 | 31519828019 |
| `9132410594` |    529518 |   0.50 | 2026-08-12 | 31571213349 |
| `9136924001` |  27079388 |  25.82 | 2026-08-12 | 31582746204 |
| `9143907953` |  87933065 |  83.86 | 2026-08-12 | 31599719225 |
| `9146856307` | 243721474 | 232.43 | 2026-08-12 | 31605582091 |
| `9149312840` |  34269243 |  32.68 | 2026-08-12 | 31612147821 |
| `9150887881` |  17597491 |  16.78 | 2026-08-12 | 31612147821 |
| `9157623994` | 156283734 | 149.04 | 2026-08-12 | 31633742757 |
| `9159220834` |    570322 |   0.54 | 2026-08-12 | 31638856293 |
| `9159331103` | 391657471 | 373.51 | 2026-08-12 | 31637993985 |
| `9159492451` |    570833 |   0.54 | 2026-08-12 | 31639516860 |
| `9159633931` |    571145 |   0.54 | 2026-08-12 | 31639316824 |
| `9159737293` |    569643 |   0.54 | 2026-08-12 | 31639824014 |
| `9159895957` |    570726 |   0.54 | 2026-08-12 | 31640045572 |
| `9161370500` | 127741699 | 121.82 | 2026-08-12 | 31644121410 |
| `9161567196` |  87735976 |  83.67 | 2026-08-12 | 31644754210 |
| `9195580623` |    598715 |   0.57 | 2026-08-13 | 31732996097 |
| `9199114698` |    574713 |   0.55 | 2026-08-13 | 31743454409 |
| `9200075720` |    576157 |   0.55 | 2026-08-13 | 31745087726 |
| `9206565808` |    581754 |   0.55 | 2026-08-14 | 31764151982 |
| `9225394231` | 633777885 | 604.42 | 2026-08-14 | 31812978413 |
| `9227097506` |    586443 |   0.56 | 2026-08-14 | 31818056776 |
| `9233345116` | 896271995 | 854.75 | 2026-08-14 | 31833860930 |
| `9235608102` | 897362511 | 855.79 | 2026-08-14 | 31840915895 |
| `9235648974` |  25536437 |  24.35 | 2026-08-14 | 31840337470 |
| `9237553919` | 255855363 | 244.00 | 2026-08-14 | 31847081355 |
| `9237992338` | 163631198 | 156.05 | 2026-08-15 | 31851247006 |
| `9237993288` | 234968779 | 224.08 | 2026-08-15 | 31851247006 |
| `9238022824` | 199120687 | 189.90 | 2026-08-15 | 31851247006 |
| `9238500574` |  14455952 |  13.79 | 2026-08-15 | 31853180655 |
| `9238513546` |    353957 |   0.34 | 2026-08-15 | 31853180655 |
| `9238517921` |    354121 |   0.34 | 2026-08-15 | 31853180655 |
| `9239168748` |    354629 |   0.34 | 2026-08-15 | 31855544698 |
| `9239171360` |    354796 |   0.34 | 2026-08-15 | 31855544698 |
| `9239176398` |    354902 |   0.34 | 2026-08-15 | 31855544698 |

## Options for the owner (none executed)

1. **Delete only the 44 unreferenced** → frees ~4.59 GiB, keeps every artifact a
   `docs/` closeout points at. Safest.
2. **Delete all 50** → frees the full 4.62 GiB. The 6 referenced ones would lose
   their uploaded HTML reports; the run _logs_ remain for 90 days and the QA
   docs already summarise the findings — but the review's caution stands: they
   are debug evidence, so this needs explicit per-item sign-off.
3. **Delete nothing; raise the storage limit / accept the failure.** With the v2
   contract, a failed `upload-artifact` reddens the gate (by design — a fallback
   copy does not waive the required upload), so option 3 means the gate stays red
   on upload until 2026-11 auto-expiry frees space.

Deletion is one call per id:
`gh api -X DELETE repos/hadimoti/joy-media/actions/artifacts/<id>`.
Recommendation: **option 1**, after the owner confirms this list.
