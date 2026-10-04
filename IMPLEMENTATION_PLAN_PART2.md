# TCGPrint — Implementation Plan Part 2

> **Novo ciclo de desenvolvimento após o encerramento da Phase 15.**
>
> Este documento é a fonte de verdade para o desenvolvimento pós-Phase 15.
>
> **NÃO criar Phase 16.**
> **NÃO continuar a numeração antiga de fases.**
>
> Os trabalhos deste ciclo são chamados **M1, M2, M3...**
>
> Base funcional consolidada antes do Part 2:
>
> `45856cdc8f3c62338b20666343679b4499d51304`
>
> O arquivo `IMPLEMENTATION_PLAN.md` permanece como histórico e especificação consolidada do produto até a Phase 15.

---

# 1. Fonte de verdade e precedência

Para qualquer trabalho novo do Part 2:

1. decisão explícita posterior registrada neste documento vence;
2. ADR posterior aplicável vence regra anterior conflitante;
3. `IMPLEMENTATION_PLAN_PART2.md` governa o desenvolvimento do Part 2;
4. invariantes e comportamento consolidado até a Phase 15 continuam válidos;
5. `IMPLEMENTATION_PLAN.md` permanece referência histórica e arquitetural.

Não manter duas regras contraditórias ativas no produto.

O Part 2 não autoriza reinterpretar silenciosamente comportamento existente para facilitar implementação.

---

# 2. Processo obrigatório de desenvolvimento

Cada milestone do Part 2 deve possuir uma branch própria.

Padrão:

```text
feature/part2-m1-<descricao>
feature/part2-m2-<descricao>
feature/part2-m3-<descricao>
...
```

Fluxo obrigatório:

```text
main consolidada
    ↓
branch exclusiva do milestone
    ↓
implementação
    ↓
testes focados
    ↓
suite/gates aplicáveis
    ↓
auditoria do milestone
    ↓
aprovação explícita do usuário
    ↓
integração em main
    ↓
próximo milestone nasce da nova main
```

Um milestone posterior não deve nascer de uma branch anterior ainda não integrada.

Antes de implementar um milestone:

- ler o milestone inteiro;
- ler invariantes globais;
- investigar o código real;
- identificar domínio, serviços, API, persistência, UI e export relacionados;
- identificar testes existentes;
- produzir uma matriz de requisitos rastreável;
- somente então orientar o executor.

Antes de considerar o milestone pronto:

- reler o milestone inteiro;
- comparar cada requisito contra o diff completo da branch;
- executar os gates aplicáveis;
- registrar findings e riscos residuais;
- não integrar sem autorização explícita.

---

# 3. Invariantes globais do Part 2

> **Escopo normativo do Part 2:** este documento é um delta sobre `IMPLEMENTATION_PLAN.md` e os ADRs aceitos. Uma regra do Part 2 só substitui comportamento anterior quando essa substituição estiver explicitamente especificada; tudo que não estiver explicitamente substituído permanece normativo e deve ser preservado. Reorganização de UX não autoriza mudança de geometria, fidelidade, export, bleed, trim, duplex, calibration ou cut fora do delta declarado.

## 3.1 Qualidade final do PDF

Nenhuma alteração do Part 2 pode reduzir a qualidade final do PDF.

Preservar obrigatoriamente:

- dimensão física exata;
- trim;
- bleed;
- geometria;
- JPEG passthrough quando aplicável;
- PNG lossless;
- PNG16 e alpha;
- SVG vetorial;
- duplex;
- calibration;
- registration;
- cut geometry;
- templates;
- Silhouette;
- precisão física;
- originals como fonte de export.

É proibido usar como fonte de export:

- thumbnails;
- previews reduzidos;
- imagens downsampled;
- recompressão desnecessária;
- rasterização desnecessária de SVG.

Performance deve ser resolvida por cache, lazy loading, virtualização, batching, bounded concurrency, request coalescing e cancelamento — nunca sacrificando fidelidade.

## 3.2 Não regressão funcional

O Part 2 pode reorganizar e simplificar a experiência, mas não apagar capacidades existentes sem decisão explícita.

Exceto funcionalidades explicitamente removidas neste documento, toda capacidade user-facing consolidada até a Phase 15 deve continuar acessível e funcionalmente equivalente.

Pode:

- reorganizar;
- renomear para maior clareza;
- mover para seção;
- colocar em accordion;
- esconder opção avançada em subseção adequada;
- melhorar texto/explicação.

Não pode:

- desaparecer silenciosamente;
- ficar inacessível;
- virar controle sem efeito;
- mudar semântica sem especificação;
- ser substituída por comportamento inferior.

## 3.3 Integridade de interação

Nenhum botão, tab, step, accordion, toggle, selector, menu, HUD, drag target ou outro controle pode parecer interativo sem produzir efeito coerente.

Controles sem efeito perceptível são bugs.

Testes devem validar interação real quando aplicável, e não apenas presença de texto em SSR/HTML.

## 3.4 Clareza de informação

Preservar um controle não basta.

A UI deve deixar claro, quando aplicável:

- o que o controle altera;
- unidades;
- que parte do PDF/output é afetada;
- quando o efeito ocorre;
- se é preview-only ou export;
- dependências/pré-requisitos;
- por que algo está desabilitado;
- origem de metadata;
- diferença entre valor informado pelo provider e valor verificado pelo TCGPrint.

## 3.5 Proteção especial para DFC

A face Back real de uma carta dupla-face não é um cardback genérico.

Nunca tratar uma face Back real de DFC como:

- Project Default Back;
- Back Library genérica;
- manual physical back genérico;
- alvo de bulk back de carta simples.

Front e Back de DFC devem permanecer vinculados como a mesma carta física.

