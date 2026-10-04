# JOY Model gateway operations

The gateway applies a per-user request limit in memory. It resets when the API process restarts, so it is an abuse throttle rather than a durable quota.

The effective model catalog defaults to `openrouter/free` only. Paid catalog models are accepted only when their exact IDs appear in the server-side `JOY_GATEWAY_PAID_MODEL_ALLOWLIST` comma-separated environment variable. The public `GET /models` response reflects this effective allow-list and marks `openrouter/free` as default. Legacy model aliases use their catalog target only when that target is allow-listed; otherwise they resolve to `openrouter/free`.

Daily spend is reserved against the ledger before requests are forwarded and settled atomically when a response completes. Image inputs reserve a conservative 1,600 prompt tokens per image at the selected model's input price. Reservations older than 15 minutes are ignored and swept at startup and periodically. The cap resets at 00:00 UTC, which is 03:30 in Tehran (Asia/Tehran). A reservation failure returns `503 SPEND_LEDGER_UNAVAILABLE`; a bounded Postgres lock wait returns `503 SPEND_LEDGER_BUSY` before forwarding the request.

After a control-plane deployment, `deploy/deploy-control-plane.sh` runs `tooling/ops/smoke-gateway.mjs`. The smoke targets loopback with a `Host` header, has a 10-second timeout per request, expects public `GET /models` and unauthenticated `POST /chat/completions` to return `200` and `401`, and reports `503 JOY_AGENT_UNCONFIGURED` as a missing OpenRouter systemd credential. Use `--pre-cutover` for the same checks before a manual release switch; configure `JOY_GATEWAY_BASE_URL` and `JOY_GATEWAY_HOST` or pass `--base-url` and `--host`.
