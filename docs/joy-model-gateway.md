# JOY Model gateway operations

The gateway applies a per-user request limit in memory. It resets when the API process restarts, so it is an abuse throttle rather than a durable quota.

Daily spend is reserved against the ledger before requests are forwarded and settled atomically when a response completes. The cap resets at 00:00 UTC, which is 03:30 in Tehran (Asia/Tehran). A reservation or ledger failure returns `503 SPEND_LEDGER_UNAVAILABLE` before forwarding the request.

After a control-plane deployment, `deploy/deploy-control-plane.sh` runs `tooling/ops/smoke-gateway.mjs`. The smoke expects the model catalog to be public and an unauthenticated chat completion request to return `401`.
