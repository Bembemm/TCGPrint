# Fase 15 — perfil e resultados de performance

Base obrigatória: `18bcad3916b2ff2137ca3f1bfa747236e69c4072`

Branch: `feature/fase-15-performance`

Runtime da medição final: Node `v22.23.3`, npm `10.9.9`, Linux x64, 4 CPUs lógicas.

Os números são medianas de três processos Node/Vitest independentes. Cada JSON conserva as três amostras por cenário. A suíte usa fixtures sintéticas offline, não contém imagens licenciadas e não faz pedidos à internet. RSS/heap são amostrados a cada 5 ms; podem não capturar picos curtos. Tempos são dados comparativos, não limites frágeis de CI.

## Reproduzir

O modo `baseline` só aceita a base exata, para impedir que alterações da feature contaminem essa medição. Em um worktree temporário na base, copie os dois arquivos do harness abaixo e instale/ligue as dependências do projeto:

```sh
git worktree add --detach /tmp/tcgprint-phase15-baseline 18bcad3916b2ff2137ca3f1bfa747236e69c4072
mkdir -p /tmp/tcgprint-phase15-baseline/tests/performance /tmp/tcgprint-phase15-baseline/scripts
cp tests/performance/phase-15-performance.test.ts /tmp/tcgprint-phase15-baseline/tests/performance/
cp scripts/phase-15-benchmark.mjs /tmp/tcgprint-phase15-baseline/scripts/
ln -s "$PWD/node_modules" /tmp/tcgprint-phase15-baseline/node_modules
cd /tmp/tcgprint-phase15-baseline
node scripts/phase-15-benchmark.mjs baseline
```

Copie `artifacts/phase-15-performance/baseline.json` desse worktree para este diretório. Na branch otimizada:

```sh
npm run benchmark:phase15 -- optimized
npm run summarize:phase15
```

O modo otimizado executa 51 cenários três vezes e substitui `optimized.json`, os resumos e o manifest. `benchmark:phase15` não é teste de unidade nem gate absoluto de tempo.

## Matriz de baseline → resultado

| Área | Baseline observada | Gargalo | Mudança mantida | Resultado medido |
| --- | --- | --- | --- | --- |
| PDF, 500 usos de um JPEG | 500 chamadas de embed, 500 XObjects, 19.632.382 bytes, 197,8 ms | O mesmo recurso de imagem era embutido por posição | Deduplicação collision-safe por conteúdo dentro de cada PDFDocument; cada slot ainda desenha sua própria posição | 1 embed/XObject, 500 draws, 59.466 bytes, 131,7 ms; −33,4% de wall time |
| PDF, 500 artes únicas | 500 recursos, 25.530.919 bytes, 225,9 ms | Custo normal de serializar recursos distintos | Sem compartilhamento entre conteúdos distintos; embed usa caminho sem cache para hashes que ocorrem uma vez | 500 recursos e exatamente 25.530.919 bytes. Mediana wall time recente 278,8 ms vs 225,9 ms, sem ganho de tempo demonstrado; amostras têm ampla sobreposição e CPU medido foi menor. Pico RSS: 374,1 → 345,9 MiB. Não alegamos aceleração para arte única |
| Candidate/original repetidos | Em 500 slots: 500 lookups de candidate e 500 de original | Releitura/revalidação da mesma seleção na exportação | Memo scoped à exportação para candidatos/contextos e originais repetidos; buffers grandes únicos não entram na memoização | 1 lookup de cada em 500 slots repetidos; artes únicas continuam em 500/500 |
| Bleed, cache warm | 11,0 ms para 283.012 bytes | Decode de pixels era feito antes de descobrir cache hit | Validação, metadata e hash completos permanecem; decode/máscara só após cache miss | 2,2 ms, os mesmos 283.012 bytes; teste confirma que warm hit não chama decode |
| Bleed, 500 artes repetidas | 1.946,2 ms, 500 lookups, 1 derivado | Lookup/export repetido por slot e embed repetido no PDF | Deduplicação de candidate, original, derivado e XObject; fila bounded | 247,0 ms; lookups 500→1; PDF 11.536.046→90.539 bytes |
| Bleed, 500 artes únicas sintéticas | 5.325,4 ms, pico de fila 1, 500 misses | Derivações sequenciais | Duas operações nativas simultâneas quando há mais de uma CPU disponível; sem Worker Threads | 4.134,1 ms (−22,4%), pico da fila 2, mesmos bytes de PDF (10.610.692); pico RSS total 315,8 → 296,3 MiB |
| Projeto, mudança em 1 de 500 cards | 32,6 ms e 500 entradas serializadas | Snapshot completo é refeito | Nenhuma mudança: a medição otimizada foi 37,9 ms, sem evidência para mudar schema/serializer | Incremental Project processing rejeitado nesta rodada |
| Working Set / artwork / Projects | SSR mostra todos os elementos; 500 cards: 189 ms / 78 ms / 28 ms | Browser paint/scroll pode ser relevante, mas SSR não mede isso | Nenhuma virtualização sem benchmark de browser | Chromium e Playwright não estão instalados. Scroll, foco, teclado, drag/drop e reorder não foram medidos; nenhuma virtualização foi implementada |
| Import | Parser local: 3–7 ms em 9/100/500/1000 entradas | Sem gargalo observado no parser offline | Caminho mantido | Sem ganho consistente; persistência/remote catalog não fazem parte desse cenário |
| Exports sequenciais | 3 × 500 artes únicas: RSS pico 459,1 MB; outputs iguais | PDFDocument precisa manter recursos distintos até salvar o PDF | Memoização não mantém buffers únicos extras; não há cache global | RSS pico 434,0 MB. RSS depois de cada export: 402,6 / 428,3 / 434,0 MB; heap ~36–46 MB. Não houve crescimento relevante entre exportações 2 e 3, mas amostra de três não prova comportamento ilimitado |

