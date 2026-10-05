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
- carta selecionada **não deve receber moldura roxa/colorida grossa**; o estado selecionado é comunicado pelo checkbox marcado;
- a active/focused instance deve ser distinguível de forma discreta e não intrusiva (por exemplo, foco semântico/controle ativo), sem pintar uma borda grossa sobre toda a carta.

#### 2.4. Barra contextual de seleção

Adicionar uma barra contextual/sticky semelhante à referência, preferencialmente na parte inferior do viewport do compositor.

A barra deve ser mínima e conter somente:

- ação `Selecionar tudo`;
- ação `Desmarcar`.

Não exibir:

- quantidade de páginas;
- quantidade de cartas selecionadas;
- texto de status redundante.

Semântica:

- `Selecionar tudo` seleciona todas as instâncias físicas do working set, inclusive em outras páginas;
- `Desmarcar` limpa o conjunto inteiro;
- a barra aparece somente quando houver pelo menos uma carta selecionada;
- ao zerar a seleção, a barra desaparece;
- por enquanto, ações destrutivas/bulk sobre várias cartas não devem ser inventadas. Ações single-target continuam vinculadas à active instance.

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
- checkbox no topo esquerdo, sobreposto à carta;
- flip/face action no topo direito, sobreposto à carta;
- seleção comunicada principalmente pelo checkbox sobre a carta, sem moldura colorida permanente ao redor da artwork;
- hover/focus estados claros nos controles sobrepostos;
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
- a barra contextual não exibe contagem de páginas nem contagem de seleção;
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

#### 3.4. Clique direto na carta abre o popup de artwork; seleção múltipla fica exclusivamente no checkbox

O botão textual `Selecionar arte` deixa de ser necessário.

A semântica deve ser inequívoca:

- **checkbox** = selecionar/desmarcar a instância no multi-selection set;
- **clique normal no corpo da carta** = abrir o `ArtworkPickerDialog`;
- clicar no corpo **não** adiciona/remove a carta da seleção múltipla.

Ao clicar normalmente no corpo de uma carta física:

1. definir aquela instância como **active/focused instance** apenas para o contexto da ação single-target;
2. **não** alterar `selectedPhysicalInstanceIds`;
3. sincronizar o card lógico selecionado somente na medida necessária para o fluxo existente;
4. abrir diretamente o **`ArtworkPickerDialog` já existente** para a **instância física correta** e para a **face que está sendo exibida/inspecionada**;
5. fornecer ao picker o mesmo contexto que hoje é fornecido por `onSelectArtwork(...)`:
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
- **clique no corpo da carta:** abre o artwork picker e não altera o multi-selection set;
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
- reordenação física por drag-and-drop.

Porém elas **não precisam permanecer como HUD permanente no viewer**.

Direção desta mudança:

- remover o gatilho visual `...` e `.compositor-instance-hud` da superfície principal;
- manter as funções/reducers e os fluxos equivalentes onde já existem no workspace de Cartas/configurações;
- não apagar handlers/reducers apenas porque o botão do viewer sumiu sem antes confirmar todos os consumidores;
- se alguma ação ficar sem qualquer caminho acessível após a remoção, o executor deve reportar a lacuna e preservar um caminho compacto temporário em vez de simplesmente eliminar funcionalidade.

Substituir esse HUD pelo menu contextual flutuante especificado no item 4. O objetivo continua sendo simplificar: o menu existe apenas sob demanda, ancorado à carta, sem reservar espaço permanente no layout.

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


### 4. Substituir o HUD expansível por menu contextual flutuante sobre a carta

**Status:** especificado, ainda não implementado.

#### Objetivo

As ações secundárias de uma instância física não devem aparecer em um painel horizontal acima da folha. Elas devem existir em um **menu contextual temporário**, visualmente associado à carta que originou a ação.

A referência visual fornecida estabelece o padrão de UX: clique secundário ou gatilho discreto sobre a carta abre uma pequena superfície flutuante com ações; o compositor não muda de tamanho e a folha não é empurrada.

#### Abertura

O mesmo menu deve poder ser aberto por:

- clique com botão direito sobre o corpo da carta (`contextmenu`);
- um botão `…`/kebab discreto sobre a própria carta para descoberta, teclado e dispositivos sem botão direito.

Ao abrir:

- prevenir o menu nativo do navegador somente quando o evento ocorrer sobre uma instância de carta válida;
- tornar essa instância a `activePhysicalInstanceId`;
- ancorar o menu ao ponto do clique ou ao retângulo visual da carta/gatilho;
- fechar qualquer outro menu contextual já aberto;
- operar sempre sobre `physicalInstanceId`, nunca apenas sobre `workingCardId`.

#### Posicionamento

O menu deve ser overlay/portal e **não participar do layout da folha**.

Requisitos:

