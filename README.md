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

Ambiente de evolução em circuito fechado. **Agentes geram mudança; o OWNR decide o que sobrevive.** O OWNR Replay é o primeiro Organism.

```bash
bun run habitat            # Cockpit em http://127.0.0.1:3100 (só loopback)
bun run habitat observe    # mede a baseline (HEAD) num worktree isolado
bun run habitat evolve <proposta>   # candidate isolado → avaliadores → decisão
bun run habitat reevaluate <candidate>          # repete a mudança sobre a baseline atual
bun run habitat accept <candidate> --by <nome>  # ato humano: vira a nova baseline (fast-forward)
bun run habitat revise-mission --by <nome>      # ato humano: adota uma definição de missão alterada
bun run habitat status
```

- **Missão** `replay-ttvo-m1`, **envelope**, **fitness** e contra-métricas: `src/habitat/replay/organism.ts`. A missão é gravada (snapshot) em `habitat.sqlite` quando começa; mudar o arquivo depois não afrouxa uma missão em andamento.
- **Propostas** (entrada, de qualquer origem): `habitat/proposals/<id>/{proposal.json,change.patch}`, patch contra a baseline. As `claims` do autor são guardadas como informação, nunca como evidência.
- **Candidates** rodam em `git worktree` fora do repositório (`HABITAT_WORKTREES`, padrão `~/.cache/ownr-habitat/worktrees`); a revisão fica em `refs/habitat/candidates/<id>` para inspeção, mesmo rejeitada. A baseline nunca é alterada.
- **Evidência vinculada** a baseline SHA, candidate SHA, revisão/hash da missão, hash do envelope e versão/configuração de cada avaliador. Se algo disso muda, o veredito vira **STALE** e o candidate precisa ser reavaliado.
- **Vereditos** (vetor de métricas, sem score único): INELIGIBLE · STALE · REGRESSED · TRADEOFF · NEUTRAL · PROXY_IMPROVED · EXPERIMENT_READY · OUTCOME_IMPROVED · MISSION_MET. Proxies (novidade por etapa) melhores levam no máximo a EXPERIMENT_READY; só outcomes de uso real com amostra suficiente (tempo por etapa, checkpoint, mudança inédita) chegam a OUTCOME_IMPROVED. SOFT é aviso.
- **Aceitar** é um ato humano (Cockpit ou CLI): faz fast-forward da branch atual até o commit do candidate, que vira a nova baseline. Sem merge commit, push ou deploy; a próxima observação julga o experimento e a geração seguinte parte dela.
- Os comandos rodam no host com os direitos do usuário: **worktree não é fronteira de segurança**.
