# TCGPrint — Mudanças planejadas

Documento vivo para registrar, com nível de especificação de implementação, as mudanças discutidas diretamente durante a revisão do produto.

## Regra geral para execução

Estas mudanças devem ser implementadas de forma incremental e conservadora. O executor deve primeiro inspecionar o fluxo atual e identificar consumidores, testes e invariantes antes de alterar código. Não usar estas tarefas como oportunidade para refatorações amplas ou para substituir partes já estabilizadas do pipeline.

Princípios obrigatórios:

- preservar a geometria física canônica do compositor;
- preservar exportação PDF, SVG/DXF, bleed, trim, cut paths, registration, calibration, duplex e ordenação física;
- preservar identidade das instâncias físicas e cópias;
- não alterar seleção de artwork, back policy ou conteúdo de exportação por efeito colateral de uma mudança puramente visual;
- preferir o menor diff arquiteturalmente correto;
- qualquer nova camada de visualização deve consumir as fontes canônicas existentes em vez de duplicar regras de resolução;
- mudanças de UI devem manter acessibilidade por teclado, estados ARIA pertinentes e comportamento responsivo;
- nenhuma regressão deve ser “corrigida” removendo teste legítimo; atualizar testes apenas quando o requisito realmente mudou;
- antes de considerar uma mudança concluída, executar os testes direcionados, typecheck e build pertinentes.

---

## PDF Viewer / Compositor live

### 1. Remover os controles manuais redundantes de zoom/ajuste

**Status:** especificado, ainda não implementado.

#### Objetivo

Simplificar a toolbar do PDF Viewer / Compositor live removendo o bloco de controles manuais de enquadramento/zoom:

- `Fit Page`
- `Fit Width`
- `100%`
- botão `-`
- botão `+`

A remoção é de **exposição na interface**, não uma autorização para apagar indiscriminadamente a infraestrutura interna de cálculo de escala.

#### Estado técnico atual observado

O bloco está implementado em `src/app/registration-layout-preview.tsx` como `.compositor-zoom-controls`, usando `zoomMode`, `changeZoom(...)` e `stepZoom(...)`. O tamanho visual da folha continua dependendo de `zoomScale` e de `COMPOSITOR_CSS_PX_PER_MM`.

#### Direção de implementação

- Remover somente o bloco visível `.compositor-zoom-controls`.
- Manter internamente o cálculo de escala necessário para o compositor caber corretamente no viewport.
- O compositor deve continuar com enquadramento responsivo automático; a retirada da toolbar não pode fazer a folha voltar a tamanho arbitrário, transbordar ou ficar minúscula.
- Se `zoomMode`, `calculateCompositorScale` ou helpers relacionados ainda forem necessários para o auto-fit, eles devem permanecer.
- Somente remover estado/helper morto depois de provar, por busca de consumidores e testes, que não há dependência remanescente.

#### Invariantes

Não alterar:

- Frente/Verso;
- navegação Anterior/Próxima e seletor de página;
- dimensões físicas da folha;
- posicionamento de slots;
- transformação de calibração;
- pareamento duplex;
- bleed, trim, cut paths, registration e reserved zones;
- seleção de carta;
- drag/reorder;
- exportação.

#### Critérios de aceite

- os cinco controles deixam de existir na toolbar;
- a folha continua sendo dimensionada automaticamente e continua totalmente utilizável;
- resize do viewport continua recalculando o enquadramento quando necessário;
- nenhum teste de geometria/exportação é alterado apenas para acomodar esta remoção;
- testes específicos de zoom devem ser revisados: remover somente as expectativas de controles manuais e manter cobertura da escala automática.

---

### 2. Reprojetar a experiência visual do compositor: alta fidelidade, multi-seleção e inspeção de frente/verso por carta

**Status:** especificado, ainda não implementado.

#### Objetivo de produto

O compositor atual deve evoluir de uma prévia funcional porém visualmente pobre para um compositor de alta fidelidade e interação direta.

