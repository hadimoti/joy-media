# P02 gate review

Status: reviewed 2026-07-19. The rendering and job contracts are healthy, but P02 is **not accepted** as a usable editing vertical slice yet.

| Exit criterion                    | Evidence                                                                                                                     | Review        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 30–60 s local edit reopens intact | Persistence/replay is covered, but no 30–60 s editable fixture or editor timeline exists                                     | Open          |
| Undo/redo every core edit         | Timeline and visual-object command contracts have inverses; object commands are not yet persisted in the project command log | Open          |
| Proxy playback                    | Scheduler/cache/governor contracts exist; browser/proxy decoder is absent                                                    | Open          |
| 16:9/9:16 H.264/AAC Worker export | FFmpeg/ffprobe tests cover both formats through pair → lease → verified completion                                           | Contract pass |
| Worker/VPS interruption           | Expired lease reassignment rejects stale completion and preserves job completion path                                        | Contract pass |
| Golden reference                  | Frozen reference revision produces verified dual-format outputs                                                              | Contract pass |

Required finish work: durable object schema/commands, timeline/editor presentation, decoder/proxy playback, and a 30–60 s reference project with reopen proof.