- `position: fixed` ou estratégia equivalente com coordenadas de viewport;
- collision detection contra as bordas da viewport;
- preferir abertura à direita/abaixo quando houver espaço;
- inverter horizontal/verticalmente quando necessário;
- permanecer legível em viewport reduzido;
- `z-index` acima do SVG e dos overlays da carta, mas abaixo de diálogos modais como o Artwork Picker;
- fechar em scroll significativo do compositor, resize, troca de página, fechamento do picker ou quando a instância deixar de existir.

Não mover, redimensionar ou recalcular a geometria física da carta para acomodar o menu.

#### Ações

Reutilizar os handlers e reducers existentes sempre que possível. O menu deve conter apenas ações que tenham semântica válida no TCGPrint:

- **Selecionar/Trocar artwork** — abre o Artwork Picker da instância/face correta;
- **Configurar verso / face** — abre o fluxo canônico de back/face;
- **Aumentar quantidade**;
- **Remover uma cópia**;
- **Duplicar como entrada independente**;
- **Configurações completas**;
- **Remover carta inteira** como ação destrutiva visualmente separada.

Não incluir `Mover antes` / `Mover depois` no menu contextual. Reordenação passa a ser uma interação direta por drag-and-drop no compositor.

Não copiar ações da referência que não pertencem ao domínio do TCGPrint, como `Set as Cover`, `Edit Tags` ou rotação arbitrária, sem requisito próprio.

`Desativar slot` só deve aparecer se a feature continuar suportada e o slot atual for elegível; não expor comando desabilitado sem necessidade.

#### Convivência com outras interações

- clique esquerdo no corpo: abre Artwork Picker;
- checkbox: altera multi-seleção e nunca abre menu/picker;
- flip local: alterna inspeção e nunca abre menu/picker;
- clique direito: abre menu e não inicia drag;
- início de drag: fecha menu;
- conclusão de drag: não abre menu nem picker;
- Escape: fecha menu e devolve foco ao gatilho/carta;
- clique fora: fecha menu.

#### Acessibilidade

- gatilho `…` é um `button` real com `aria-haspopup="menu"` e `aria-expanded`;
- menu com semântica `role="menu"` ou padrão acessível equivalente;
- navegação por teclado previsível;
- ação destrutiva identificável também sem depender de cor;
- foco restaurado ao elemento originador quando o menu fecha.

#### Regressões proibidas

A troca do HUD por menu contextual não pode alterar:

- reducers de quantidade/remoção/duplicação;
- identidade da instância física;
- physical order;
- artwork/back selecionados;
- undo/redo das operações editoriais;
- exportação.

---

## Artwork Picker

### 5. Redesenhar o Artwork Picker para seleção visual direta e pipeline automático

**Status:** especificado, ainda não implementado.

#### Decisão de produto

O Artwork Picker deve parecer uma **galeria de artes**, não um painel administrativo de metadados.

O fluxo normal deve ser:

1. abrir o picker;
2. o catálogo adequado começa a carregar automaticamente;
3. ver artes em uma grade limpa;
4. opcionalmente filtrar;
5. clicar na arte desejada;
6. o TCGPrint faz revalidação/preparo/download/validação necessários internamente;
7. a escolha é aplicada;
8. mostrar feedback curto de sucesso.

O usuário não deve executar manualmente etapas internas do pipeline para conseguir selecionar uma arte.

#### Estado técnico atual confirmado

Hoje `src/app/artwork-candidate-grid.tsx` expõe em cada card:

- provider e face;
- set/collector;
- idioma;
- source MPC;
- formato;
- tamanho do arquivo;
- dimensões;
- DPI efetivo e status;
- release;
- full-art;
- disponibilidade/cache do original;
- tags;
- estado de metadata MPC;
- estado da imagem;
- freshness;
- hints de disponibilidade local;
- botão `Revalidar metadata`;
- botão cuja label pode virar `Validar original e calcular DPI`.

Também existe em `card-identity-workbench.tsx` o botão `Atualizar resultados MPC`.

Essa UI expõe detalhes de implementação que devem permanecer no domínio/Diagnostics, mas não no caminho principal de seleção.

Há infraestrutura existente que deve ser aproveitada:

- `ArtworkQualityHydrator` já prepara automaticamente candidatos visíveis do Scryfall com concorrência limitada;
- `confirmArtworkSelection()` já chama `/api/cards/artworks/[candidateId]/prepare` antes de aplicar um candidato com original disponível;
- o catálogo já é carregado automaticamente quando `artworkRequest` muda;
- `forceMpcRefresh`, `refreshMpcMetadata` e o endpoint `/refresh` existem e podem continuar sendo usados internamente.

Portanto, a implementação deve **automatizar e esconder** essas etapas, não simplesmente removê-las.

### 5.1. Layout visual

Adotar a direção das referências:

- modal amplo, com boa hierarquia;
- preview/contexto da carta atual em uma coluna lateral quando houver espaço;
- região central dominada pela grade de artworks;
- filtros em uma barra compacta acima da grade;
- sem grandes blocos de texto técnico;
- sem cards estreitos cheios de parágrafos;
- scroll da galeria independente e estável;
- responsivo: em larguras menores, preview lateral pode recolher/empilhar sem comprometer a grade.

