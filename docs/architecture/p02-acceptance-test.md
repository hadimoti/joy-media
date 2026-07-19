# P02 automated acceptance fixture

The reference fixture is a synthetic, local 30-second social-edit specification. Automated tests exercise its reversible timeline commands, local snapshot/log recovery, proxy-playback scheduler behavior, dual-format FFmpeg/ffprobe export, and Worker lease recovery.

The export test is intentionally scaled down to a 100 ms 64×36 source while preserving the same frozen fixture revision and both aspect ratios. This validates the deterministic contract in CI; manual editor interaction and full-resolution performance remain separate acceptance work.
