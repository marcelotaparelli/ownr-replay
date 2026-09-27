# OWNR — product vision and engineering principles

OWNR (formerly "Repo Replay") helps developers acquire **verified technical ownership** of unfamiliar code. Current wedge: codebase ownership. Product goal today: the shortest path from "I don't know this" to "I understand it, can rebuild it, can navigate it and can safely change it". Every change must answer "which real problem does this solve?" — if the answer is vague, don't do it.

Philosophy (Arch-inspired): simple, minimal, explicit, performant, secure, observable, reliable, understandable. Minimal = the least code, dependencies, abstractions and infrastructure needed for a *robust* solution — not improvised code.

## Products
- **OWNR** — the brand/platform.
- **OWNR Replay** — verified technical ownership of unfamiliar code (the learning product in `src/` + `web/`). Keep it working and moving; it is both a product and the first organism.
- **OWNR Habitat** — closed-loop software evolution environment (`src/habitat/`, `web/habitat/`). *Humans define the mission and constraints. Mutation engines propose candidate changes. OWNR independently executes, observes, evaluates and selects them until the software approaches its desired measurable state without leaving its engineering envelope.* **Agents generate change. OWNR decides what survives.**

## Habitat rules (non-negotiable)
- The software is the evolving object: Mission, Desired State, Fitness, Envelope, Candidate lineage and independent evaluation are first-class. Agents are only one source of candidates (human, LLM, rule, search…); Habitat is not an agent orchestrator.
- Loop: observe → analyze → propose → mutate (isolated candidate) → execute → evaluate → select → promote/reject → observe. Never observe → change production.
- **The agent that writes a change never decides whether it passed**: its claims are stored as information, never as evidence; evaluators re-execute independently.
- **Control plane vs managed plane**: the organism cannot modify mission, envelope, evaluators, promotion rules, recorder or proposals; candidates may only touch the organism's allowed paths, enforced as a HARD constraint before anything runs. Evaluator code always runs from the control-plane checkout; envelope and fitness are snapshotted when the mission starts.
- **Evidence binding**: every evaluation is bound to baseline SHA, subject SHA, mission revision + hash, envelope hash and evaluator fingerprint (id + version/config). If any of them is no longer current the verdict is STALE and must be re-evaluated; legacy/unbound evidence is always STALE.
- **Verdicts** (no single fitness score; the metric vector and its trade-offs stay explicit): HARD FAIL/NOT_RUN or unmeasured protected metric ⇒ INELIGIBLE · stale evidence ⇒ STALE · broken protected metric, or objectives only worse ⇒ REGRESSED · better and worse at once ⇒ TRADEOFF · nothing better ⇒ NEUTRAL · proxies better ⇒ EXPERIMENT_READY (envelope fully green) or PROXY_IMPROVED (SOFT warnings or unknown proxies) · outcomes better with enough samples ⇒ OUTCOME_IMPROVED / MISSION_MET. **Proxy improvement is never mission improvement**: a candidate judged offline stops at EXPERIMENT_READY; outcomes are only measured in real use of a baseline. SOFT violations are warnings, never a reason to rank a candidate higher.
- Telemetry declares sample size and window; below minimum ⇒ INSUFFICIENT_DATA, and a mission is never "reached" without sufficient evidence. UI distinguishes PASS / FAIL / NOT_RUN / INSUFFICIENT_DATA / STALE — nothing is shown as passing without a check that ran.
- **Acceptance is a human act** (EXPERIMENT_READY ≠ improved ≠ accepted): only current, acceptable evidence; it fast-forwards the baseline branch to the candidate's commit (never merge commits, rewrites, push or deploy). The next observation of that baseline judges the experiment. Mission definitions change only through a human revision (revise-mission), which makes older evidence STALE. No self-modification of Habitat; LocalRunner/worktrees are NOT a security boundary (future: Docker/gVisor).
- Not now: auto deploy, swarms, RL/GA frameworks, ML, distributed workers, RBAC, billing, GitHub App, SAST platform, canaries, self-modifying Habitat.

## Product vision (reference for decisions — NOT a build list)
Internal statement: *OWNR is the engineering cockpit for the agentic software era. It helps developers acquire verified technical ownership of unfamiliar code today, and evolves toward an environment where humans direct software agents inside measurable constraints for architecture, security, reliability, performance, testing and observability.* Taglines: "Own the code. Direct the agents." · "From generated code to owned software." Thesis: AI made producing code cheaper; OWNR makes owning software cheaper.

