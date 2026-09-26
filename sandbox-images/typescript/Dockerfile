# Build from the repository root:
#   docker build -f sandbox-images/typescript/Dockerfile -t repo-replay-sandbox-ts:latest .
FROM oven/bun:1.4-slim
WORKDIR /sandbox
COPY src/sandbox/harness.ts src/sandbox/execute.ts src/sandbox/runner.ts ./
COPY sandbox-images/typescript/entry.ts ./entry.ts
USER 65534:65534
ENTRYPOINT ["bun", "/sandbox/entry.ts"]