As referências visuais fornecidas pelo produto estabelecem o alvo de UX:

- cartas grandes e nítidas, com texto e detalhes legíveis;
- seleção evidente diretamente sobre cada carta;
- possibilidade de selecionar várias cartas sem perder a noção de qual carta está ativa;
- ação rápida por carta para inspecionar a outra face/back;
- barra contextual de seleção;
- viewport de trabalho mais próximo de um editor visual profissional;
- menos chrome de interface e mais área útil para as cartas.

A aproximação visual deve ser máxima **sem substituir a semântica física específica do TCGPrint**. O compositor continua representando uma folha física real, e não uma grade genérica de deck.

#### Problema técnico confirmado: perda de qualidade no viewer

A baixa qualidade não é apenas impressão subjetiva. A implementação atual usa, dentro do SVG do compositor, um `<image>` cujo `href` aponta para:

`/api/cards/artworks/[candidateId]/preview`

e marca explicitamente:

`data-compositor-source="preview-thumbnail"`.

Os providers de artwork reduzem esses previews para aproximadamente **300 × 420 px**:

- `artwork/local-provider.ts`: `sharp(...).resize({ width: 300, height: 420, ... })`;
- `artwork/scryfall-provider.ts`: também reduz para `300 × 420`.

No Scryfall, a própria escolha de `previewUri` prioriza `small` antes de `normal/large/png`.

Portanto, o compositor está ampliando um thumbnail de catálogo para representar uma carta que pode ocupar centenas de CSS pixels. Em telas com device pixel ratio > 1, ou quando a carta ocupa uma área maior, esse caminho inevitavelmente produz blur e perda de legibilidade.

Isso deve ser corrigido na fonte; filtros CSS, sharpening visual ou simplesmente aumentar o SVG não são solução aceitável.

#### 2.1. Fonte de imagem de alta fidelidade específica para o compositor

Criar um caminho de imagem próprio para o compositor, separado do thumbnail de catálogo.

Direção preferida:

- manter o endpoint/thumbnail atual para galerias onde 300 × 420 é adequado;
- introduzir um **compositor display asset** de resolução superior, ou um modo explicitamente dedicado no endpoint, sem fazer todas as thumbnails do sistema ficarem pesadas;
- servir uma derivação de alta qualidade baseada na melhor fonte disponível;
- quando o original validado já estiver localmente disponível, gerar a derivação a partir dele;
- quando houver somente fonte remota de provider, não escolher deliberadamente a variante `small` para o compositor se uma variante melhor estiver disponível;
- nunca trocar o asset canônico selecionado; isso é somente a representação visual dele.

Requisito de resolução:

- a imagem servida deve ter densidade suficiente para o tamanho efetivo exibido;
- mirar no mínimo ~2 pixels de imagem por CSS pixel quando razoável;
- usar buckets limitados de resolução para cache, por exemplo 512 / 768 / 1024 / 1280 px de largura, em vez de criar uma variante diferente para cada pixel de viewport;
- não fazer upscale destrutivo do original além de sua resolução real apenas para atingir o bucket;
- preservar aspect ratio;
- evitar recompressão JPEG agressiva;
- manter o bleed visual derivado da mesma política canônica usada hoje, sem modificar o conteúdo do trim.

Performance:

- carregar alta resolução apenas para as cartas da página/viewport que realmente está sendo composta;
- reutilizar cache HTTP e cache local;
- coalescer/abortar requisições obsoletas quando o usuário troca de página/face rapidamente;
- não baixar originais gigantes de todas as páginas antecipadamente;
- não bloquear a primeira pintura da interface inteira por causa de uma carta lenta;
- o fallback de carregamento pode exibir temporariamente thumbnail, mas deve substituir pela versão nítida assim que pronta e nunca ficar permanentemente preso em baixa resolução quando uma fonte melhor existe.

Importante: qualidade visual e qualidade de exportação são preocupações separadas. A mudança do viewer não pode alterar hashing, seleção de artwork, validação de original, DPI de exportação ou bytes usados pelo PDF final.