Operações em massa destinadas a backs de cartas simples nunca podem sobrescrever DFC.

---

# 4. Ordem de implementação

A ordem do Part 2 é:

```text
M1 — Regras de identidade, uploads e backs
 ↓
M2 — Fluxo único para adicionar cartas
 ↓
M3 — Catálogo completo e qualidade das artworks
 ↓
M4 — Nova arquitetura visual da aplicação
 ↓
M5 — Compositor/PDF Viewer canônico
 ↓
M6 — Artwork Picker completo
 ↓
M7 — Compositor interativo
 ↓
M8 — Integração, não regressão e auditoria final
```

A ordem é deliberada.

Primeiro estabilizamos regras e dados; depois simplificamos entrada; depois garantimos catálogo e metadata completos; só então reconstruímos UI e compositor; por último adicionamos edição direta e auditoria integrada.

---

# M1 — Regras de identidade, uploads e backs

## Objetivo

Eliminar inferências desnecessárias em uploads custom e tornar a semântica de verso físico coerente antes de qualquer redesign.

M1 possui duas mudanças funcionais explícitas:

1. remover identificação automática de carta a partir de imagem enviada como custom;
2. remover Scryfall como verso físico genérico de carta simples.

Essas remoções são exceções explícitas à regra geral de não regressão.

---

## M1.1 Upload custom não tenta descobrir identidade

Uma imagem adicionada diretamente como carta custom significa:

```text
usar esta imagem como a carta a imprimir
```

Ela não significa:

```text
tentar descobrir qual carta Magic essa imagem representa
```

Para upload custom, remover:

- filename → identidade;
- OCR;
- OCR title-band;
- Tesseract;
- Scryfall lookup disparado pela imagem;
- fuzzy matching derivado da imagem;
- sugestão automática de identidade baseada no nome do arquivo;
- conversão automática de upload em identidade de catálogo.

Exemplos que devem continuar custom:

```text
Island.png
1x Sol Ring [MPC].png
qualquer imagem contendo visualmente o texto ISLAND
```

Nenhum desses casos deve provocar reconhecimento automático de identidade.

### Deve permanecer

Não remover:

- uploads;
- armazenamento de originals;
- thumbnails;
- LocalArtworkProvider;
- carta custom;
- uso da imagem enviada no PDF;
- quantities;
- order;
- duplicate/delete;
- Project persistence;
- back;
- bleed;
- rounded corners;
- cut;
- duplex;
- Scryfall para entradas explicitamente identificáveis;
- MPC;
- DFC/MDFC.

### Decklist continua sem alteração semântica

```text
1 Island
```

é uma entrada explícita de identidade e deve continuar resolvendo Island.

Também continuam válidos:

- Scryfall ID explícito;
- set + collector;
- busca manual;
- confirmação manual;
- fuzzy matching de texto quando semanticamente apropriado;
- re-resolve de entradas que realmente representam carta identificável.

Não remover fuzzy matching global apenas porque filename/OCR deixa de existir.

### Código legado a auditar/remover

Auditar e remover se não houver outro uso legítimo:

- `providers/ocr/tesseract-recognizer.ts`;
- `providers/ocr/types.ts`;
- `core/cards/filename-resolver.ts`;
- opções `filename`, `imageBytes`, `recognizer` exclusivas da inferência de upload;
- `ocrTitleBandHeightRatio`;
- `ocrOutputDpi`;
- dependências `tesseract.js`;
- `tesseract.js-core`;
- `@tesseract.js-data/eng`;
- entradas correspondentes de `serverExternalPackages`;
- lifecycle/dispose do recognizer;
- leitura do original exclusivamente para OCR;
- cache keys exclusivamente relacionadas a OCR/filename.

Auditar também `createWorkingSet()` e qualquer `nameSuggestion` produzido por importer de asset para garantir que uma imagem custom não reentre indiretamente no pipeline de identidade.

### Compatibilidade legacy

Projects antigos podem conter `resolutionMethod: "ocr"` ou `"filename"`.

O produto deve conseguir ler Projects históricos quando necessário.

Novos fluxos não devem produzir essas resoluções.

Abrir Project antigo não pode disparar OCR/filename novamente nem mudar identidade silenciosamente.

---

## M1.2 Carta simples: regras de verso físico

Para identidade NÃO dupla-face, fontes normais de verso físico passam a ser:

- Back Library;
- MPC Autofill, quando houver resultado semanticamente apropriado para back;
- Project Default Back;
- Sem verso, quando explicitamente selecionado ou permitido pela policy.

Remover para novas seleções de carta simples:

- Scryfall como verso físico manual genérico;
- upload local genérico diretamente como verso fora da Back Library.

Imagem própria destinada a cardback deve entrar pela Back Library.

### Scryfall

Scryfall continua totalmente disponível para:

- artwork da Front de carta simples;
- identidade;
- busca;
- printings;
- face Front de DFC;
- face Back real de DFC.

Scryfall deixa de ser opção de `manualBackArtwork` para carta simples.

### MPC

MPC continua disponível para Front e para backs quando o provider realmente disponibilizar resultado válido para o contexto de back.

Não reutilizar silenciosamente artwork frontal arbitrária como cardback só porque ela existe no MPC.

A implementação deve investigar e respeitar a semântica real do provider para resultados de back/cardback.

### Back Library

Back Library permanece como biblioteca oficial de cardbacks enviados pelo usuário.

Continuar suportando:

- upload JPEG/PNG;
- Project Default Back;
- seleção manual;
- persistência;
- retire;
- Projects;
- export.

### DFC

Quando `isDoubleFacedIdentity(...) === true`:

- Front e Back são faces reais;
- Scryfall continua disponível nas duas faces;
- MPC continua disponível por face;
- uploads compatíveis continuam disponíveis por face;
- seleção por face continua independente;
- indicador de DFC permanece;
- tabs Front/Back permanecem;
- pairing e duplex permanecem.

Não confundir:

```text
selectedArtworkByFace.back de DFC
```

com:

```text
manualBackArtwork de carta simples
```

### Enforcement de domínio/API

A restrição não pode existir somente na UI.

Para novas seleções de carta simples:

- `manualBackAsset` da Back Library é válido;
- MPC back válido é permitido;
- Scryfall como `manualBackArtwork` não é permitido;
- upload genérico direto como `manualBackArtwork` não é permitido.

Para DFC:

- Scryfall em `selectedArtworkByFace.back` é válido;
- MPC em `selectedArtworkByFace.back` é válido.

### Legacy Project com Scryfall manual back

Project antigo contendo carta simples com Scryfall já persistido como verso deve:

- abrir sem erro;
- preservar referência/bytes;
- continuar exportando igual;
- não sofrer migração silenciosa.

A UI nova não deve permitir criar outra seleção desse tipo.

Se o usuário substituir o verso, passa a usar as regras novas.

---

## M1 — Testes obrigatórios

Cobrir pelo menos:

- upload com pixels contendo `ISLAND` não chama OCR/Scryfall;
- `Island.png` continua custom;
- `1x Sol Ring [MPC].png` continua custom;
- `1 Island` continua resolvendo identidade;
- Scryfall ID continua resolvendo;
- set + collector continua resolvendo;
- carta conhecida continua podendo escolher upload como artwork da face;
- PDF de carta custom preserva output;
- carta simples não oferece Scryfall como back novo;
- carta simples permite Back Library;
- carta simples permite MPC back válido;
- DFC continua permitindo Scryfall Back;
- DFC continua permitindo MPC Back;
- legacy Project com Scryfall manual back continua abrindo/exportando;
- busca final por referências de OCR/Tesseract não deixa produção/config morta.

---

# M2 — Fluxo único para adicionar cartas

## Objetivo

Eliminar a necessidade de o usuário executar duas ações sucessivas para obter um Working Set utilizável.

Comportamento atual relevante:

```text
Universal Import → Working Set
Resolver identidades
```

A separação interna pode continuar existindo, mas não deve ser uma obrigação cognitiva do usuário.

---

## Fluxo principal novo

A ação principal passa a representar a intenção:

```text
Adicionar cartas
```

Um clique executa, quando aplicável:

```text
input
↓
Universal Import / parsing
↓
Working Set
↓
resolução de identidades explícitas
↓
detecção de carta simples / DFC
↓
defaults aplicáveis
↓
estado pronto para escolher/ajustar artwork e imprimir
```

Não juntar módulos internos artificialmente apenas para ter um botão.

A simplificação é de UX; a arquitetura pode continuar modular.

---

## Entradas conhecidas

Exemplo:

```text
4 Island
2 Sol Ring
1 Delver of Secrets
```

Após um clique:

- quantidades preservadas;
- ordem preservada;
- seções preservadas;
- identidades resolvidas;
- DFC sinalizadas;
- defaults aplicáveis preparados;
- Scryfall/MPC disponíveis para artwork;
- somente itens realmente problemáticos pedem intervenção.

Não exigir botão global adicional de `Resolver identidades`.

---

## Erros e ambiguidades

Uma entrada ruim não deve impedir toda a lista.

Exemplo:

```text
✓ Island
✓ Sol Ring
! entrada ambígua — precisa de confirmação
✓ Lightning Bolt
```

Somente a entrada problemática deve pedir ação.

Manter:

- correção manual;
- busca manual;
- re-resolve;
- keep custom quando semanticamente aplicável;
- ImportReport;
- mappings;
- detected entries;
- warnings/errors.

ImportReport deixa de ser caminho obrigatório e pode ficar em Diagnóstico.

---

## Upload custom respeita M1

Arquivo custom:

```text
minha-arte.png
```

faz:

```text
registrar original
→ criar Custom Card
→ usar imagem
→ pronto
```

e não:

```text
filename/OCR
→ Scryfall
→ identidade
```

---

## Progress

A operação única deve informar progresso sem exigir novos cliques:

```text
Lendo entradas…
Preparando cartas…
Resolvendo identidades… 43/74
Pronto · 73 resolvidas · 1 precisa de atenção
```

Preservar cancelamento em operações abortáveis.

Não permitir clique duplicado gerar entradas duplicadas durante processamento.

---

## M2 — Testes obrigatórios

Cobrir:

- decklist válida termina resolvida com um clique;
- não exige clique posterior em Resolver identidades;
- ordem/quantidades/seções preservadas;
- DFC sai do fluxo já identificada;
- entrada ruim é destacada individualmente;
- erro parcial não apaga entradas válidas;
- upload custom não chama resolução;
- filename `Island.png` não consulta Scryfall;
- ImportReport continua acessível;
- cancelamento não aplica estado parcial incoerente;
- clique duplicado durante busy não duplica cartas;
- Project/persistence continuam aceitando estado produzido pelo fluxo novo;
- browser test: colar lista → clicar uma vez → Working Set utilizável.

---

# M3 — Catálogo completo e qualidade das artworks

## Objetivo

Permitir que o usuário realmente escolha entre todas as artworks oferecidas pelos providers e veja informações de qualidade antes de selecionar.

M3 une duas necessidades inseparáveis:

1. catálogo completo;
2. metadata de decisão/qualidade antes da seleção.

---

## M3.1 MPC Autofill — remover teto artificial

No baseline existe limite explícito em `artwork/mpc-provider.ts`:

```ts
this.searchLimit = Math.min(30, Math.max(1, options.searchLimit ?? 30));
```

e:

```ts
resultIds(...).slice(0, this.searchLimit)
```

Esse teto deve ser removido como limitação de catálogo.

Se o provider disponibiliza 1398 resultados para Island, os 1398 devem ser acessíveis.

Não substituir o teto por outro arbitrário como 50, 100, 200 ou 500.

---

## M3.2 Scryfall — preservar catálogo completo

O baseline já percorre `listPrintings()` usando paginação `has_more/next_page`.

Preservar isso e auditar todas as camadas posteriores para garantir que:

- API;
- services;
- provider;
- DTO;
- cache;
- UI;

não cortem printings/artworks arbitrariamente.

Todas as printings elegíveis retornadas para a identidade/face devem permanecer acessíveis.

---

## M3.3 Catálogo completo não significa baixar todos os originals

Separar níveis:

### Descoberta/metadata

Conhecer todos os IDs/resultados e metadata necessária para filtros/ranking.

### Preview

Carregar thumbnails/previews progressivamente conforme necessário.

### Original

Baixar/validar original somente quando necessário para:

- seleção;
- validação efetiva;
- export;
- quality probing controlado.

Uma carta com milhares de resultados não pode provocar download de milhares de originals automaticamente.

---

## M3.4 Informações antes da seleção

Selecionar uma artwork deve significar:

```text
quero usar esta
```

e não:

```text
baixe esta só para eu descobrir se é boa
```

Cada resultado deve mostrar, quando disponível antes da seleção:

- provider;
- nome/face;
- set;
- collector number;
- idioma;
- source;
- formato;
- dimensões;
- DPI;
- quality/resolution status;
- tamanho;
- full-art;
- disponibilidade do original;
- cache local;
- release/date quando relevante;
- tags;
- metadata MPC;
- status de validação.

---

## M3.5 DPI informado vs DPI efetivo

A UI deve diferenciar claramente:

- DPI informado pelo provider;
- DPI efetivo verificado pelo TCGPrint.

Exemplo:

```text
800 DPI · informado pelo MPC
```

e depois:

```text
798 DPI efetivo · verificado ✓
```

Nunca apresentar metadata remota como se fosse medição local comprovada.

Também não confundir:

```text
DPI desconhecido
```

com:

```text
DPI baixo
```

Estados possíveis devem ser explícitos:

- valor verificado;
- valor informado;
- verificando;
- desconhecido;
- original indisponível.

---

## M3.6 Scryfall quality hydration

Quando metadata do Scryfall não for suficiente para calcular DPI efetivo, o produto deve poder hidratar informações de qualidade em background, sem exigir seleção primeiro.

Prioridade:

1. itens visíveis;
2. melhores/primeiros resultados;
3. página/lote corrente;
4. restante conforme necessário.

Usar:

- cache;
- bounded concurrency;
- cancelamento ao trocar de carta/face;
- coalescing;
- não repetir análise já conhecida.

Não bloquear UI esperando todo o catálogo.

---

## M3.7 Filtros e ranking consideram catálogo inteiro

Se houver 1398 resultados e o maior DPI estiver no resultado originalmente distante, ordenar por maior DPI deve conseguir colocá-lo corretamente.

Não:

```text
pegar primeiros 30
→ ordenar somente os 30
```

Filtros e ranking devem atuar sobre o conjunto lógico completo de metadata disponível.

Filtros existentes do MPC devem continuar, incluindo:

- DPI mínimo;
- DPI máximo;
- source;
- languages;
- include/exclude tags;
- preferred tags;
- preferred sources;
- preferred languages;
- ranking mode.

---

## M3.8 Grandes catálogos

A quantidade de resultados deve ser tratada por:

- paginação interna ou infinite loading;
- virtualização;
- lazy preview;
- hydration em lotes;
- bounded concurrency;
- cache;
- cancelamento.

Otimização nunca pode significar descartar resultados.

Mostrar contadores reais, por exemplo:

```text
MPC Autofill · 1398 artworks
Scryfall · 87 artworks
```

Com filtro:

```text
247 de 1398
```

O total não pode representar apenas o lote atualmente renderizado.

---

## M3.9 DFC

Catálogo completo é por face.

Front e Back mantêm resultados separados.

Não misturar candidates de faces diferentes.

---

## M3 — Testes obrigatórios

Cobrir:

- MPC retorna 75 IDs → todos acessíveis;
- fixture 500+;
- fixture 1200+;
- item desejado em posição distante continua localizável/selecionável;
- melhor DPI fora do primeiro lote influencia ranking;
- filtros consideram catálogo completo;
- Scryfall multi-page retorna todas as printings;
- nenhuma camada posterior corta resultados;
- DFC mantém catálogo por face;
- troca de carta cancela hydration obsoleta;
- cache evita trabalho repetido;
- milhares de resultados não geram milhares de imagens pesadas simultaneamente;
- selecionar artwork distante entra no mesmo pipeline lossless de export;
- DPI MPC informado aparece antes da seleção;
- DPI efetivo é distinguido de metadata informada.

---

# M4 — Nova arquitetura visual da aplicação

## Objetivo

Reorganizar a UI em torno do trabalho principal sem remover capacidade do produto.

A estrutura visual desejada possui essencialmente duas regiões:

1. compositor/PDF central ocupando o máximo de espaço;
2. uma sidebar direita com todas as opções organizadas.

Não criar um grande header/painéis espalhados como estrutura principal.

---

## M4.1 Sidebar direita

Desktop:

- aproximadamente 360–420 px;
- scroll própria;
- recolhível completamente;
- pequeno handle para reabrir;
- fechar não altera configuração;
- reabrir preserva seção/subseção quando razoável.