A inspiração é a densidade e clareza das referências, não uma cópia literal de outro produto.

### 5.2. Providers no Front

Para seleção de **Front artwork** de uma carta com identidade resolvida, a navegação principal deve oferecer somente:

- **Scryfall**;
- **MPC Autofill**.

Remover da superfície principal de Front:

- `Todas`;
- `Meus uploads`.

Motivo:

- misturar providers em `Todas` torna ordenação/filtros/estado confusos;
- upload próprio não é provider primário para escolher uma impressão/artwork de uma carta identificada.

Uploads **não devem ser apagados do sistema**. Eles continuam válidos em fluxos nos quais imagens próprias realmente fazem sentido, especialmente Back Library/versos customizados e importações diretas.

Para casos custom sem CardIdentity, o executor deve preservar um caminho funcional de imagem local; a regra acima é específica do picker normal de Front para carta identificada.

### 5.3. Provider inicial

Ao abrir Front picker:

- abrir no último provider usado para Front na sessão, se válido;
- caso contrário, default **Scryfall**;
- nunca default `all`.

Ao trocar para MPC Autofill:

- iniciar automaticamente a consulta do catálogo;
- não exigir clique em `Atualizar resultados MPC`.

### 5.4. Remover informação excessiva dos cards

No estado normal, cada resultado deve mostrar essencialmente:

- imagem da carta/artwork;
- badge compacto de DPI/resolução no canto superior;
- estado visual de hover/foco/selecionado.

Opcionalmente pode haver uma linha curta de identificação somente quando necessária para distinguir versões visualmente similares, mas o card não deve voltar a virar um relatório técnico.

Remover da superfície do card:

- `Resultado #N`;
- texto `Provider: ... · Face: ...`;
- formato;
- KB;
- dimensões em texto;
- `DPI efetivo · verificado ...` em parágrafo;
- `Original disponível/cache local`;
- metadata freshness;
- image status;
- tags em bloco;
- release/full-art como texto permanente;
- status interno de XML/cache.

Esses dados podem continuar:

- no modelo;
- em filtros;
- em ordenação;
- em tooltip/popover de detalhes opcional;
- em Diagnostics;
- em testes.

Não devem ocupar a galeria normal.

### 5.5. Semântica do badge de DPI

O badge visual pode ser suficiente, mas não pode mentir sobre a origem do número.

Regra:

- se houver `effectiveDpi` verificado, exibir esse valor;
- se ainda houver apenas DPI informado pelo MPC, o badge pode exibir o valor reportado pelo provider, mantendo internamente a distinção `provider-reported`;
- diferença entre provider-reported e verified pode ser indicada de forma discreta por tooltip/ícone, não por parágrafos;
- após `prepare`, atualizar para o DPI efetivo;
- se o original validado contradisser gravemente o DPI informado, a seleção deve respeitar as regras de qualidade existentes e apresentar erro/aviso necessário.

Nunca remover a validação real só para manter a UI simples.

### 5.6. Remover ações técnicas manuais

Remover da UI normal:

- `Revalidar metadata`;
- `Validar original e calcular DPI`;
- `Atualizar resultados MPC`.

Essas operações tornam-se responsabilidade do sistema.

#### MPC catalog refresh automático

O MPC não deve fazer um `force refresh` agressivo a cada render ou abertura de modal.

Implementar comportamento equivalente a **cache-first / stale-while-revalidate**:

- se houver catálogo/cache válido, renderizar imediatamente;
- se a entrada estiver stale, incompleta ou exigir consulta atual, disparar refresh em background;
- deduplicar por identity/face/filtros/request key;
- aplicar cooldown/TTL do provider para evitar tempestade de requests;
- alterações de filtros disparam nova consulta automaticamente, com debounce quando houver texto;
- requisições antigas devem ser ignoradas/abortadas quando o contexto muda;
- se MPC estiver offline, usar cache disponível e mostrar apenas um status curto não bloqueante.

`forceMpcRefresh` pode permanecer internamente como mecanismo, mas não deve depender de botão manual para o fluxo comum funcionar.

#### Revalidação de metadata MPC

Não revalidar individualmente **todos os resultados do catálogo** antes de mostrá-los.

Estratégia:

- carregar metadata suficiente para montar a galeria;
- revalidar em background apenas quando a metadata estiver stale e houver benefício, com fila limitada; e/ou
- revalidar obrigatoriamente o candidato escolhido antes de confirmar se o contrato MPC exigir freshness.

Isso preserva desempenho e evita centenas de requests desnecessários.

### 5.7. Originais: carregar tudo visualmente não significa baixar todos os arquivos de impressão

Ao abrir o picker, o usuário deve ver a galeria carregando automaticamente, mas o sistema **não deve baixar os originais de alta resolução de todos os resultados**.

Separar:

