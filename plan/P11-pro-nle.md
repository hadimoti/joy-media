# P11 — Pro NLE grammar

## Goal
Premiere/CapCut timeline grammar: trim UI, media drop, markers, track CRUD, transitions schema, waveforms.

## Work packages
- [x] WP-11.1 Trim edge handles + trim commands wired
- [x] WP-11.2 Drag asset → timeline insert
- [x] WP-11.3 Marker rail (add/seek/remove)
- [x] WP-11.4 Track add/remove + durable mute via setTrackEnabled
- [x] WP-11.5 Transition schema (`TransitionV1`) on JoyProjectV1
- [x] WP-11.6 Transition apply in Pixi preview/export (P14.4 overlay; P16 dual-texture gl-transitions)

## Exit
Editor can trim, drop media, mark, and manage tracks without stubs pretending success.
