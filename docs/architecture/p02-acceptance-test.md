# P02 automated acceptance fixture

The reference fixture is a synthetic, local 30-second social edit with two tracks and five clips. Its automated end-to-end workflow exercises reversible timeline commands, local snapshot/log recovery, proxy-playback scheduler behavior, dual-format FFmpeg/ffprobe export, and Worker lease recovery.

The export test is intentionally scaled down to a 100 ms 64×36 source while preserving the same frozen fixture revision and both aspect ratios. This validates the deterministic contract in CI. The §30.3 benchmark fixture likewise uses a scaled-down profile in CI; its full 1-hour/100-track/10,000-clip target is reserved for named reference hardware. Manual editor interaction and full-resolution performance remain separate acceptance work.
