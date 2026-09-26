# Repo Replay

Transforma um repositório real em uma reconstrução pedagógica incremental, para dar **propriedade técnica** a um desenvolvedor o mais rápido possível. Golden sample: [`marcelotaparelli/ops-triage-ai`](https://github.com/marcelotaparelli/ops-triage-ai) @ `840b2bf`, em 8 stages.

```bash
bun install
bun run dev          # http://localhost:3000
bun test             # inclui validação do currículo (solução passa, starter falha)
bunx tsc --noEmit
bun run size         # bundle do frontend (gzip)
```

Variáveis (todas opcionais): `PORT`, `DB_PATH`, `DATA_DIR`, `RUNNER=browser|docker`, `ANTHROPIC_API_KEY`, `TUTOR_MODEL`. Sem chave, o Tutor roda em modo offline determinístico.

## Estrutura

```
src/domain      tipos e schemas (Zod) de journey, stage, progresso, tutor, arquitetura
src/services    carregamento/validação do currículo, tutor (contexto, offline, adapter LLM), URL do GitHub
src/http        roteador mínimo, API, app (request id, erros consistentes, estáticos + CSP)
src/sandbox     preparo de módulos (Bun.Transpiler, imports restritos), harness de testes, runners
src/db          bun:sqlite: progresso, conhecimento, tentativas, mensagens do tutor, eventos
web/            frontend vanilla TS (≈20 KB gzip), progresso local-first
data/golden/    jornada curada: stage.json + reference/ starter/ tests.ts + trechos originais no SHA fixo
```

Adicionar uma stage: crie `data/golden/<journey>/stages/NN-slug/` com `stage.json`, `reference/`, `starter/` e `tests.ts` (importando `replay:test`) e registre o slug em `journey.json`. `bun test` recusa a stage se a solução não passar, se o starter já passar, ou se referências/conceitos/linhas do original forem inconsistentes.

## Execução de código

- `RUNNER=browser` (padrão): o servidor só *transpila* (sem executar) e o código roda num Web Worker descartável no navegador do próprio aluno, com timeout. **Não é uma fronteira de segurança** — é o runner de desenvolvimento.
- `RUNNER=docker`: `DockerSandboxRunner` executa em container efêmero sem rede, com CPU/RAM/PIDs limitados, FS read-only e tmpfs. Imagem: `docker build -f sandbox-images/typescript/Dockerfile -t repo-replay-sandbox-ts:latest .` — **ainda não verificado** (sem Docker no ambiente de desenvolvimento).

Princípios de engenharia: ver `CLAUDE.md`.