Métricas detalhadas para todos os cenários, incluindo 9/100/500/1000, CPU, heap/RSS, páginas, bytes, lookups, cache hit/miss e amostras brutas estão em `benchmark-summary.json`, `memory-summary.json`, `cache-summary.json`, `baseline.json` e `optimized.json`.

PDF 1000 não foi medido: o produto limita exportações a 500 cartas físicas por PDF. Import, parser, Working Set, artwork list e SSR foram medidos até 1000. Bleed 100/500 usa raster sintético compacto de 96 × 134 para permitir comparação repetível rápida; o cenário bleed 9 usa 745 × 1040. PDF sem bleed usa JPEG sintético 745 × 1040 em todas as escalas 9/100/500.

Uma medição preliminar anterior reportou cerca de 434 MiB ao gerar 500 imagens únicas junto com fixtures produzidas em `Promise.all`. A comparação reproduzível atual cria fixtures sequencialmente: export único de 500 artes tem pico base 374,1 MiB e otimizado 345,9 MiB; três exports sequenciais têm pico 437,8 MiB na base e 413,9 MiB otimizado. O primeiro número mistura construção de fixtures com export; o segundo inclui a retenção/arena nativa do mesmo processo ao longo das três exportações.

## Política de cache e memória

- PDF raster: cache criado dentro de `LosslessPdfEngine.generate()` e destruído com esse PDFDocument. A key cobre formato, comprimento, dimensões, bit depth/color type ou precisão/componentes JPEG e SHA-256. Reuso ainda exige igualdade byte a byte contra o snapshot privado embutido; mutation do buffer chamador não pode validar um recurso stale. Collision buckets mantêm conteúdos diferentes separados.
- Bleed: `MemoryBleedCache` fica no escopo da exportação/request. A key conserva versão do algoritmo, hash dos bytes originais, bleed, dimensões de trim, rounded corners e raio/versão da máscara quando aplicável. O cache de PNG derivado é rebuildable; nenhum original é elegível a GC.
- Candidate/original: memoização somente na exportação atual e apenas para candidatos realmente repetidos. Dados de originais são os mesmos buffers usados pelos slots, não cópias extras para 500 IDs únicos. Mapas desaparecem ao concluir, falhar ou cancelar a operação.
- Artwork stores existentes permanecem: originals content-addressed e imutáveis; thumbnails validados por hash/comprimento; metadata com a expiração atual. Nenhum cache persistente ou GC destrutivo novo foi criado.
- O endpoint de PDF de importação agora constrói seu `BleedEngine` por request; um cache global não podia ter hit útil nesse fluxo de uma única arte e retinha derivatives de requests não relacionados.

