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

## Pedagogia: módulos e micro etapas

Cada módulo decompõe um capítulo do repo em **micro etapas** de 1–2 minutos, com **uma ideia nova** cada: problema mínimo → solução mínima (linhas novas destacadas, nota por linha) → entenda → **reconstrua do zero** (editor vazio, solução escondida) → testes → **nova limitação**, que motiva a etapa seguinte. O módulo termina num **checkpoint**: reconstruir tudo do zero e comparar *sua versão ↔ replay consolidado ↔ código real*. "Já sei isso" e "Já domino este módulo" pulam sem bloquear.

O aluno escreve código puro: `export` é adicionado automaticamente para os nomes que os testes usam, e o que etapas anteriores já construíram (tabelas, funções) vem como arquivo fornecido, importado automaticamente. Só a ideia nova é reescrita.

- Module 1 é gerado por `scripts/author-golden-m1.ts` (edite lá e rode `bun scripts/author-golden-m1.ts`).
- Os módulos 2–8 ainda são capítulos não decompostos (`kind: "chapter"`, com starter).
- Layout de uma stage: `stage.json`, `reference/` (solução mostrada), `given/` (arquivos fornecidos), `tests.ts` (importa `replay:test`); capítulos também têm `starter/`. `bun test` recusa a jornada se uma solução não passar, se o ponto de partida já passar, se uma micro etapa tiver starter ou não nomear sua limitação.

## Execução de código

- `RUNNER=browser` (padrão): o servidor só *transpila* (sem executar) e o código roda num Web Worker descartável no navegador do próprio aluno, com timeout. **Não é uma fronteira de segurança** — é o runner de desenvolvimento.
- `RUNNER=docker`: `DockerSandboxRunner` executa em container efêmero sem rede, com CPU/RAM/PIDs limitados, FS read-only e tmpfs. Imagem: `docker build -f sandbox-images/typescript/Dockerfile -t repo-replay-sandbox-ts:latest .` — **ainda não verificado** (sem Docker no ambiente de desenvolvimento).

Princípios de engenharia: ver `CLAUDE.md`.