Mobile:

- drawer vindo da direita;
- sobrepõe o compositor;
- fechar devolve preview praticamente full-screen;
- evitar overflow horizontal.

---

## M4.2 Navegação de seções

No topo da sidebar, navegação sticky.

Primeira seção obrigatoriamente:

```text
Cartas
```

Estrutura proposta:

```text
Cartas
Artwork
Projeto
Layout
PDF
Corte
Templates
Calibração
Export
Diagnóstico
```

Em tela estreita, navegação horizontal pode rolar.

Cada seção mostra somente seu conteúdo; não renderizar dezenas de campos simultaneamente sem hierarquia.

Usar subseções/accordions para advanced settings.

---

## M4.3 Inventário mínimo a preservar

### Cartas

Preservar:

- entradas por texto/decklist/URL;
- files/folder/drag-drop;
- Working Set;
- quantities;
- ordem;
- move;
- duplicate;
- delete;
- card selection;
- identidade;
- origem/hints;
- manual search;
- confirm identity;
- keep custom quando aplicável;
- re-resolve quando aplicável;
- undo/redo;
- estados de operação/cancelamento;
- ImportReport relevante.

Aplicar M1/M2 ao fluxo novo.

### Artwork

Preservar:

- Scryfall;
- MPC;
- uploads;
- DFC per-face;
- filters;
- selection;
- default restoration;
- MPC advanced filters/preferences;
- provider diagnostics;
- DPI/status;
- manual back somente dentro das novas regras de M1.

### Projeto

Preservar:

- create;
- current;
- dirty/saved;
- save explícito;
- open;
- duplicate;
- delete;
- local copy;
- recovery;
- conflict actions;
- canonical project state.

### Layout

Preservar:

- paper format;
- card format;
- page orientation;
- card orientation;
- rows/columns;
- auto layout;
- skipped slots;
- gaps;
- quatro margins;
- template geometry.

### PDF

Preservar:

- export content mode;
- front-only;
- back-only;
- front/back separated;
- duplex;
- duplex flip;
- missing back policy;
- bleed;
- rounded corners;
- trim guide;
- trim extent;
- trim color;
- external guide;
- external stroke;
- external color;
- Back Library;
- Project Default Back.

### Corte

Preservar:

- registration type;
- orientation;
- offsets X/Y;
- arm length;
- stroke;
- square size;
- reserved-zone clearance;
- custom geometry;
- cut source selection;
- SVG export;
- DXF export;
- DXF units;
- page correspondence.

### Templates

Preservar a Silhouette Template Library completa:

- import;
- metadata;
- name/source/version;
- existing template;
- paper/card;
- orientation;
- recommended bleed;
- registration;
- registration geometry;
- exact template geometry;
- associated files;
- immutable hashes;
- version selection;
- association/disassociation;
- removal;
- SVG/DXF source;
- integrity/status.

### Calibração

Preservar Precision Print Calibration completa:

- exact profile version;
- profile selection/name/mode;
- create;
- rename;
- duplicate;
- import/export JSON;
- update Project to newer version;
- compatibility/status;
- Simple/Advanced;
- Front/Back;
- X/Y/rotation;
- scale X/Y;
- skew X/Y;
- nudges micro/fine/normal/coarse;
- advanced measurements;
- nominal/calibrated/overlay;
- back opacity;
- session ID;
- new session;
- Calibration PDF;
- Verification PDF;
- duplex instructions;
- save recalibration;
- residual;
- attestation;
- physical verification/revision.

### Export

Preservar:

- validation/preflight;
- generate;
- cancellation;
- retry;
- final PDF;
- download;
- relevant SVG/DXF export paths.

### Diagnóstico

Preservar acesso a:

- ImportReport completo;
- detections;
- mappings;
- warnings/errors;
- provider/MPC diagnostics;
- technical layout/slot/bleed information;
- legacy local PDF test enquanto existir no baseline e não houver decisão explícita de removê-lo.

---

## M4.4 Precision Print Calibration — stages reais

O baseline possui steps 1/2/3 que em grande parte mudam apenas estado visual enquanto quase todo o conteúdo permanece igual.

Refatorar para etapas semanticamente distintas:

```text
[ Profile ] [ Ajuste ] [ Medições ] [ Verificação ]
```

### Profile

- select/create/import/export;
- rename;
- duplicate;
- version;
- printer mode;
- compatibility;
- status/update.

### Ajuste

- Front/Back;
- Simple/Advanced;
- X/Y/rotation;
- scale/skew;
- nudges;
- nominal/calibrated/overlay.

### Medições

- Calibration PDF;
- session;
- physical targets;
- X/Y measurements;
- advanced solver;
- residual;
- instructions.

### Verificação

- Verification PDF;
- residual per target;
- attestation;
- physical measurement;
- revision;
- accuracy summary.

Não remover duplex instructions, opacity ou demais capabilities existentes.

---

## M4.5 Responsividade, acessibilidade e testes de interação

Adicionar testes que realmente interajam com:

- sidebar;
- tabs;
- accordions;
- selects;
- toggles;
- fields;
- calibration steps;
- focus/keyboard quando aplicável;
- desktop;
- tablet;
- mobile.

Auditar Phase 15 capability por capability:

```text
controle antigo
→ nova localização
→ ação esperada
→ mudança visual
→ mudança de estado
→ persistência
→ teste
```

M4 falha se capability existente desaparecer sem remoção explícita do Part 2.

---

# M5 — Compositor/PDF Viewer canônico

## Objetivo

Substituir o preview técnico/abstrato por um compositor físico real do resultado de impressão.

O compositor passa a ser o centro visual do produto.

