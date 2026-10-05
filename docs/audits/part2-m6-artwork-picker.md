# Auditoria de implementação — Part 2 / M6 Artwork Picker

## Baseline e limites

- Branch: `feature/part2-m6-artwork-picker`.
- Base: `origin/main` em `f2afa106b000f499ce942030addfd5a2c36b41d9`.
- Fonte de comportamento: `IMPLEMENTATION_PLAN.md`, delta de `IMPLEMENTATION_PLAN_PART2.md` e ADRs aceitos 0005, 0006, 0010, 0015, 0017 e 0018.
- A M6 reutiliza catálogo, providers, storage, identidade, Working Set, Project, Back Library e export existentes. Não cria uma segunda fonte de candidatos nem persiste estado visual do picker.
- Geometry, bleed, trim, registration, duplex, calibration, cut e PDF não foram alterados.

## Matriz de ownership e delta

| Capability | Owner antes da M6 | Delta M6 | Owner depois da M6 | Evidência |
| --- | --- | --- | --- | --- |
| Catálogo Scryfall, MPC e uploads | `CardWorkbench`, `/api/cards/[identity]/artworks` e `card-identity-workbench.tsx` | Filtros de provider no picker | Mesmo `CardWorkbench` e mesma resposta completa do catálogo | `artwork-catalog-flow.integration`, `artwork/catalog`, `mpc-provider-advanced` |
| Metadados, preview e original | providers, `ArtworkCandidate`, storage e `card-api.ts` | Metadata no card; preview lazy; original preparado só na escolha | Mesmos providers e storage | `artwork-quality-hydration`, `card-api`, `card-export` |
| Catálogo/request cache | `artworkCatalogRequests` e funções keyed no workbench | Página visual de 60 resultados sobre todos os candidatos carregados | Cache/request existente do workbench | `artwork-picker-dialog`, `artwork-catalog-flow.integration` |
| Qualidade e cancelamento | `ArtworkQualityHydrator`, limite 3 e geração keyed | Hidrata somente a página visível; mantém cancelamento e descarte stale | Mesmo hydrator e cache M3 | `artwork-quality-hydration`, `card-identity-workbench.tsx` |
| Working Cards e history | reducer/history em `card-identity-workbench.tsx` | Aplica resposta canônica como um `apply-resolve-all-result` | Mesmo reducer/history | `working-card-editor-ui`, `workspace-card-selection.interaction` |
| Seleção por cópia no compositor | `registration-layout-preview.tsx` expande quantidade e mantém o índice físico selecionado | Ação contextual envia ID, índice físico global, face e número/total da cópia | Compositor continua dono do índice; picker só o recebe | `canonical-compositor.interaction`, `workspace-card-selection.interaction` |
| Back Library e Project Default | serviço/controles Back Library e `ProjectSettings` | Picker consome assets existentes e envia referência imutável | Mesmos endpoint, asset IDs e persistência | `back-library-controls`, `artwork-picker-context.interaction`, `project-serializer` |
| Export e verso efetivo | `back-selection.ts`, `card-export.ts` e PDF engine | Nenhuma troca de original nem mudança do modelo físico | Mesmos serviços M1/M4 | `back-selection`, `card-export`, `duplex-export` |
| Project save/load | `ProjectRepository` e serializer | Persiste resultado canônico, sem modal, blob, preview ou URL temporária | Mesmo repository/serializer | `project-serializer`, `project-api` |

## Fluxos e semântica

### Abertura e contexto

“Selecionar arte” abre `ArtworkPickerDialog` sobre o compositor atual. O shell fica `inert` e `aria-hidden`, o diálogo recebe foco previsível, prende Tab, fecha com Escape ou botão explícito e devolve foco ao acionador. A ação do compositor preserva o `physicalCardIndex` global e os dados de cópia; não navega para outra página nem altera slot ou geometria.

O picker mantém somente estado de apresentação/rascunho: face, filtro, busca, ordenação, página e seleção ainda não confirmada. A seleção aplicada volta pelo endpoint de resolve para o reducer canônico. Reabrir o picker lê `WorkingCard`, `selectedArtworkByFace`, `manualBackArtwork` e `backMode` atuais.

### Front de carta simples

Usa o catálogo atual M3 para Todas, Scryfall, MPC Autofill e Meus uploads. A busca e ordenação são executadas sobre o array lógico completo antes da paginação. Filtros MPC avançados, atualização, revalidação e diagnósticos existentes continuam no picker. Seleção exige escopo explícito e aplica uma referência durável de candidate à face Front.