#### 2.2. Preservar o compositor como folha física canônica

Mesmo aproximando a UX das referências, não transformar o TCGPrint em uma grade arbitrária.

Devem continuar verdadeiros:

- posições vêm de `placement.gridSlots`;
- dimensões continuam em milímetros;
- A4/outros formatos continuam com proporções reais;
- margins, bleed, trim, registration e cut overlays continuam alinhados à mesma geometria;
- back page continua respeitando o pareamento duplex e `pagePair`;
- calibration continua sendo aplicada ao conteúdo impresso conforme o modelo atual;
- ordem física continua derivada de `physicalOrder`.

A melhoria visual deve acontecer **sobre** essa geometria, não em substituição a ela.

#### 2.3. Multi-seleção por instância física

Hoje o contrato principal usa uma única seleção:

- `selectedPhysicalInstanceId?: string | null`;
- `onSelectPhysicalInstance(...)`.

Isso é insuficiente.

O novo modelo deve separar dois conceitos:

1. **active/focused instance** — uma única carta alvo para HUD, artwork picker e ações que hoje exigem um alvo único;
2. **selection set** — zero, uma ou várias instâncias físicas selecionadas.

O conjunto de seleção deve ser identificado por **physical instance ID estável**, nunca apenas por card ID. Isso é obrigatório porque várias cópias da mesma carta precisam poder ser selecionadas independentemente.

Direção de contrato:

- introduzir algo equivalente a `selectedPhysicalInstanceIds: readonly string[]` ou estrutura Set controlada no pai;
- manter uma `activePhysicalInstanceId` separada;
- a seleção deve sobreviver à troca de página e reorder enquanto a instância física ainda existir;
- quando uma instância for removida, seu ID deve ser podado da seleção;
- duplicar uma entrada não deve selecionar silenciosamente a cópia nova sem uma regra explícita.

Interação esperada, alinhada à referência:

- checkbox/controle de seleção no canto superior esquerdo de cada carta;
- clicar no checkbox alterna aquela instância no conjunto sem destruir as outras;
- clicar diretamente na carta pode torná-la ativa/focada;
- Ctrl/Cmd+click pode ser aceito como atalho para toggle, desde que não prejudique acessibilidade;
- não implementar Shift-range de forma improvisada; se for feito, deve seguir a ordem física canônica;
- carta selecionada deve ter outline visual claro;
- carta ativa dentro de uma multi-seleção deve ter estado distinguível daquelas apenas selecionadas.

#### 2.4. Barra contextual de seleção

Adicionar uma barra contextual/sticky semelhante à referência, preferencialmente na parte inferior do viewport do compositor.

Ela deve mostrar pelo menos:

- quantidade total de páginas;
- quantidade de cartas físicas selecionadas;
- ação `Selecionar tudo`;
- ação `Desmarcar`.

Semântica proposta:

- `Selecionar tudo` seleciona todas as instâncias físicas do working set, inclusive em outras páginas;
- `Desmarcar` limpa o conjunto;
- a barra aparece quando houver seleção ou permanece discretamente disponível conforme decisão visual final;
- por enquanto, ações destrutivas/bulk sobre várias cartas não devem ser inventadas. Primeiro estabelecer seleção múltipla correta. Ações atuais que dependem de um único alvo continuam vinculadas à instância ativa.

Isso evita quebrar o artwork picker, HUD e ações de quantidade enquanto prepara o compositor para operações em lote futuras.

#### 2.5. Inspeção rápida de Front/Back por carta

O compositor já possui Frente/Verso global da folha. Isso deve ser preservado.

Além disso, cada carta deve ganhar uma ação rápida visual, inspirada no ícone de flip das referências, para inspecionar a outra face daquela carta sem obrigar o usuário a trocar a folha inteira.

Regra fundamental: **flip local é inspeção, não edição do projeto**.