---

## M5.1 Representação real

Mostrar:

- artwork real selecionada;
- posição física;
- tamanho físico;
- bleed;
- trim;
- rounded corners;
- cut guides;
- registration;
- margins;
- gaps;
- slots;
- skipped/reserved;
- template/Silhouette;
- calibration;
- front/back;
- duplex;
- back rotation;
- paper/orientation.

No modo normal não poluir a arte com labels técnicos como `TOP`, nomes ou `01F`.

Essas informações podem existir em camada de Diagnóstico.

---

## M5.2 Uma única geometria canônica

Preview, PDF, duplex e cut export não podem possuir algoritmos concorrentes.

O compositor deve consumir o mesmo plano físico canônico usado pelo output.

Não criar um segundo layout engine apenas para a UI.

---

## M5.3 Auto-layout físico estável

Quantidade de cartas não deve determinar a origem física da grade.

Para layout não-template:

- resolver a grade física canônica de maior capacidade válida para papel/card/bleed/margins/gaps/registration, com tie-break determinístico;
- estabilizar o envelope documental e a reserved mask antes de calcular a origem;
- calcular `gridWidth` e `gridHeight` finais com esse envelope e centralizar a grade física completa dentro da área útil:

  ```text
  availableWidth = pageWidth - marginLeft - marginRight
  availableHeight = pageHeight - marginTop - marginBottom

  gridX = marginLeft + (availableWidth - gridWidth) / 2
  gridY = marginTop + (availableHeight - gridHeight) / 2
  ```

- congelar coordenadas e slots físicos antes de paginar; depois atribuir cartas em row-major;
- não usar a quantidade de cartas para escolher uma grade menor ou recalcular/recentralizar sua origem; página parcial altera somente as atribuições;
- esquerda → direita;
- cima → baixo;
- primeira carta ocupa primeiro slot físico elegível;
- última página preserva a mesma grade física.

Rows/columns explícitos continuam autoridade quando configurados.

Template exact geometry vence auto-layout.

Skipped/reserved slots não compactam a geometria.

---

## M5.4 Layers do compositor

Fornecer toggles de visualização preview-only para, quando aplicável:

- Artwork;
- Bleed;
- Trim;
- Cut Guides;
- Silhouette/SVG-DXF;
- Registration;
- Reserved Zones;
- Margins;
- Calibration.

Esses toggles não alteram export por si só.

Diferenciar claramente overlay de visualização de setting real de export.

---

## M5.5 Front / Back no topo do viewer

O compositor deve possuir switch persistente próximo à sua toolbar:

```text
[ Frente ] [ Verso ]
```

Ele pertence ao viewer, independentemente da seção aberta na sidebar.

### Frente

Renderiza as páginas canônicas de front.

### Verso

Renderiza os backs físicos correspondentes, respeitando:

- duplex pairing;
- flip mode;
- artwork rotation;
- calibration transform;
- DFC real Back;
- manual/project backs;
- missing-back policy.

Trocar Frente/Verso:

- preserva página física correspondente quando possível;
- preserva selected physical instance;
- não muda Project settings;
- não muda output.

Para DFC:

```text
Front = face real frontal
Back = face real traseira
```

Para carta simples:

```text
Front = artwork selecionada
Back = effective physical back
```

Bulk/default back nunca substitui DFC.

---

## M5.6 Paginação e zoom

Suportar:

- página atual;
- total;
- próxima/anterior;
- Fit Page;
- Fit Width;
- 100%;
- zoom +/−.

Zoom é somente visual.

Paginação deve corresponder ao plano físico real.

---

## M5.7 Live compositor vs PDF final

Dois níveis:

### Live compositor

- mesmas regras e geometria do output;
- pode usar thumbnail/preview para responsividade;
- atualiza conforme settings relevantes mudam.

### Visualizar PDF final

Botão explícito:

```text
Visualizar PDF final
```

gera o arquivo real, lossless, pelo pipeline final e exibe exatamente esse PDF.

Nunca usar thumbnail/live preview como fonte do PDF final.

---

## M5.8 Todos os settings que afetam PDF devem aparecer representados

O compositor precisa responder a todo estado/config que afeta output físico, incluindo:

- paper/card;
- orientation;
- margins;
- gaps;
- rows/columns;
- skipped slots;
- bleed;
- rounded;
- cut guides;
- export content;
- backs;
- registration;
- templates;
- cut geometry;
- calibration;
- duplex;
- missing back policy;
- printer profile/mode.

Nada relevante das Phases 5–15 pode ficar conceitualmente fora do compositor.

---

## M5.9 Calibration no compositor

Mostrar quando aplicável:

- selected exact profile version;
- front/back;
- printer mode/duplex;
- X/Y/rotation;
- scale/skew;
- canonical transform;
- nominal vs calibrated overlay.

Regra importante:

- nominal planning continua nominal;
- cut SVG/DXF permanece nominal;
- final PDF recebe calibration CTM;
- marks/content impressos no PDF seguem o page transform;
- cut files não devem sofrer essa transformação.

O compositor deve conseguir explicar/visualizar a diferença entre geometria nominal de corte e conteúdo impresso calibrado.

---

## M5.10 Erros

Nunca corrigir erro físico silenciosamente encolhendo carta/bleed.

Mostrar problema de layout/configuração de forma explícita.

---

## M5 — Testes obrigatórios

Cobrir:

- artwork real no preview;
- posição física igual ao plano de PDF;
- 1 carta começa no primeiro slot elegível;
- 2 cartas não recentralizam grade;
- row-major;
- fixed rows/columns;
- template exact;
- reserved/skipped;
- última página estável;
- Front/Back correspondente;
- DFC;
- carta simples com back;
- duplex flip;
- calibration;
- cut overlays;
- registration;
- layers não alteram export;
- zoom não altera export;
- final PDF viewer abre o arquivo realmente gerado;
- nenhuma thumbnail entra no PDF;
- geometry parity preview/PDF/cut;
- mobile/desktop viewer.

