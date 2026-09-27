# OWNR

**Own the code. Direct the agents.**

> AI made producing code cheaper. OWNR makes owning software cheaper.

OWNR é o cockpit de engenharia para a era de software feito com agentes. Hoje: dar a um desenvolvedor **propriedade técnica verificada** sobre código que ele não conhece, pelo menor caminho cognitivo — entender, reconstruir, navegar no código real e mudá-lo com segurança. Visão: um ambiente em que humanos dirigem agentes dentro de restrições mensuráveis de arquitetura, segurança, confiabilidade, performance, testes e observabilidade (ver `CLAUDE.md` → Product vision).

Estágio atual: **ownership learning engine** sobre um golden sample curado — [`marcelotaparelli/ops-triage-ai`](https://github.com/marcelotaparelli/ops-triage-ai) @ `840b2bf`. Module 1 está decomposto em micro etapas; os módulos 2–8 ainda são capítulos.

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

Cada módulo decompõe um capítulo do repo em **micro etapas** de 1–2 minutos, com **uma ideia nova** cada: problema mínimo → solução mínima (verde = só o delta real em relação à etapa anterior) → entenda → **evolua o seu próprio código** → testes → **nova limitação**, que motiva a etapa seguinte. As micro etapas de um módulo evoluem **um único programa**: a etapa N começa do código que você teve aceito na etapa N−1 (se você pulou, começa da referência dela, com aviso). O módulo termina num **checkpoint**: editor vazio, reconstruir tudo e comparar *sua versão ↔ replay consolidado ↔ código real*.

A home pergunta **o que você quer entender** (aprender do zero, fluxo principal, uma parte específica…). Hoje só "aprender do zero" tem jornada curada; os demais objetivos são registrados (`journey_requests`) e alimentarão o futuro Planner (`plan(repository, goal)`).

Tudo que aparece como código correto é validado por `bun test`: soluções passam nos testes (e no `tsc` quando a etapa ensina tipos), exemplos são executados, snippets da Toolbox passam no `tsc`, e cada micro etapa respeita o orçamento de novidade (≤ 10 linhas relevantes novas, com a tabela impressa no teste).

- Module 1 é gerado por `scripts/author-golden-m1.ts` (edite lá e rode `bun scripts/author-golden-m1.ts`).
- Os módulos 2–8 ainda são capítulos não decompostos (`kind: "chapter"`, com starter).
- Layout de uma stage: `stage.json`, `reference/` (solução mostrada), `given/` (arquivos fornecidos), `tests.ts` (importa `ownr:test`); capítulos também têm `starter/`. `bun test` recusa a jornada se uma solução não passar, se o ponto de partida já passar, se uma micro etapa tiver starter ou não nomear sua limitação.

## Execução de código

- `RUNNER=browser` (padrão): o servidor só *transpila* (sem executar) e o código roda num Web Worker descartável no navegador do próprio aluno, com timeout. **Não é uma fronteira de segurança** — é o runner de desenvolvimento.
- `RUNNER=docker`: `DockerSandboxRunner` executa em container efêmero sem rede, com CPU/RAM/PIDs limitados, FS read-only e tmpfs. Imagem: `docker build -f sandbox-images/typescript/Dockerfile -t repo-replay-sandbox-ts:latest .` — **ainda não verificado** (sem Docker no ambiente de desenvolvimento).

Visão do produto, princípios pedagógicos e de engenharia: ver `CLAUDE.md`.

## OWNR Habitat

O Habitat (evolução em circuito fechado) vive no repositório próprio `../ownr-habitat` e trata este repositório como **organismo**: observa a baseline (`master`), avalia candidates em worktrees isolados e só avança a baseline (fast-forward) quando um humano aceita. O instrumento que ele lê é `bun scripts/measure.ts <curriculum|bundle>` (JSON).