O ID enviado pelo cliente não autoriza a seleção por si só. Antes da mutação, a API resolve o candidate real e confere sua face com a face solicitada e, em carta identificada, seu `identityId` com `card.identity.id`. A UI filtrada não é uma fronteira de segurança. Upload é validado pela busca existente para a identidade e face alvo, que retorna o vínculo real antes de `selectArtwork`.

### Back de carta simples

Back simples tem fluxo semântico separado. Mostra opções configuradas de Project Default Back, Sem verso, assets da Back Library existente e MPC apenas quando o provider confirmou um documento `CARDBACK`. Não mostra Scryfall nem upload local como escolha genérica. Um upload destinado a cardback continua passando pela seção Back Library existente.

O endpoint antigo e a nova ação por escopo rejeitam uma nova seleção Scryfall/upload como verso genérico. Parser, serializer, `resolveEffectiveCardBack` e export continuam aceitando referência Scryfall simples legada; não há migração silenciosa.

O estado atual do picker vem de `WorkingCard.backMode`, `manualBackAsset` e `manualBackArtwork`, e permanece visível após aplicar, fechar e reabrir. Esse estado atual é separado da escolha pendente: o primeiro continua mostrando o verso persistido até a confirmação, enquanto “Nova escolha” mostra o rascunho. `aria-current`, `aria-pressed` e o rótulo “Atual” expõem esses estados sem depender de cor. Um asset retired que já está referenciado continua mostrado como atual, mas permanece indisponível para novas escolhas.

### DFC

Front e Back selecionam `selectedArtworkByFace.front` e `.back` da mesma `CardIdentity`. O picker mostra “Carta dupla-face” e os nomes reais das faces. Ambas as faces consultam o catálogo de identidade para Scryfall, MPC e uploads compatíveis. Não renderiza ações genéricas de verso.

A política compartilhada valida o candidate real nos dois caminhos da API (`select` legado e `apply-artwork-scope` M6). Candidate da Front não pode ser reetiquetado como Back, mesmo para a mesma DFC; candidate de outra identidade também é rejeitado antes de chamar `selectArtwork`. Para cartas sem identidade, upload usa a busca do catálogo custom M1 e candidates MPC de referência precisam corresponder à referência e face persistidas. Upload associado a identidade resolve o candidate pelo catálogo daquela identidade/face antes da seleção.

`applyGenericBackScope` rejeita um alvo DFC e exclui DFCs de operações de projeto. A API também faz o guard antes de buscar candidato. Testes chamam domínio e API diretamente e comparam a arte Back real preservada.

## Escopos e split físico

`core/cards/artwork-selection-scope.ts` implementa operações puras reutilizáveis e testáveis:

- `entry`: altera a entrada Working Card (e suas cópias agrupadas).
- `physical-copy`: exige o índice global e confirma que esse índice pertence ao Working Card recebido.
- `same-identity`: compara `identity.provider + identity.id` e a face; nunca agrupa apenas por nome.
- Back simples também oferece `all-simple-project`, que pula e informa DFCs preservadas.

Para uma quantidade agrupada, o índice físico é convertido em offset dentro da entrada. Se uma cópia no meio precisar mudar, a entrada vira prefixo, uma cópia selecionada e sufixo. Só a cópia selecionada recebe a mudança. Os fragmentos mantêm todos os campos semânticos da origem; novos IDs são determinísticos e a normalização de `order` conserva a sequência expandida.

Exemplo: `Island ×4`, cópia física 3 (`physicalCardIndex=2`) muda de A para B. O resultado é `Island ×2/A`, `Island ×1/B`, `Island ×1/A`; a sequência expandida continua A, A, B, A. A mesma operação é usada para Back físico. Testes validam sequência, quantidades, metadata, identidade, faces e Back Library.

Antes de bulk back, a interface mostra a contagem física simples e quantas DFCs serão preservadas. O escopo all-simple inclui apenas entradas simples; a regra também está no domínio e na API.

## Catálogo, qualidade e desempenho