---

# M6 — Artwork Picker completo

## Objetivo

Criar uma janela flutuante grande e clara para escolher artwork sem sair do compositor.

M6 consome catálogo/metadata completos de M3.

---

## M6.1 Abertura

A ação `Selecionar arte` abre Artwork Picker flutuante.

No topo:

```text
[ Front ] [ Back ]
```

Abaixo, fontes adequadas ao contexto.

---

## M6.2 Front de carta simples

Fontes:

- Todas;
- Scryfall;
- MPC Autofill;
- Meus uploads.

Mostrar todos os resultados disponíveis segundo M3.

---

## M6.3 DFC

Front e Back são faces reais.

Nas duas faces, manter:

- Scryfall;
- MPC Autofill;
- uploads compatíveis.

O picker deve mostrar claramente `Carta dupla-face` e os nomes das faces.

Não tratar Back DFC como cardback genérico.

---

## M6.4 Back de carta simples

Seguir M1.

Opções:

- Back Library;
- MPC back válido;
- Sem verso;
- Project Default Back quando aplicável.

Não oferecer Scryfall como back físico genérico.

Não oferecer upload genérico direto; imagem própria destinada a back entra pela Back Library.

---

## M6.5 Informação visual por artwork

Antes de selecionar, mostrar quando conhecido:

- preview;
- provider;
- face;
- DPI;
- origem do DPI;
- dimensions;
- quality;
- set/collector;
- language;
- source;
- format;
- size;
- tags;
- original availability;
- cache/validation status.

Ordenações:

- Recomendado;
- Maior DPI;
- Mais recente quando aplicável;
- Provider/order do provider quando aplicável.

Preservar todos os filtros avançados existentes.

---

## M6.6 Aplicar para todas iguais

Ao selecionar artwork, permitir escopo explícito.

Exemplo:

```text
Aplicar para:
○ somente esta entrada/cópia
○ todas as cartas iguais
```

`todas iguais` deve ser definido por mesma CardIdentity + mesma face, não somente string de nome.

Se uma entrada possui quantity > 1, uma seleção no nível da entrada naturalmente afeta suas cópias.

Se o usuário estiver atuando sobre uma physical instance específica e escolher somente aquela cópia, o domínio pode precisar dividir:

```text
Island ×4 → arte A
```

em:

```text
Island ×3 → arte A
Island ×1 → arte B
```

sem perder ordem/persistência.

---

## M6.7 Bulk back

Para carta simples, permitir ações como:

```text
Aplicar somente nesta
Aplicar para todas as cartas simples iguais
Aplicar para todas as cartas simples do projeto
```

Antes de aplicar, mostrar impacto.

Exemplo:

```text
Aplicar verso a 14 cartas simples
2 cartas dupla-face serão preservadas
```

Proteção DFC é obrigatória em UI, domínio e API.

Bulk back nunca altera:

- `selectedArtworkByFace.back` real de DFC;
- identidade DFC;
- pairing DFC.

No Back de uma DFC, não mostrar ação de cardback genérico para todas as cartas.

---

## M6.8 Performance

Catálogo completo não significa DOM completo.

Usar:

- virtualização;
- infinite loading/paginação interna;
- thumbnails lazy;
- hydration priorizada;
- cancelamento;
- cache.

---

## M6 — Testes obrigatórios

Cobrir:

- abrir picker sem sair do compositor;
- Front/Back troca face correta;
- Scryfall/MPC/uploads no Front;
- DFC permite Scryfall/MPC nas duas faces;
- carta simples Back não oferece Scryfall;
- carta simples Back oferece Back Library/MPC/none;
- catálogo acima de 1000 permanece navegável;
- DPI/metadata aparecem antes de selecionar quando disponíveis;
- filtros e ranking usam catálogo completo;
- aplicar somente nesta;
- aplicar todas iguais;
- bulk back simples;
- bulk back mixed simple+DFC preserva DFC;
- API não permite bypass da proteção;
- split quantity de uma cópia quando necessário;
- persistence round-trip das escolhas.

---

# M7 — Compositor interativo

## Objetivo

Transformar o compositor em superfície principal de manipulação das cartas sem criar estado paralelo nem geometria livre.

---

## M7.1 Physical instance mapping

Cada carta renderizada deve mapear de forma estável para:

- WorkingCard ID;
- logical quantity entry;
- physical instance ID/index;
- PDF page;
- physical slot;
- Front/Back face.

O compositor não possui cópia independente do domínio.

---

## M7.2 Seleção

Desktop:

- clique primário seleciona;
- clique secundário abre HUD contextual.

Mobile:

- toque seleciona;
- long-press ou ação `…` abre HUD.

Selecionar:

- destaca a physical instance;
- pode destacar levemente outras cópias da mesma entrada;
- sincroniza sidebar;
- sincroniza face/contexto;
- não altera output por si só.

Trocar Front/Back preserva a mesma physical instance quando possível.

---

## M7.3 HUD contextual

A HUD é preview-only e nunca aparece no PDF.

Ações mínimas, conforme contexto:

- Selecionar arte;
- Configurar verso / face;
- Aumentar quantidade;
- Remover uma cópia;
- Duplicar como entrada independente;
- Remover carta;
- Abrir settings completos da carta.

DFC recebe ações coerentes com face real.

---

## M7.4 Drag-and-drop por slots

Permitir arrastar carta para reorganizar posição.