- **catalog/preview:** automático para todos os resultados necessários à viewport/paginação;
- **validated original:** preparado sob demanda, principalmente para a arte escolhida e, quando apropriado, para candidatos visíveis em hidratação limitada.

Ao selecionar uma arte:

1. se metadata MPC precisar de refresh, revalidar;
2. resolver candidato canônico atualizado;
3. se houver original disponível, executar `prepare` automaticamente;
4. validar bytes/formato/dimensões/hash conforme pipeline atual;
5. calcular `effectiveDpi`;
6. aplicar a seleção no escopo correto;
7. atualizar cache/catalog state;
8. mostrar feedback de sucesso.

Se qualquer etapa obrigatória falhar, **não persistir uma seleção parcialmente validada**.

### 5.8. Seleção por clique, sem etapa técnica intermediária

Para Front artwork no fluxo aberto a partir de uma instância física:

- clicar no card da artwork é a ação de seleção;
- não exigir primeiro `Selecionar arte` dentro do card;
- não exigir depois `Validar original`;
- não exigir um segundo botão `Aplicar seleção` para o caso padrão.

Default:

- picker aberto a partir do compositor aplica somente à **physical instance** que originou o picker;
- picker aberto por contexto de entrada aplica à entrada conforme semântica atual.

Para preservar operações em lote, substituir o bloco grande de radios `Aplicar para` por um controle compacto opcional, inspirado na referência, por exemplo:

- checkbox/toggle `Aplicar a todas as cópias desta carta`.

Esse toggle deve mapear para o escopo canônico existente (`same-identity`) e nunca inferir escopo em silêncio.

Para Back Library/ações destrutivas/semânticas de verso que exijam decisão adicional, confirmação explícita pode continuar existindo. A regra de aplicação imediata é especialmente para a escolha comum de artwork.

### 5.9. Feedback

Durante clique em uma artwork:

- marcar aquele card como pending;
- bloquear cliques duplicados no mesmo candidato;
- não congelar a galeria inteira se não for necessário;
- mostrar spinner/progresso curto sobre o card ou área de status;
- ao concluir, mostrar toast discreto como `Arte aplicada`;
- atualizar preview da carta/compositor imediatamente;
- manter picker aberto ou fechar conforme decisão visual final; preferência: manter aberto para permitir comparação/troca rápida, com estado selecionado evidente.

Falhas:

- erro curto e acionável;
- não despejar stack/provider diagnostics no card;
- manter seleção anterior intacta se a nova falhar.

### 5.10. Filtros compactos

O bloco atual de `Filtros avançados MPC` com múltiplos `select multiple` altos deve sair da superfície padrão.

Barra principal compacta, inspirada nas referências:

- botão de filtros;
- Set/Source quando aplicável;
- idioma;
- tag/category;
- modo de busca/fuzzy quando relevante;
- DPI mínimo/ordenação por DPI;
- ordenação.

Filtros de uso raro ficam em popover/drawer avançado aberto sob demanda.

Não renderizar listas gigantes expandidas dentro do fluxo principal.

### 5.11. Testes e invariantes

Cobrir obrigatoriamente:

- Front mostra somente Scryfall e MPC Autofill para carta identificada;
- não existe `Todas` nem `Meus uploads` nesse contexto;
- custom/local workflows continuam acessíveis onde necessários;
- abrir MPC dispara carregamento sem botão manual;
- cache existente aparece sem esperar refresh;
- refresh stale ocorre sem duplicar requests;
- offline usa cache quando disponível;
- selecionar MPC stale revalida antes de aplicar quando necessário;
- selecionar candidato com original chama `prepare` automaticamente;
- falha de prepare não troca a artwork persistida;
- badge usa effective DPI quando verificado;
- cards não exibem o bloco antigo de metadata;
- clique na artwork aplica no physical instance correto;
- toggle `aplicar a todas` mapeia para o escopo correto;
- seleção anterior permanece se nova seleção falhar;
- undo/redo continua correto;
- project serialization não recebe estado efêmero de UI;
- build/typecheck/testes direcionados passam.

---


### 6. Seleção visual minimalista: remover outline roxo e usar controles sobrepostos com revelação por hover

**Status:** especificado, ainda não implementado.

#### Problema atual confirmado

Em `src/app/registration-layout-preview.tsx`, a instância atualmente selecionada recebe um retângulo SVG:

- classe `.compositor-selection-outline`;
- `stroke="#7e22ce"`;
- `strokeWidth="2"`;
- cobrindo todo o trim da carta.

Esse outline roxo é visualmente pesado, compete com a artwork e não é necessário quando a seleção passa a ter um checkbox explícito.

#### Decisão de produto

Remover completamente a moldura roxa/colorida de seleção ao redor da carta.

O estado normal da carta deve preservar a artwork o máximo possível. Os únicos controles persistentes sobre a carta serão:

- **checkbox de seleção** no canto superior esquerdo;
- **flip/inspeção Front/Back** no canto superior direito.

Não adicionar uma nova borda grossa em outra cor como substituição.

#### 6.1. Checkbox de seleção