Ao acionar o flip local:

- alternar apenas a face visual daquela instância no compositor;
- não chamar silenciosamente `onFaceChange` global;
- não alterar `backMode`;
- não alterar `selectedArtworkByFace`;
- não alterar `manualBackArtwork`;
- não alterar `physicalOrder`;
- não alterar o conteúdo que será exportado;
- não modificar a geometria duplex da página;
- reutilizar a resolução canônica existente para saber qual back/face mostrar;
- se o verso não existir ou estiver bloqueado por policy, mostrar estado indisponível claro, não inventar um back.

Quando a folha está globalmente em Frente, o flip local pode mostrar o verso daquela carta apenas para inspeção; quando está globalmente em Verso, pode mostrar a frente. Esse estado deve ser efêmero de UI e preferencialmente keyed por instance ID.

A carta inspecionada localmente deve possuir indicação visual discreta de que a face exibida é uma inspeção e não necessariamente a face física global da folha.

#### 2.6. Direção visual

A referência visual deve influenciar o compositor nos seguintes pontos:

- viewport de trabalho mais dominante;
- fundo neutro/escuro ao redor da folha para aumentar contraste;
- carta ocupando a maior área útil permitida pelo layout físico;
- artwork nítida;
- overlays de interação sobre a carta sem deslocar a geometria;
- checkbox no topo esquerdo;
- flip/face action no topo direito;
- outline de seleção de alto contraste;
- hover/focus estados claros;
- barra contextual inferior;
- controles de página compactos;
- remover o seletor de Layers da superfície principal; a apresentação normal deve ter um conjunto de camadas definido pelo produto, sem exigir configuração manual do usuário;
- remover texto explicativo permanente que compete com a área do compositor; detalhes técnicos pertencem a Diagnostics/debug, não ao fluxo normal.

Porém:

- informações necessárias para debug/produção devem continuar disponíveis no código, testes ou área de Diagnostics apropriada, mas não precisam permanecer na superfície principal do compositor;
- não remover Frente/Verso global;
- não remover page navigation;
- não alterar cores dos overlays técnicos de maneira que os torne ambíguos;
- não deixar controles sobrepostos cobrirem conteúdo crítico da carta quando a carta estiver pequena.

#### 2.7. Acessibilidade

- cada checkbox precisa de label que identifique nome e número da cópia;
- flip local deve ser botão real ou controle com semântica equivalente, com `aria-label` e `aria-pressed` quando aplicável;
- seleção visual não pode depender somente de cor;
- foco por teclado deve ser claramente visível;
- barra contextual deve anunciar mudança de contagem sem gerar spam de live region;
- active instance e selection set devem ser distinguíveis também semanticamente.

#### 2.8. Riscos que o executor deve evitar

Não aceitar como solução:

- aumentar `width/height` do SVG mantendo thumbnail 300 × 420;
- aplicar `image-rendering`, blur/sharpen CSS ou filtros para mascarar fonte de baixa resolução;
- carregar o arquivo original completo de todas as cartas de todas as páginas de uma vez;
- substituir o compositor SVG por uma grade HTML que perde coordenadas físicas;
- acoplar multi-seleção ao ID lógico da carta em vez da instância física;
- transformar o flip local em alteração real de back selection;
- reutilizar estado global `previewSide` para flip individual;
- quebrar drag/reorder por colocar overlays HTML capturando todos os pointer events;
- quebrar os testes atuais de M7 e “resolver” removendo cobertura.

#### 2.9. Critérios de aceite funcionais

Qualidade:

- em uma folha A4 3 × 3, nomes/textos e detalhes da carta devem ficar visivelmente mais nítidos que no estado atual;
- em display DPR 2, a carta não pode depender exclusivamente de um asset 300 × 420 quando exibida próxima desse tamanho em CSS;
- o compositor deve usar a fonte de display de alta fidelidade, não o thumbnail de catálogo, quando disponível.

Multi-seleção:

- selecionar duas ou mais cópias simultaneamente;
- selecionar cópias diferentes da mesma carta independentemente;
- mudar de página e voltar sem perder a seleção;
- `Selecionar tudo` e `Desmarcar` funcionam;
- remover uma carta elimina IDs órfãos do selection set;
- ações single-target continuam operando apenas sobre a active instance.

Front/Back local:

- flip de uma carta não muda as demais;
- flip local não altera a face global da folha;
- flip local não persiste como alteração do projeto;
- estado indisponível de back é explícito;
- back/face mostrado corresponde às regras canônicas existentes.

Regressões:

- drag/reorder continua funcionando;
- artwork picker continua abrindo para a instância correta;
- HUD continua ligado à instância correta;
- Frente/Verso global continua correto;
- export PDF permanece byte/geometry-equivalent para o mesmo projeto, exceto onde já existam timestamps/metadados não determinísticos;
- SVG/DXF/cut/calibration não mudam.

#### 2.10. Verificação obrigatória

Antes de considerar concluído:

- testes direcionados de `registration-layout-preview`;
- testes de `canonical-compositor.interaction`;
- testes do workspace que cobrem instância física/seleção;
- novos testes de multi-seleção;
- novos testes de flip local;
- teste do endpoint/serviço de compositor display verificando dimensão/caching/fallback;
- `npm run typecheck`;
- `npm test` ou conjunto completo equivalente se o tempo permitir;
- `npm run build`;
- smoke visual manual com:
  - A4 portrait 3 × 3;
  - pelo menos duas cartas diferentes;
  - cópias repetidas da mesma carta;
  - uma carta com back disponível;
  - uma carta sem back;
  - troca Frente/Verso global;
  - multi-seleção entre páginas;
  - viewport comum e DPR alto.

---


### 3. Remover poluição técnica da superfície principal e tornar a própria carta o ponto de entrada para edição

**Status:** especificado, ainda não implementado.

#### Decisão de produto

O compositor não deve funcionar como um painel permanente de diagnóstico. A superfície principal deve ser orientada a **ver a folha e interagir diretamente com as cartas**.

A informação técnica atualmente espalhada acima e abaixo da folha cria ruído, reduz a área útil e duplica conhecimento que já existe no projeto, no workspace de configurações e em Diagnostics.

A regra de UX passa a ser:

> **a carta é o controle principal.** O usuário olha a folha, escolhe uma carta diretamente nela e abre o fluxo de seleção/edição correspondente. Informações técnicas que não são necessárias para essa decisão não ficam permanentemente visíveis.

#### 3.1. Elementos que devem sair da superfície principal

Remover da apresentação normal do `RegistrationLayoutPreview`:

1. **Cabeçalho informativo do compositor**
   - `Compositor live`;
   - `A4 portrait · Magic Standard ... capacidade ... página ...`;
   - `N cartas físicas · atualiza automaticamente`.

   O contexto de formato/papel continua existindo no estado do projeto e nas configurações; não precisa ocupar uma faixa permanente sobre a folha.

2. **Controle `Layers` e sua lista de filtros**
   - Artwork;
   - Bleed;
   - Trim;
   - Cut guides;
   - Silhouette / SVG-DXF;
   - Registration;
   - Reserved zones;
   - Margins;
   - Calibration.

   O usuário normal não deve precisar montar manualmente a representação correta da folha.

3. **Linha de contexto de face/geometria**
   - exemplos atuais como `Frente física · artwork da face selecionada · registration ...`;
   - `Verso físico · long-edge · grade duplex pareada ...`.

4. **Linha permanente de carta selecionada**
   - `Carta física N · Nome · cópia X/Y`;
   - botão `Selecionar arte`;
   - botão `...`.

   Essa faixa deixa de existir porque a interação deve acontecer sobre a própria carta.

5. **HUD/caixa permanente de ações da instância**, quando aberta a partir do `...`
   - não manter um segundo painel de comandos dentro do compositor;
   - ações de quantidade/remoção/configuração continuam existindo nos fluxos próprios do workspace e não devem ser apagadas do domínio.