Não permitir free XY placement.

O canonical layout engine continua definindo:

- coordinates;
- dimensions;
- margins;
- gaps;
- registration exclusions;
- template geometry;
- cut geometry.

Drag altera somente atribuição/ordem de physical instances entre slots elegíveis.

Comportamento preferido:

- inserção/reordenação determinística;
- cards intermediários se deslocam;
- não alterar dimensões;
- não alterar grid geometry.

Reserved/skipped slots não podem receber drop.

---

## M7.5 Front e Back movem juntos

A carta física é o objeto.

Mover Front muda a posição física do par correspondente.

Mover no modo Back também deve operar sobre a mesma carta física, não reorganizar Back independentemente.

DFC nunca pode separar Front de Back.

Duplex pairing deve continuar correto após reorder.

---

## M7.6 Quantity vs physical instance

`Island ×4` continua uma entrada compacta por padrão, mesmo que apareça quatro vezes fisicamente.

Reordenar uma cópia não precisa duplicar WorkingCard.

Somente mudança semântica específica de uma instância, como artwork diferente, pode exigir split da entrada.

---

## M7.7 Persistência

Ordem física definida pelo usuário deve:

- salvar no Project;
- restaurar exatamente;
- reproduzir no compositor;
- reproduzir no PDF;
- preservar pairing;
- sobreviver a reload.

Não usar estado UI efêmero como única fonte.

---

## M7 — Testes obrigatórios

Cobrir:

- click seleciona instance correta;
- sidebar sincroniza;
- right-click HUD;
- mobile long-press/alternativa equivalente;
- HUD não aparece no export;
- drag coluna/slot;
- insert/reorder;
- reserved slot rejeita drop;
- quantity permanece compacta ao apenas reordenar;
- instance-specific artwork divide quantidade corretamente;
- Front/Back permanecem pareados;
- DFC permanece pareada;
- reload restaura ordem;
- PDF reproduz ordem;
- undo/redo quando aplicável ao modelo final;
- drag durante estados busy não gera inconsistência.

---

# M8 — Integração, não regressão e auditoria final do Part 2

## Objetivo

Auditar o Part 2 integrado sem introduzir feature nova.

M8 não é lugar para empurrar pendências de milestones anteriores.

M1–M7 já devem estar completos quando integrados.

---

## M8.1 Capability matrix Phase 15 → Part 2

Construir inventário completo:

```text
capability Phase 15
→ localização Part 2
→ comportamento
→ persistence
→ teste
→ status
```

Qualquer capability ausente precisa ter:

- remoção explicitamente aprovada neste documento; ou
- finding a corrigir.

---

## M8.2 Browser smoke real

Cobrir desktop e mobile.

Fluxos mínimos:

- adicionar decklist com um clique;
- custom upload;
- carta simples;
- DFC;
- selecionar artwork;
- catálogo Scryfall;
- catálogo MPC grande;
- DPI/filtros/ranking;
- Back Library;
- MPC back;
- bulk apply;
- proteção DFC;
- compositor Front/Back;
- HUD;
- drag/reorder;
- Project save/reload;
- recovery/conflict quando aplicável;
- layout;
- bleed/rounded;
- cut guides;
- registration;
- Silhouette Template Library;
- calibration;
- PDF final;
- SVG/DXF;
- cancellation/retry.

---

## M8.3 Fidelidade PDF

Revalidar explicitamente:

- trim físico;
- bleed;
- rounded corners;
- JPEG passthrough;
- PNG lossless;
- PNG16;
- alpha;
- SVG vector;
- no thumbnail as export source;
- no downsample;
- no unnecessary recompression;
- resource dedup sem perda;
- duplex;
- calibration;
- cut geometry;
- template geometry.

---

## M8.4 Large-data/performance

Revalidar:

- 1000+ artwork results sem truncamento;
- virtualização/lazy loading;
- bounded concurrency;
- cancellation;
- request coalescing;
- cache;
- troca rápida entre cartas;
- nenhuma explosão de DOM/downloads.

---

## M8.5 Interação

Auditar que não há:

- tab visual sem conteúdo distinto;
- botão sem efeito;
- selector que não persiste;
- toggle que só muda aparência;
- drag sem persistência;
- HUD action sem mutation coerente.

---

## M8.6 Gates finais

Executar conforme infraestrutura final:

- focused tests;
- full test suite;
- typecheck;
- build;
- diff-check/lint se existente;
- browser/E2E;
- production smoke;
- requirement audit;
- final independent review.

Distinguir claramente:

- resultado reportado pelo executor;
- resultado verificado pelo orquestrador.

---

# 5. Critério global de conclusão

Um milestone do Part 2 só está pronto quando:

- requisito por requisito foi rastreado;
- código relevante foi revisado;
- testes aplicáveis passaram;
- não há finding bloqueante;
- working tree/branch estão em estado auditável;
- diff final foi revisado contra a base original do milestone;
- o usuário recebeu resumo com branch/base/HEAD/commits/gates/findings;
- o usuário autorizou integração.

O Part 2 inteiro só está concluído após M8.

---

# 6. Nota para orquestração

Este arquivo deve ser lido como especificação detalhada, não como lista de títulos.

Ao delegar para Codex:

- não resumir requisitos a ponto de perder comportamento;
- fornecer contexto suficiente para o executor não depender da conversa;
- incluir casos especiais;
- incluir invariantes;
- incluir testes obrigatórios;
- incluir regras de legacy/persistence;
- incluir DFC;
- incluir performance;
- incluir explicitamente o que não pode regredir.

Se um milestone for grande, pode ser implementado em etapas internas, mas permanece na mesma branch e só é considerado completo quando sua especificação inteira estiver atendida.