O checkbox deve:

- ser um controle real e acessível, não apenas um ícone decorativo;
- ficar visualmente sobreposto no canto superior esquerdo da carta, sem alterar o tamanho/posição física da carta;
- operar sobre `physicalInstanceId`;
- marcar/desmarcar somente aquela instância no selection set;
- não abrir Artwork Picker;
- não iniciar drag;
- não abrir menu contextual;
- usar `stopPropagation`/tratamento equivalente apenas para isolar essa ação.

Estado:

- não selecionado: quadrado discreto;
- selecionado: checkmark claramente visível;
- o checkmark, e não uma moldura em volta da carta, é a principal indicação de seleção.

#### 6.2. Controle de flip

O flip deve:

- ficar no canto superior direito;
- usar o estado efêmero de inspeção local definido no item 2.5;
- não alterar a face global da folha;
- não alterar o projeto/export;
- não abrir picker/menu;
- possuir label acessível indicando a ação, por exemplo `Ver verso de Forest · cópia 2`.

#### 6.3. Opacidade e comportamento de hover

Em desktop com ponteiro preciso:

**Estado idle — mouse fora da carta**

- checkbox desmarcado e botão de flip ficam visíveis, porém discretos;
- usar opacidade reduzida, suficiente para descoberta sem competir com a artwork;
- alvo clicável não deve encolher junto com a opacidade.

**Hover sobre a carta**

- checkbox e flip transitam para opacidade total;
- transição curta e suave, sem atraso perceptível;
- não alterar escala da carta;
- não adicionar overlay escuro sobre toda a artwork.

**Carta selecionada**

- checkbox marcado permanece em opacidade alta mesmo quando o mouse sai;
- o botão de flip pode voltar ao estado discreto quando não houver hover/focus;
- nenhuma moldura colorida deve aparecer ao redor da carta.

**Keyboard focus**

- o controle focado deve ficar em opacidade total;
- usar focus ring localizado no próprio controle;
- não usar o outline roxo antigo sobre a carta inteira.

#### 6.4. Touch e dispositivos sem hover

Não depender exclusivamente de `:hover`.

Para `(hover: none)` / touch:

- controles devem ficar permanentemente legíveis;
- podem usar opacidade intermediária/alta;
- primeiro toque no corpo da carta continua obedecendo ao fluxo definido para abrir artwork; não exigir “primeiro toque só para revelar controles”;
- hit targets devem ser adequados para toque e podem ultrapassar visualmente o pequeno ícone sem deslocar a carta.

#### 6.5. Estado ativo vs seleção múltipla

Separar novamente:

- **selected** = checkbox marcado e membro de `selectedPhysicalInstanceIds`;
- **active/focused** = instância que receberá ações single-target/picker/menu.

Não usar borda roxa para representar nenhum dos dois.

Se for necessário comunicar active/focused visualmente além do foco do controle:

- usar tratamento mínimo, por exemplo sombra neutra muito sutil ou pequeno indicador localizado;
- não usar stroke grosso sobre o perímetro da carta;
- nunca alterar pixels da artwork nem confundir active com selected.

#### 6.6. Relação com overlays físicos

A remoção da moldura roxa não deve interferir com:

- bleed;
- trim;
- cut geometry;
- registration;
- skipped slots;
- reserved zones;
- drag/drop feedback.

Estados de drag/drop podem continuar usando feedback temporário próprio, porque representam uma ação em andamento, não seleção persistente.

No viewer normal, conforme item 3, os overlays técnicos permanecem ocultos ou condicionais conforme definido.

#### 6.7. Critérios de aceite

- selecionar uma carta não desenha qualquer retângulo roxo/colorido grosso ao redor dela;
- checkbox marcado identifica claramente a seleção;
- várias cartas podem mostrar checkboxes marcados ao mesmo tempo;
- checkbox e flip aparecem discretos no idle;
- hover de uma carta torna seus controles claramente visíveis;
- mover o mouse para fora reduz novamente a presença dos controles não persistentes;
- checkbox de carta selecionada continua claramente marcado fora do hover;
- teclado revela/foca os controles corretamente;
- touch não depende de hover;
- clicar checkbox não abre picker;
- clicar flip não abre picker;
- clicar corpo continua seguindo o fluxo de artwork;
- drag/reorder continua funcional;
- exportação e geometria física não mudam.

#### 6.8. Remoção técnica esperada

O executor deve remover ou deixar de renderizar o bloco atual equivalente a:

`{isSelected && <rect className="compositor-selection-outline" ... stroke="#7e22ce" ... />}`

e revisar testes que afirmem a presença desse retângulo.

Não remover a semântica de seleção junto com o outline. A seleção passa a ser representada pelo novo selection set + checkbox.

---


### 7. Comportamento definitivo da multi-seleção no compositor

**Status:** especificado, ainda não implementado.

#### Regra de interação

A seleção de múltiplas cartas acontece **exclusivamente pelo checkbox sobreposto no canto superior esquerdo da carta**.