6. **Texto permanente de calibração**
   - `Sem perfil de calibração selecionado; geometria nominal visível...`;
   - detalhes de offsets, rotação, skew e versões de perfil.

7. **Textos auxiliares no rodapé**
   - `Defina linhas e colunas antes de desativar slots.`;
   - explicação longa de duplex/back;
   - outros parágrafos explicativos equivalentes.

8. **Legenda técnica inferior**
   - Bleed;
   - Trim/card;
   - Cut path;
   - Skipped slot/path;
   - Reserved zone;
   - Registration mark.

A remoção é da **UI permanente do compositor**, não da capacidade interna correspondente.

#### 3.2. Estado visual padrão sem seletor de Layers

Eliminar o controle de Layers exige definir um estado correto e determinístico; não basta apagar o menu e deixar valores históricos arbitrários.

A visualização normal deve representar o resultado físico de forma limpa:

- **Artwork:** visível;
- **Bleed:** visível quando configurado, pois faz parte da aparência física preparada para impressão;
- **Calibration:** aplicada internamente quando houver perfil, porque a visualização deve refletir a composição efetiva, não uma geometria nominal enganosa;
- **Registration:** mostrar somente quando fizer parte efetiva da saída/configuração física do projeto;
- **Trim guide:** oculto na visualização normal;
- **Cut guide:** oculto na visualização normal;
- **Silhouette / SVG-DXF path:** oculto na visualização normal;
- **Reserved zones:** ocultas;
- **Margins:** ocultas.

Se algum desses overlays for necessário para suporte/diagnóstico, ele pode ser exposto futuramente em **Diagnostics/developer tooling**, mas não deve reaparecer como dropdown no viewer principal.

Importante: ocultar guide/overlay não pode remover sua geração, geometria ou exportação.

#### 3.3. Toolbar mínima

Após esta e as mudanças anteriores, a barra principal deve conter somente controles realmente necessários ao trabalho direto:

- **Frente / Verso** global;
- **Anterior / Página X de Y / Próxima**;
- seletor `Ir para` apenas quando houver mais de uma página, se continuar sendo útil e compacto.

Não reintroduzir zoom manual ou Layers.

A toolbar deve ser compacta e consumir o mínimo de altura possível.

#### 3.4. Clique direto na carta abre o fluxo de artwork existente

O botão textual `Selecionar arte` deixa de ser necessário.

Ao clicar normalmente no corpo de uma carta física:

1. tornar aquela instância a **active/focused instance**;
2. sincronizar o card lógico selecionado somente na medida necessária para o fluxo existente;
3. abrir diretamente o **`ArtworkPickerDialog` já existente** para a **instância física correta** e para a **face que está sendo exibida/inspecionada**;
4. fornecer ao picker o mesmo contexto que hoje é fornecido por `onSelectArtwork(...)`:
   - `cardId`;
   - `instanceId`;
   - `physicalCardIndex`;
   - side;
   - copyNumber;
   - totalCopies.

Não criar um segundo seletor de artwork. Reutilizar `openArtworkPicker(...)` e o pipeline atual de seleção por escopo.

#### 3.5. Compatibilidade entre clique, multi-seleção, flip e drag/reorder

A carta passará a concentrar várias interações. A implementação deve separar os alvos para não criar eventos concorrentes:

- **checkbox no canto superior esquerdo:** somente adiciona/remove a instância do multi-selection set; não abre picker;
- **botão de flip no canto superior direito:** somente alterna inspeção local Front/Back; não abre picker;
- **clique no corpo da carta:** abre o artwork picker;
- **drag:** continua reordenando instâncias físicas e não deve abrir o picker ao terminar um arrasto;
- **teclado:** Enter/Space sobre o corpo interativo deve oferecer caminho equivalente de abertura sem interferir nos controles filhos.