- O catálogo é o resultado completo do serviço atual. A UI monta até 60 cards por página e oferece anterior/próxima e salto direto por número.
- Busca, filtro provider e ranking são aplicados ao conjunto carregado antes de selecionar a página. “Maior DPI” usa DPI efetivo e, na ausência dele, o DPI informado; “Mais recente” usa release/data disponível; recomendado conserva a ordem ranqueada pelo catálogo; “Ordem original do provider” usa `providerRank` quando fornecido e preserva a ordem original dos demais grupos.
- Preview usa `previewUri` com `loading="lazy"`. O DOM do picker nunca precisa montar mais de 60 cards simultaneamente.
- O picker não enumera nem baixa originals para compor o catálogo. A hidratação existente prioriza a página visível, usa concorrência limitada (3), cache e geração/cancelamento. Respostas antigas não atualizam a requisição atual.
- Quando metadata existe, o card expõe provider, face, set/collector, idioma, dimensão, DPI/origem/qualidade, release, formato, tamanho, full-art/tags, disponibilidade/cache de original e validação de imagem/provider. Os estados de provider continuam visíveis e falha de um provider não apaga resultado/seleção dos outros.

## Preview, original, persistence e history

Preview só é usado em UI. O estado selecionado contém candidate ID, source, identidade/face e IDs estáveis do provider. Quando existe original, o fluxo de seleção chama `prepare`, que usa o storage existente para obter/validar o original; não converte SVG, substitui bytes por thumbnail ou persiste blob, `object URL` ou path. O export continua recebendo a referência durável e resolvendo o original validado no pipeline M4.

O resultado de aplicação substitui o Working Set pelo retorno da API em uma única edição de history. Serializer mantém split/order, seleções por face, DFC, Back Library e metadata durável. O estado do diálogo é local e não entra no snapshot. A compatibilidade de verso Scryfall simples legado continua coberta por parser, serializer, seleção efetiva e export.

## Evidências

### Correção da revisão independente

- `validateArtworkCandidateForCard` concentra a regra candidate → WorkingCard/face; a API chama a mesma função compartilhada antes da mutação em `select` legado e `apply-artwork-scope` M6.
- O candidate deve corresponder ao ID requisitado e à face exata. Para identidade resolvida, seu `identityId` precisa ser idêntico a `card.identity.id`. Candidate com `identityId: null` só é aceito em target sem identidade; candidates upload são primeiro resolvidos pela busca do catálogo da identidade/face ou do catálogo custom M1. Uma identidade resolvida nunca recebe candidate desvinculado nem candidate de outra identidade.
- Testes de API provam rejeição sem chamar `selectArtwork` para identidade diferente, DFC Front em Back e identidade diferente em Back. Scryfall/MPC válidos, upload realmente associado à identidade e upload custom M1 continuam aceitos.
- O picker mostra o verso canônico derivado do `WorkingCard`: `none`, `project-default`, `manual + manualBackAsset` e `manual + manualBackArtwork`. Estado atual e pendência recebem semântica e texto separados; testes aplicam, fecham e reabrem para Sem verso, Project Default, Back Library e MPC.
- Essa checagem acontece no endpoint/domínio, não depende dos filtros ou cards renderizados no picker.

Rodada focada executada nesta correção, cobrindo catálogo/quality/back library, Workbench/reducer/history, compositor M5, APIs, persistência/export, regras M1/M3 e os testes novos de M6:

```text
npm test -- --run tests/app/card-api.test.ts tests/core/cards/artwork-selection-scope.test.ts tests/app/artwork-picker-context.interaction.test.tsx tests/app/artwork-picker-dialog.test.tsx tests/app/workspace-card-selection.interaction.test.tsx tests/core/cards/working-card-editor-ui.test.tsx tests/persistence/project-serializer.test.ts tests/app/artwork-catalog-flow.integration.test.tsx tests/app/artwork-quality-hydration.test.ts tests/app/back-library-controls.test.tsx tests/app/canonical-compositor.interaction.test.tsx tests/services/project-api.test.ts tests/services/card-export.test.ts tests/core/cards/back-selection.test.ts tests/artwork/catalog.test.ts tests/artwork/mpc-provider-advanced.test.ts tests/artwork/providers.test.ts
17 test files passed · 275 tests passed

npm run typecheck
passed
```

Gates completos executados sobre o delta corretivo antes do commit:

```text
npm test
116 test files passed · 1 skipped
1279 tests passed · 1 skipped

npm run typecheck
passed

npm run build
passed · Next.js 16.3.6 / Turbopack

git diff --check
passed
```

O build regenerou `next-env.d.ts`; o conteúdo local conhecido foi restaurado byte a byte e permaneceu fora dos commits. A suíte/build também regeneraram PDFs/manifests de referência; esses artefatos foram restaurados ao conteúdo do baseline. Os gates completos acima foram executados no delta corretivo antes do commit; o mesmo conjunto é repetido sobre o estado commitado.