- **Pilot analogy**: the developer sets destination, trajectory and limits and monitors instruments; automation (agents) executes; the human stays responsible — understands, decides, detects anomalies, intervenes. Progressive disclosure: normal → essential, warning → attention, critical → intervention; overview → module → function → line on demand.
- **Engineering flight envelope** (future): agents work inside verifiable constraints — architecture (dependency direction, module boundaries), clean-code signals, tests, security, performance budgets, reliability (timeouts, retries, idempotency), observability as the aircraft's instruments, resource limits. Distinguish HARD constraints (MUST NOT expose secrets) from GUIDELINES (prefer short functions); never become an architectural prison.
- **Deterministic envelope around probabilistic agents**: schemas, types, tests, rules, metrics, limits, sandboxes, human checkpoints. **The agent that implements does not decide it succeeded**: independent verifiers do. **Evidence-driven**: claims come with evidence (p95 = 34 ms, not "fast"; unit ✓ integration ✓, not "works"). **Flight recorder**: goal, agent, context, changes, decisions, checks, approvals — auditability and accountability.
- **Ownership proof ladder**: UNDERSTAND → REBUILD → NAVIGATE (find it in the real system) → CHANGE (a **novel** requirement never seen before, e.g. "tickets with 'data leak' get strong SECURITY evidence" — evidence of transfer, not repetition).
- **Planning is goal-directed**: `plan(repository, goal, existingKnowledge)` → the minimal cognitive route (a route, not a course). Two graphs: a Software Graph (calls, implements, imports, reads, writes…) and a **Knowledge Graph** (what must be understood before X). Future inputs include bugs, issues and PR reviews, not only "learn everything".
- **Real assets**: the pedagogical compiler, knowledge graph, ownership graph, verifiable engineering constraints, evidence graph, learning telemetry. Chat/LLM/RAG are commodities.
- **North Star: Time To Verified Ownership** — not lines generated, prompts, time spent or lessons completed.
- Future autonomy levels (1 agent suggests … 5 routine autonomous maintenance) must remain possible; nothing today should block that path.

**Current priority (in order)**: 1) make Module 1 pedagogically excellent; 2) validate with a real human; 3) convert more modules; 4) test different goals; 5) test external users; 6) only then automate Analyzer/Planner. **Not now**: agent runtime, enterprise policies, SAST platform, Kubernetes, CI platform, complex observability platform, organization management, agent orchestration. Meta-rule: OWNR's own code must demonstrate ownership, simplicity, constraints and evidence.

## Stack
Bun + TypeScript strict, `Bun.serve`, `bun:sqlite`, `bun:test`, Web APIs, HTML + CSS + vanilla TS (bundled with `Bun.build`), Docker only for real isolation. Before adding a dependency: does Bun/TS/the Web Platform already solve it? A dependency must buy complexity reduction, security, reliability, maintainability, performance or interoperability. Runtime deps today: `zod` (boundary validation) and `typescript` (its native `tsc`, used only to verify stages that teach types).

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

## Pedagogy (OWNR's core algorithm)
- Before any stage ask: "what is the smallest problem I must teach NOW so that, after several trivial evolutions, the learner arrives naturally at this part of the repo?" If it can be decomposed further without losing meaning, decompose.
- Micro stage = ONE new idea (two only if inseparable), understandable in 30 s–2 min, born from the previous stage's perceptible limitation: problem → minimal solution (green = ONLY the real line delta from the previous step) → understand → evolve the learner's OWN code (the task says WHAT, never HOW) → tests → next limitation.
- **Cumulative workspace**: a module's micro stages evolve one program. Stage N starts from the learner's accepted code of stage N−1 (never silently replaced by the reference; if they skipped, the reference is used and the UI says so). The first micro stage and every module checkpoint start from an empty editor; the checkpoint rebuilds everything, then compares yours ↔ replay ↔ real code.
- **Novelty budget**: prefer 1 concept + 1–5 relevant new lines per micro stage; more than 10 fails validation unless `noveltyException` justifies it — the answer is usually "decompose again".
- **Everything shown as correct code is executably correct**: solutions pass their tests (and tsc when types are taught), examples are executed, toolbox/explanation snippets type-check, shown code equals validated code, no HTML entities. Enforced by `bun test`, never by manual review.
- Journeys are planned from `repository + learning goal` (`PlanRequest`; conceptually also existing knowledge); "learn everything" is one goal among several. The output is a route to verified ownership, not a course.
- Terminology: "Replay" names the simplified pedagogical version of real code (Replay ↔ Real Code); the product is OWNR.
- **Progressive scaffolding**: complexity not yet taught may be hidden (auto `import`/`export`, previously rebuilt code as read-only support files, non-strict typechecking), but must be explicitly handed back to the learner — and rebuilt by them — when it becomes the concept being taught (e.g. modules/imports once modularization appears).
- When a concept is verifiable, verify it for real (e.g. stages teaching types run the actual TypeScript checker via `exercise.typecheck`).
- The tutor answers at the learner's current level; skipping (a step or a whole module) is always one click.
