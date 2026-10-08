# JOY Model gateway operations

The gateway applies a per-user request limit in memory. It resets when the API process restarts, so it is an abuse throttle rather than a durable quota.

The model catalog is a fixed list of five zero-cost OpenRouter `:free` models (`apps/api/src/joy-free-models.ts`), with `google/gemma-4-31b-it:free` as the default. `GET /models` returns exactly that list. Any other model id is refused with `MODEL_NOT_ALLOWED`; legacy ids (`openrouter/free`, `minimax/minimax-m3`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.3-70b-instruct`) resolve to the default. Paid models cannot be enabled: `JOY_GATEWAY_PAID_MODEL_ALLOWLIST` is ignored, with a startup warning if it is set.

Daily spend is reserved against the ledger before requests are forwarded and settled atomically when a response completes. Image inputs reserve a conservative 1,600 prompt tokens per image at the selected model's input price. Reservations older than 15 minutes are ignored and swept at startup and periodically. The cap resets at 00:00 UTC, which is 03:30 in Tehran (Asia/Tehran). A reservation failure returns `503 SPEND_LEDGER_UNAVAILABLE`; a bounded Postgres lock wait returns `503 SPEND_LEDGER_BUSY` before forwarding the request.

After a control-plane deployment, `deploy/deploy-control-plane.sh` runs `tooling/ops/smoke-gateway.mjs`. The smoke targets loopback with a `Host` header, has a 10-second timeout per request, expects public `GET /models` and unauthenticated `POST /chat/completions` to return `200` and `401`, and reports `503 JOY_AGENT_UNCONFIGURED` as a missing OpenRouter systemd credential. Use `--pre-cutover` for the same checks before a manual release switch; configure `JOY_GATEWAY_BASE_URL` and `JOY_GATEWAY_HOST` or pass `--base-url` and `--host`.