Não usar clique no corpo da carta como toggle de seleção. O corpo da carta é reservado para abrir imediatamente o popup `ArtworkPickerDialog` da instância/face correspondente.

Comportamento:

- clicar no checkbox desmarcado adiciona aquela `physicalInstanceId` ao selection set;
- clicar novamente remove aquela instância do selection set;
- selecionar uma nova carta pelo checkbox não limpa as seleções anteriores;
- cartas iguais em cópias diferentes continuam independentes;
- checkbox marcado permanece claramente visível mesmo sem hover;
- nenhuma moldura colorida é desenhada ao redor da carta.

#### Barra contextual inferior

Ao existir pelo menos uma carta selecionada, mostrar uma barra flutuante/sticky compacta na parte inferior do viewport do compositor.

A barra contém **somente**:

- `Selecionar tudo`;
- `Desmarcar`.

Não exibir na barra:

- quantidade de páginas;
- quantidade de cartas selecionadas;
- nome da carta;
- número da cópia;
- qualquer informação de diagnóstico ou status.

O objetivo é reduzir a barra ao mínimo necessário para operações globais de seleção.

#### Semântica das ações

**Selecionar tudo**

- seleciona todas as instâncias físicas do working set;
- inclui cartas em páginas não visíveis;
- usa `physicalInstanceId` estável;
- não altera active instance;
- não muda página atual;
- não abre picker;
- não altera ordem física.

**Desmarcar**

- limpa todo o selection set;
- não altera active instance;
- não altera página;
- não altera artwork/back;
- faz a barra desaparecer imediatamente após a seleção ficar vazia.

#### Posicionamento e aparência

- barra sobreposta ao viewport, sem empurrar a folha;
- centralizada horizontalmente ou posicionada de forma consistente no rodapé do compositor;
- altura pequena;
- aparência discreta;
- não cobrir permanentemente conteúdo crítico da última linha de cartas;
- respeitar safe spacing do viewport;
- permanecer acima da folha e abaixo de modais.

#### Acessibilidade

- ambos os controles são botões reais;
- labels explícitos;
- foco visível;
- seleção individual continua acessível pelo checkbox;
- a barra não precisa anunciar contagens porque elas não serão exibidas.

#### Critérios de aceite

- marcar um checkbox mantém seleções anteriores;
- vários checkboxes podem ficar marcados simultaneamente;
- nenhuma borda roxa/colorida aparece;
- a barra surge após a primeira seleção;
- a barra contém apenas `Selecionar tudo` e `Desmarcar`;
- `Selecionar tudo` marca todas as instâncias físicas do projeto;
- `Desmarcar` limpa todas;
- ao limpar tudo, a barra some;
- clicar no corpo da carta continua abrindo Artwork Picker e não marca/desmarca o checkbox;
- clicar no checkbox nunca abre Artwork Picker;
- seleção não altera exportação, ordem física ou conteúdo do projeto.

---


### 8. Separar explicitamente "seleção" de "abertura do Artwork Picker"

**Status:** especificado, ainda não implementado.

#### Estado atual do código

Hoje o `RegistrationLayoutPreview` trata o grupo SVG da carta como elemento selecionável. O handler de clique chama `activate()`, que para cartas físicas chama `selectInstance(physicalInstance)`.

Isso faz o clique no corpo da carta atuar como seleção/ativação visual, comportamento que deve ser substituído.

O componente já possui o callback `onSelectArtwork(...)`, e o pai já possui `openArtworkPicker(...)` + `ArtworkPickerDialog`. Portanto, não é necessário criar um novo popup: o correto é reutilizar esse fluxo existente diretamente a partir da carta.

#### Novo comportamento obrigatório

Para uma carta física renderizada no compositor:

**Clique no checkbox**
- adiciona/remove a `physicalInstanceId` de `selectedPhysicalInstanceIds`;
- não abre picker;
- não muda a artwork;
- não muda a face global;
- não chama o comportamento de clique do corpo.

**Clique normal no corpo da carta**
- não altera `selectedPhysicalInstanceIds`;
- define a instância como active/focused somente para contexto single-target;
- chama o fluxo de `onSelectArtwork(...)`;
- abre o `ArtworkPickerDialog` existente;
- passa:
  - `cardId`;
  - `instanceId`;
  - `physicalCardIndex`;
  - face efetivamente exibida;
  - `copyNumber`;
  - `totalCopies`;
  - opener/ref adequado para restauração de foco.

O popup deve abrir imediatamente, sem uma etapa intermediária de “selecionar carta”.

#### Popup

Não criar:

- painel inline;
- sidebar;
- nova tela;
- segundo artwork picker.

Reutilizar o `ArtworkPickerDialog` atual, que já funciona como modal/popup sobre o compositor.

A abertura deve preservar:

- foco acessível;
- restauração de foco ao fechar;
- bloqueio/inert do conteúdo atrás do modal conforme implementação existente;
- contexto exato da instância física.

#### Relação com active instance