## Concorrência, cancelamento e progresso

Não foram introduzidos Worker Threads. A fila de bleed tem no máximo duas operações nativas simultâneas quando `availableParallelism() > 1`, senão uma. Cancelar impede começar itens pendentes, aguarda operação Sharp já iniciada e descarta os resultados sem criar PDF. O teste verifica limite, ordem dos diagnósticos e que itens enfileirados não começam após abort.

A UI agora encaminha AbortSignal em resolução, preparação/seleção de artwork e export PDF; controles nativos permitem cancelar e o resultado parcial não substitui Working Set nem cria URL/download PDF. Import mantém os sinais existentes no parser/API, mas não ganhou botão: após parse, originals e registros são persistidos arquivo a arquivo, sem fronteira atômica para prometer cancelamento sem estado parcial. OCR/downloads existentes continuam com os sinais atuais. Não foi criado protocolo de progresso: os cenários locais de import são curtos e o endpoint de PDF não fornece contagem confiável de páginas ao cliente.

## Fidelidade obrigatória

Nenhum caminho de redução de qualidade foi introduzido. JPEG continua em `embedJpg` com os bytes originais; PNG usa embed lossless; PNG16 mantém samples de 16 bits e alpha; SVG continua validado e desenhado vetorialmente, sem cache/rasterização nova. O preview não é usado no PDF. Bleed usa a mesma extensão de borda lossless, trim e máscara de rounded corners; cada draw mantém clipping/transform independente. Geometria física de trim 63,5 × 88,9 mm, guias vetoriais, registration, duplex e calibração não foram alterados.

Testes de fidelidade exercitam stream JPEG passthrough, igualdade de bytes, PNG16 color/alpha, dedupe de recursos com draws por slot, colisão de digest, PNG, SVG vetorial, identidade de pixels de bleed/rounded corners e regressões existentes de geometria, guides, registration, duplex e calibration. Nenhum benchmark substitui esses testes.

## Avaliado e não implementado

- Worker Threads: fila in-process fornece ganho medido sem custo de cópia/transferência, lifecycle e shutdown de workers.
- Concorrência 4 em produção: rejeitada; a baseline anterior observou ganho pequeno de 2→4 com event-loop delay de 91→212 ms. Produção fica limitada a 2. A medição diagnóstica 1/2/4 permanece apenas no benchmark.
- Virtualização própria ou biblioteca: adiada pela indisponibilidade de browser real; SSR não demonstra usabilidade de foco/reorder.
- Cache global/LRU/GC de bleed, GC de originals, cache de páginas PDF: não introduzidos; não há evidência que compense memória/invalidation extra, e originals são imutáveis.
- Incremental Project snapshot/serializer: rejeitado porque a mudança única em 500 itens continuou custando dezenas de ms sem ganho demonstrado.
- Novo protocolo de progresso: adiado por ausência de contagem end-to-end confiável.
- Downsampling, resize, reencode JPEG, troca de formato, redução de bit depth, mudança de alpha/cor, SVG rasterizado, thumbnail no export e qualquer aproximação geométrica: proibidos e não implementados.

## Browser benchmark

Não executado: `chromium`, `chromium-browser`, `google-chrome`, Playwright, `@playwright/test` e Puppeteer não estão disponíveis no ambiente. Os números SSR em `baseline.json` e `optimized.json` são informativos e não validam scroll, interação, acessibilidade ou paint. Nenhuma lista foi virtualizada.

## ADR

`docs/adr/0015-phase-15-performance.md` registra decisões de resource sharing no PDF, escopo de caches, memória, concorrência bounded, invalidação considerada e otimizações rejeitadas.
