# P01 gate review

Status: reviewed 2026-07-19. Owner directed P02 to start with the remaining integration evidence tracked below.

| Exit criterion                   | Evidence                                                | Status                                     |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| Create/open/save/recover         | `project-persistence` snapshot/log recovery tests       | Pass (desktop adapter)                     |
| Connect/disconnect Worker safely | pairing/revocation and Worker hello contracts           | Contract pass; live transport deferred     |
| Sample job end to end            | control-plane lease/event and Worker cancellation tests | Contract pass; cross-process loop deferred |
| Workspace restore                | Dockview local-layout recovery tests                    | Pass                                       |
| Durable changes use commands     | editor command controller + command history tests       | Pass for implemented edits                 |
| Contract tests                   | `pnpm check`                                            | Pass (130 tests)                           |
| joy-vps unaffected               | no VPS deployment/configuration changes were made       | Pass                                       |

The live Worker/API transport and actual PostgreSQL adapter remain X01/P02 integration work; they are not represented as production-complete here.