`activePhysicalInstanceId` pode ser atualizado no clique do corpo porque ele representa o alvo single-target atual.

Isso **não** significa seleção múltipla.

Regra:

- active/focused = contexto para picker/menu/ação individual;
- selected = checkbox marcado.

Uma carta pode estar ativa sem estar selecionada.
Uma carta pode estar selecionada sem ser a carta ativa.

#### Teclado

Quando o corpo da carta tiver foco:

- `Enter` abre o Artwork Picker;
- `Space` pode abrir o picker se seguir o padrão de botão adotado;
- teclado no checkbox altera somente seleção;
- teclado no flip altera somente inspeção local;
- teclado no menu contextual abre somente o menu.

#### Testes obrigatórios

Adicionar/ajustar testes para provar:

- clique no corpo chama `onSelectArtwork`;
- clique no corpo não altera selection set;
- clique no checkbox altera selection set;
- checkbox não chama `onSelectArtwork`;
- contexto enviado ao picker corresponde à instância física clicada;
- face enviada ao picker corresponde à face efetivamente exibida;
- cópias da mesma carta abrem o picker com `instanceId`/copyNumber corretos;
- fechar o popup restaura foco corretamente;
- drag não dispara picker no drop;
- botão direito abre menu contextual, não picker.

---


### 9. Reordenação física direta por drag-and-drop, refletida no PDF final

**Status:** especificado, ainda não implementado.

#### Decisão de produto

Remover da experiência normal os botões `Mover antes` e `Mover depois`.

A reordenação deve acontecer **diretamente sobre a folha**:

- usuário pressiona e arrasta uma carta;
- a carta ganha estado visual de “levantada”;
- o compositor mostra claramente onde ela será inserida;
- ao soltar, a ordem física muda;
- o compositor recompõe imediatamente;
- o PDF/SVG/fluxos derivados usam a nova ordem.

Isto é edição real do projeto/working set, não transformação visual temporária.

#### Estado técnico atual confirmado

O projeto já possui a infraestrutura canônica correta:

- `RegistrationLayoutPreview` já emite `onReorderPhysicalInstance(instanceId, targetInstanceId, placement)`;
- o pai despacha `reorder-physical-instance`;
- `reorderWorkingCardPhysicalInstance(...)` delega a `movePhysicalInstance(...)`;
- o reducer altera `state.physicalOrder`;
- `reorder-physical-instance` é uma ação editorial e portanto participa de undo/redo;
- `exportRequestBody(...)` envia explicitamente `physicalOrder` para `/api/cards/export`.

Logo, o executor **não deve criar uma ordem visual paralela**. Deve melhorar a interação/feedback do drag existente e manter `physicalOrder` como fonte de verdade.

#### 9.1. Semântica do drop

Usar **reorder por inserção**, compatível com o modelo canônico já existente.

Ao arrastar a instância A para a posição da instância B:

- determinar se o cursor está na metade anterior ou posterior do alvo;
- emitir `placement: "before"` ou `"after"`;
- remover A de sua posição antiga;
- inserir A na posição escolhida;
- as demais cartas deslocam-se na sequência.

Isso produz uma ordem física determinística e funciona melhor que uma troca artificial de apenas dois slots quando há várias cartas/páginas.

Visualmente, para o usuário, a carta “vai para aquele lugar” e as demais se rearranjam.

#### 9.2. Aparência durante o drag

A experiência deve se aproximar da referência fornecida:

**Origem**
- ao iniciar drag, a carta original pode ficar discretamente atenuada;
- não desaparecer de forma que o usuário perca referência da origem;
- checkbox/flip/context menu não devem ser acionados pelo gesto de drag.

**Drag preview**
- exibir uma cópia visual da própria carta seguindo o ponteiro;
- leve elevação visual (sombra neutra/pequena escala) é aceitável;
- não usar moldura roxa;
- preservar proporção da carta;
- preview não altera o layout físico.

**Destino**
- mostrar indicador de inserção claro antes/depois do alvo;
- cartas podem deslocar/animar visualmente para comunicar a futura posição, desde que a animação seja somente visual até o drop;
- não usar overlays técnicos de trim/cut como feedback de reorder;
- destino inválido deve ser reconhecível sem poluir a folha.

**Drop**
- aplicar `physicalOrder` uma única vez;
- recompor a folha usando o estado canônico;
- remover imediatamente drag ghost/feedback;
- não abrir Artwork Picker após soltar.

#### 9.3. Não confundir drag com clique

Como o corpo da carta abre Artwork Picker, usar limiar explícito de movimento.

Exemplo de regra:

- pointer down inicia estado potencial;
- somente após deslocamento suficiente (ex.: 4–8 CSS px) considerar drag;
- se não ultrapassar o limiar, pointer up é clique e abre picker;
- se ultrapassar, pointer up finaliza reorder e **suprime o click** subsequente.

Não depender apenas do comportamento implícito do browser para evitar `click-after-drag`.