É obrigatório implementar proteção contra `click-after-drag` — por exemplo, estado explícito de drag ou limiar de movimento — para que soltar uma carta depois de reordená-la não abra o picker acidentalmente.

Os controles sobrepostos devem usar `stopPropagation`/tratamento de eventos equivalente apenas onde necessário; não criar um overlay gigante que bloqueie o drag e os eventos do SVG.

#### 3.6. O que acontece com as ações do antigo `...`

As capacidades de domínio não devem ser deletadas:

- aumentar quantidade;
- remover uma cópia;
- duplicar como entrada independente;
- remover carta inteira;
- configurações completas;
- mover antes/depois.

Porém elas **não precisam permanecer como HUD permanente no viewer**.

Direção desta mudança:

- remover o gatilho visual `...` e `.compositor-instance-hud` da superfície principal;
- manter as funções/reducers e os fluxos equivalentes onde já existem no workspace de Cartas/configurações;
- não apagar handlers/reducers apenas porque o botão do viewer sumiu sem antes confirmar todos os consumidores;
- se alguma ação ficar sem qualquer caminho acessível após a remoção, o executor deve reportar a lacuna e preservar um caminho compacto temporário em vez de simplesmente eliminar funcionalidade.

Não inventar neste momento um novo menu contextual complexo. O objetivo é simplificar.

#### 3.7. Informações técnicas continuam existindo, apenas mudam de lugar

A limpeza visual não autoriza remover:

- `settings.registration`;
- `printerProfileSelection`;
- matrizes de calibration;
- `duplexFlipMode`;
- cut geometry;
- bleed configuration;
- skipped slots;
- reserved zones;
- SVG/DXF geometry;
- dados usados por testes e exportação.

Esses dados continuam no modelo e no pipeline. Quando precisarem ser inspecionados pelo usuário avançado, o local apropriado é a área já existente de **Diagnostics/configurações**, não texto permanente em volta da folha.

#### 3.8. Critérios de aceite visual

No estado normal, com uma página carregada:

- a maior parte da área disponível é dedicada à folha/cartas;
- não existe dropdown `Layers`;
- não existe legenda inferior de guias;
- não existem parágrafos de calibration/duplex/contexto técnico ao redor da folha;
- não existe linha `Carta física ... Selecionar arte ... ...`;
- não existe cabeçalho descritivo redundante do compositor;
- permanecem apenas os controles compactos de Frente/Verso e paginação;
- seleção, checkbox, flip e estados necessários aparecem diretamente sobre as cartas;
- clicar no corpo da carta abre o picker existente para a instância/face correta.

#### 3.9. Critérios de regressão

A simplificação da superfície não pode alterar o resultado de impressão.

Para o mesmo projeto antes/depois:

- número de páginas é igual;
- slot assignment é igual;
- posições em mm são iguais;
- ordem física é igual;
- resolução de front/back é igual;
- calibration efetiva é igual;
- bleed/trim/cut/registration continuam sendo produzidos conforme configuração;
- PDF final continua funcionalmente equivalente;
- SVG/DXF continuam equivalentes;
- mudança de aparência do compositor não pode serializar novos valores no projeto apenas para lembrar estado de UI removido.

#### 3.10. Testes mínimos adicionais

Além da bateria definida no item 2, cobrir:

- ausência do botão `Layers`;
- ausência dos textos/legenda removidos;
- presença de toolbar mínima;
- clique em uma instância abre o `ArtworkPickerDialog` com contexto físico correto;
- clicar checkbox não abre picker;
- clicar flip não abre picker;
- concluir drag/reorder não abre picker;
- troca de Frente/Verso global ainda funciona;
- overlays técnicos ocultos no viewer não deixam de existir no pipeline/export;
- `npm run typecheck`;
- testes direcionados;
- `npm run build`.

---

> Este arquivo deve continuar sendo atualizado conforme novas mudanças forem definidas. Nenhum item marcado como “especificado” deve ser tratado como implementado sem evidência de código e testes.
