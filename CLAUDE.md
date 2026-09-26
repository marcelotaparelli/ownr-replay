# Repo Replay — engineering principles

Product goal: give a developer technical ownership of an existing repository as fast as possible. Every change must answer "which real problem does this solve?" — if the answer is vague, don't do it.

Philosophy (Arch-inspired): simple, minimal, explicit, performant, secure, observable, reliable, understandable. Minimal = the least code, dependencies, abstractions and infrastructure needed for a *robust* solution — not improvised code.

## Stack
Bun + TypeScript strict, `Bun.serve`, `bun:sqlite`, `bun:test`, Web APIs, HTML + CSS + vanilla TS (bundled with `Bun.build`), Docker only for real isolation. Before adding a dependency: does Bun/TS/the Web Platform already solve it? A dependency must buy complexity reduction, security, reliability, maintainability, performance or interoperability. Runtime deps today: `zod` only.

## TypeScript
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. No `any`, no `as unknown as`, no unjustified `!`. Prefer `unknown` + narrowing, discriminated/literal unions, `readonly`, derived types, schemas at the boundary.

## Validation
External data is untrusted: validate at boundaries (HTTP, env, LLM output, GitHub input, DB serialization, sandbox requests, filesystem metadata) with Zod, then pass validated domain data inward. No scattered defensive checks.

## Architecture
Modular monolith: `domain` / `services` (application) / `http` / `db` / `sandbox` / `obs` / `web`. Domain never depends on HTTP, SQLite, Docker, Anthropic or GitHub. Abstractions only at real boundaries (Tutor model, SandboxRunner, persistence, repository source, journey generator) — no single-implementation interfaces for their own sake. No microservices, queues, Redis, CQRS, event sourcing. KISS, YAGNI, DRY only for real concepts.

## Code
Explicit names, small functions, early return, linear flow, composition. No "Manager"/"Utils", obscure boolean params, magic numbers/strings, mutable global state. Comments explain *why* / trade-offs, not what.

## Async, security, sandbox
Every external call has a timeout (AbortSignal); think cancellation, cleanup, failure propagation, bounded concurrency (no `Promise.all` over unbounded lists). Least privilege, deny by default, fail safely, limit resources. Consider SSRF, path traversal, command injection (argv only, never shell strings), prompt injection, secret leakage, DoS, XSS. Never send secrets to an LLM. Learner code never runs in the backend process: `BrowserRunner` (web/run-worker.ts) is a dev runner and NOT a security boundary; `DockerSandboxRunner` is the isolated server-side runner (no network, CPU/RAM/PID limits, timeout, read-only FS, tmpfs, input/output caps).

## HTTP & errors
Validate input, correct status codes, body limits, timeouts, `x-request-id`. Error shape: `{ "error": { "code": "STAGE_NOT_FOUND", "message": "..." } }`. Never leak stack traces, paths or secrets. Never swallow exceptions (`catch {}`): handle, translate or propagate.

## Persistence
SQLite while it fits: transactions, constraints, indexes for real queries, prepared statements.

## Observability
Structured JSON log events (never `console.log("here")`, never tokens/secrets/full source). Metrics only for real questions (request/tutor/sandbox durations, sandbox timeouts/OOM, stage completed/skipped_known).

## Frontend
Tiny bundle (target < 60 KB gzip), no framework/state manager/CSS framework, semantic HTML, keyboard friendly, visible focus, local-first progress for instant feedback.

## Tests & done
`bun:test` for behaviour: domain logic, use cases, boundaries, security-sensitive paths, golden curriculum integrity. Bugs get a regression test. Done means: works, types correct, errors handled, relevant test exists, no needless complexity. Before claiming done run `bunx tsc --noEmit` and `bun test`; anything not validated is reported as **NOT VERIFIED**.

## Git
Coherent commits. Never push, force-push, destructive reset or deploy without explicit authorization.

## Decision order
security → correctness → simplicity → clarity → testability → performance → proven extensibility.

## Commands
- `bun run dev` — server with watch (http://localhost:3000)
- `bun test` — tests (includes golden curriculum validation: solution passes, starter fails)
- `bunx tsc --noEmit` — typecheck
- `bun run size` — frontend bundle size (gzip)