#### 9.4. Não confundir drag com checkbox, flip ou menu

O drag deve iniciar apenas a partir do corpo arrastável da carta.

Não iniciar drag ao pressionar:

- checkbox;
- botão de flip;
- botão `…`/menu;
- qualquer controle interativo sobreposto.

Esses controles devem impedir propagação de início de drag quando necessário.

Clique direito continua abrindo menu contextual e não inicia drag.

#### 9.5. Persistência e exportação

A mudança deve atualizar `physicalOrder.instances` no estado editorial.

Após o drop, a nova ordem deve alimentar:

- compositor Front;
- compositor Back/duplex;
- paginação;
- seleção por instância;
- export PDF;
- proof/final PDF;
- SVG/DXF/cut quando estes dependerem da ordem de slots físicos;
- autosave/Project persistence onde `physicalOrder` já for serializado;
- undo/redo.

É proibido implementar reorder apenas com:

- CSS `transform`;
- estado local do `RegistrationLayoutPreview`;
- uma lista visual que não chega a `physicalOrder`.

#### 9.6. Duplex

Reordenar uma instância física deve mover o **par físico da carta**, não apenas sua imagem de frente.

Depois do reorder:

- Front ocupa a nova posição;
- o verso correspondente continua pareado com essa mesma instância;
- long-edge/short-edge e transforms de duplex continuam corretos;
- a nova posição deve ser refletida no PDF de verso exatamente como determina o plano canônico.

Nunca reordenar Front e Back de forma independente.

#### 9.7. Entre páginas

Reordenação deve poder afetar cartas em páginas diferentes.

Direção:

- manter suporte existente de drag sobre controles de página para navegar durante um drag, ou implementar mecanismo equivalente;
- ao mudar de página durante drag, conservar `dragSourceId`;
- soltar na nova página altera a posição global em `physicalOrder`;
- paginação é consequência da ordem global, não uma propriedade fixa da carta.

Não criar um campo separado “page number” na carta apenas para suportar drag.

#### 9.8. Slots vazios, skipped e reserved

Respeitar as restrições atuais:

- skipped slot não recebe carta;
- reserved zone/slot não recebe carta;
- slot vazio intermediário que não representa posição legal não deve criar buraco arbitrário em `physicalOrder`;
- no final da sequência, um slot elegível pode representar drop para o fim quando a geometria permitir.

Se a UI indicar destino inválido, o drop não altera estado.

#### 9.9. Multi-seleção

Primeira implementação de reorder continua **single-drag**:

- arrastar uma carta move somente aquela `physicalInstanceId`;
- o fato de outras cartas estarem marcadas no checkbox não faz todas se moverem em grupo;
- não inventar group drag nesta etapa.

Isso evita semântica ambígua e mantém o modelo atual seguro.

#### 9.10. Remover controles redundantes de movimento

Remover da UI principal e do menu contextual:

- `Mover antes`;
- `Mover depois`.

Os reducers/helpers internos podem permanecer se ainda forem usados por testes, acessibilidade ou outros fluxos, mas não manter botões redundantes só por legado.

Para acessibilidade por teclado, se a remoção desses botões deixar usuários de teclado sem forma de reordenar, implementar uma alternativa explícita e discreta (por exemplo comandos no menu contextual `Mover uma posição para trás/frente` acessíveis só como fallback) sem reintroduzir o painel horizontal permanente.

#### 9.11. Critérios de aceite

Cenário mínimo:

1. projeto com cartas A, B, C, D;
2. arrastar D para antes de B;
3. ordem visual torna-se A, D, B, C;
4. `physicalOrder.instances` apresenta exatamente essa ordem;
5. navegar Front/Back preserva o pareamento;
6. gerar PDF final apresenta A, D, B, C nos slots correspondentes;
7. undo restaura A, B, C, D;
8. redo reaplica A, D, B, C.

Também provar:

- arrastar cópia 2 de uma carta com quantidade >1 move somente aquela instância;
- ID físico da instância é preservado;
- seleção por checkbox sobrevive ao reorder;
- active instance continua apontando para a mesma instância;
- drag não abre picker;
- drag não abre menu;
- drop inválido não muda `physicalOrder`;
- reorder entre páginas chega ao export final;
- PDF de verso permanece pareado;
- reload de Project preserva a ordem quando a persistência já suportar `physicalOrder`.

#### 9.12. Testes

Obrigatórios:

- unit tests de `movePhysicalInstance` / `reorderWorkingCardPhysicalInstance`;
- interaction test de drag before/after;
- interaction test de click vs drag threshold;
- drag de cópia repetida;
- drag para página diferente;
- invalid skipped/reserved target;
- undo/redo;
- export request contém a ordem pós-drag;
- integração de export comprovando slot order no PDF/print plan;
- duplex pairing após reorder;
- typecheck;
- build.

---

> Este arquivo deve continuar sendo atualizado conforme novas mudanças forem definidas. Nenhum item marcado como “especificado” deve ser tratado como implementado sem evidência de código e testes.
