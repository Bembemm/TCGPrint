# TCGPrint — Plano de Implementação

> Documento de referência para agentes e desenvolvedores que forem implementar o projeto.
>
> **Status:** planejamento inicial consolidado  
> **Escopo inicial:** Magic: The Gathering, execução local, foco em impressão de alta qualidade e corte preciso  
> **Arquitetura:** preparada para outros TCGs posteriormente
> **Auditoria do plano:** consistência estrutural revisada antes da implementação

---

## 1. Visão do produto

O TCGPrint será uma aplicação local para preparar cartas de TCG para impressão e corte.

O produto não deve ser tratado apenas como um "gerador de PDF". Ele deve funcionar como uma estação de produção com:

- importação universal de cartas/decklists;
- busca e seleção visual de artes;
- suporte a cartas personalizadas;
- preservação máxima da imagem original;
- geração de bleed sem recortar ou ampliar a área útil da carta;
- layout físico em milímetros;
- guias de corte configuráveis;
- integração com templates de corte da Silhouette;
- projetos persistentes;
- exportação de PDF em qualidade máxima;
- suporte posterior a outros TCGs.

Fluxo principal:

```text
Criar projeto
    ↓
Importar cartas / lista / URL / arquivos
    ↓
Resolver cartas e imagens
    ↓
Escolher arte de cada carta
    ↓
Configurar tamanho físico, folha e bleed
    ↓
Configurar guias / template de corte
    ↓
Preview
    ↓
Validar resolução e layout
    ↓
Exportar PDF / arquivos de corte
    ↓
Imprimir em 100% / Actual Size
    ↓
Cortar
```

---

## 2. Prioridades do projeto

A ordem de prioridade é:

1. Dimensão física exata.
2. Qualidade máxima da imagem.
3. Preservação integral da área útil da carta.
4. Bleed externo discreto.
5. Compatibilidade e alinhamento com corte.
6. Velocidade de preview e geração.
7. Facilidade para importar listas e selecionar artes.
8. Persistência de projetos.
9. Expansão para outros TCGs.

Uma feature visual ou de conveniência nunca deve comprometer os itens 1–5.

---

## 3. Referências principais

Usar como referência de comportamento e de UX, sem copiar cegamente a arquitetura:

- Proxxied
- MTGProxyPrinter  
  https://github.com/luziferius/MTGProxyPrinter
- Silhouette Card Maker  
  https://github.com/Alan-Cha/silhouette-card-maker
- MPC Autofill  
  https://github.com/chilli-axe/mpc-autofill
- Scryfall API  
  https://scryfall.com/docs/api

Observações:

- MTGProxyPrinter é especialmente relevante para impressão, layout físico, cache, formatos de deck e guias.
- Silhouette Card Maker é referência para templates, registration marks, offsets/calibração e fluxo de corte.
- Proxxied é referência para experiência de seleção visual de artes, projetos e fluxo de geração.
- MPC Autofill é referência para seleção de artes e preservação de escolhas de imagem em XML.

---

## Fonte de verdade do projeto

Este documento é a especificação principal de implementação enquanto não houver ADR posterior que altere explicitamente uma decisão.

Em caso de conflito:

1. ADR aprovado mais recente vence;
2. depois, a seção mais específica deste documento;
3. depois, a regra mais conservadora para qualidade, dimensão física e preservação de dados.

Não manter duas regras contraditórias ativas no código.

---

# PARTE I — ARQUITETURA

## 4. Local-first

A primeira versão deve rodar localmente.

Não implementar inicialmente:

- autenticação;
- Supabase;
- contas;
- permissões;
- cloud storage;
- pagamentos;
- multiusuário;
- deploy público obrigatório.

Sugestão de stack:

| Camada | Tecnologia |
|---|---|
| UI | Next.js + React + TypeScript |
| Estilo | Tailwind CSS |
| Estado de UI | Zustand |
| Banco local | SQLite |
| Imagens | Sharp / libvips |
| PDF | @pdfme/pdf-lib + LosslessPdfEngine próprio |
| Preview | Canvas |
| Processamento paralelo | Node Worker Threads |
| Arquivos | filesystem local |
| Testes | Vitest/Jest + testes de fixtures |
| E2E | Playwright |

A aplicação pode inicialmente rodar como web app local. Empacotamento desktop pode ser decidido posteriormente.

---

## 5. Estrutura sugerida

```text
TCGPrint/
├─ app/
│  ├─ projects/
│  ├─ editor/
│  ├─ import/
│  ├─ templates/
│  ├─ settings/
│  └─ export/
│
├─ core/
│  ├─ geometry/
│  ├─ units/
│  ├─ cards/
│  ├─ layouts/
│  └─ validation/
│
├─ importers/
│  ├─ universal/
│  ├─ text/
│  ├─ files/
│  ├─ urls/
│  ├─ csv/
│  ├─ json/
│  ├─ xml/
│  └─ zip/
│
├─ providers/
│  ├─ scryfall/
│  ├─ mpc/
│  └─ local/
│
├─ image-engine/
│  ├─ bleed/
│  ├─ crop/
│  ├─ quality/
│  ├─ previews/
│  └─ cache/
│
├─ pdf-engine/
│  ├─ document/
│  ├─ pages/
│  ├─ guides/
│  ├─ registration/
│  └─ duplex/
│
├─ cutter/
│  ├─ templates/
│  ├─ silhouette/
│  ├─ svg/
│  └─ dxf/
│
├─ persistence/
│  ├─ sqlite/
│  └─ projects/
│
├─ workers/
│
├─ tests/
│  ├─ fixtures/
│  ├─ geometry/
│  ├─ bleed/
│  ├─ pdf/
│  └─ importers/
│
└─ data/
   ├─ originals/
   ├─ processed/
   ├─ thumbnails/
   ├─ templates/
   ├─ exports/
   └─ database.sqlite
```

A estrutura final pode variar, mas os módulos devem permanecer desacoplados.

---

## 6. Separação entre Importer e Provider

Essa separação é obrigatória.

### Importer

Responde:

> O que o usuário forneceu e quais cartas/arquivos existem aqui?

Exemplos:

- Moxfield URL;
- TXT;
- CSV;
- XML;
- ZIP;
- pasta;
- PNG;
- SVG.

### Provider

Responde:

> De onde vêm os metadados e/ou imagens da carta?

Exemplos:

- Scryfall;
- MPC;
- arquivo local.

Fluxo:

```text
INPUT
  │
  ▼
Universal Import Engine
  │
  ├─ URL
  ├─ File
  ├─ Folder
  ├─ Clipboard
  └─ Drag & Drop
  │
  ▼
ImportResult
  │
  ▼
ProjectCard[]
  │
  ▼
Provider resolution, se necessário
```

O PDF Engine não deve saber se uma carta veio do Scryfall, MPC, SVG próprio ou PNG local.

---

# PARTE II — UNIDADES E GEOMETRIA

## 7. Milímetros como unidade canônica

Toda geometria física deve ser calculada internamente em milímetros.

Não usar pixels como unidade de posicionamento.

Exemplo:

```ts
const magicStandard = {
  widthMm: 63.5,
  heightMm: 88.9,
};
```

Converter apenas nas bordas do sistema:

- mm → pixels quando gerar raster;
- mm → PDF points quando gerar PDF;
- mm → unidades do formato de corte quando exportar.

Criar um módulo único para conversões.

---

## 8. Formato de carta

Modelo sugerido:

```ts
interface CardFormat {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  cornerRadiusMm?: number;
}
```

Primeiro formato:

```text
Magic Standard
63.5 × 88.9 mm
```

A arquitetura deve suportar posteriormente:

- Poker;
- Bridge;
- Tarot;
- Pokémon;
- Yu-Gi-Oh!;
- formatos personalizados.

---

## 9. Papel

Suporte inicial:

- A4;
- A3;
- Letter;
- Legal;
- Tabloid;
- Custom.

Um formato customizado precisa aceitar:

- largura;
- altura;
- orientação;
- margem superior;
- margem inferior;
- margem esquerda;
- margem direita.

---

# PARTE III — UNIVERSAL IMPORT ENGINE

## 10. Objetivo

Não criar um "importador do Scryfall".

Criar uma entrada universal que aceite texto, URLs e arquivos e tente identificar automaticamente o conteúdo.

A UI deve permitir:

```text
[ Colar texto ou URL ]

[ Importar arquivos ]
[ Importar pasta ]

Drag & Drop em toda a área relevante
```

---

## 11. Entradas suportadas

### Imagens raster

- PNG
- JPG / JPEG
- WebP
- TIFF

### Vetoriais

- SVG

SVG deve ser formato de primeira classe.

Sempre preservar o SVG original.

### Texto e decklists

- TXT
- texto colado
- Arena
- MTGO
- listas simples
- listas com quantidade
- listas com "x"
- seções de Commander
- formatos reconhecíveis de outras ferramentas

Exemplos válidos:

```text
Sol Ring
Mana Crypt
Island
```

```text
1 Sol Ring
1 Mana Crypt
10 Island
```

```text
1x Sol Ring
10x Island
```

```text
1 Sol Ring (CMM) 396
```

### Dados estruturados

- CSV
- TSV
- JSON
- XML

### Pacotes

- ZIP

### Magic / deck formats

Implementar adapters conforme necessidade para:

- Arena;
- MTGO;
- XMage;
- Scryfall CSV;
- TappedOut CSV;
- .mwDeck;
- MPC Autofill XML.

---

## 12. URLs

A UI deve aceitar uma URL em uma caixa única.

O sistema deve identificar o domínio e escolher um adapter quando houver suporte.

Alvos prioritários:

- Scryfall;
- Moxfield;
- Archidekt;
- CubeCobra;
- Deckstats;
- MTGGoldfish;
- MTGTop8;
- TappedOut;
- mtg.wtf;
- MPCFill/Autofill quando aplicável;
- URLs diretas de imagem;
- URLs diretas de TXT;
- URLs diretas de CSV;
- URLs diretas de XML;
- URLs diretas de JSON.

Regra:

```text
URL
 ↓
adapter conhecido?
 ├─ sim → adapter específico
 └─ não
      ↓
   arquivo direto?
      ↓
   detectar Content-Type
      ↓
   tentar importer genérico
```

Não prometer suporte para qualquer site arbitrário. Sites podem depender de login, Cloudflare ou HTML instável.

Os adapters de sites externos devem falhar de forma clara e isolada.

---

## 13. Detecção por conteúdo

Não confiar exclusivamente na extensão.

Exemplo:

```text
deck.txt
```

pode conter Arena, lista simples ou outro formato.

Criar detector com pontuação/confiança:

```text
SimpleList   100%
Arena         98%
MTGO          45%
Unknown        5%
```

Escolher automaticamente quando a confiança for alta.

Se houver ambiguidade, apresentar escolha na UI.

---

## 14. CSV Mapper

Tentar mapear automaticamente colunas comuns:

- name;
- card_name;
- quantity;
- count;
- set;
- set_code;
- collector_number;
- scryfall_id;
- image_url;
- language.

Caso seja um CSV desconhecido, permitir associação manual de colunas.

Exemplo:

```text
Nome       → card_name
Quantidade → quantity
Set        → set
Imagem     → image_url
```

Permitir salvar mappings posteriormente.

---

## 15. JSON Mapper

Detectar estruturas conhecidas.

Quando desconhecido, oferecer mapeamento de paths:

```text
cards[].name
cards[].quantity
cards[].image
```

O mapper deve ser genérico o suficiente para ajudar futuramente em outros TCGs.

---

## 16. ZIP

Permitir ZIP com:

- imagens;
- decks;
- XML;
- CSV;
- JSON;
- SVG;
- backs;
- metadata.

Exemplo:

```text
deck.zip
├─ deck.txt
├─ front/
│  ├─ card1.png
│  └─ card2.png
└─ back/
   ├─ card1.png
   └─ card2.png
```

Antes de importar, mostrar resumo.

Implementar limites razoáveis de tamanho/quantidade e impedir path traversal ao extrair ZIP.

---

## 17. Importação de pasta

Permitir selecionar uma pasta inteira.

Detectar automaticamente pares como:

```text
card-front.png
card-back.png
```

ou:

```text
card_front.svg
card_back.svg
```

Sempre permitir corrigir pareamento manualmente.

---

# PARTE IV — CARTAS PERSONALIZADAS

## 18. Custom cards são requisito do MVP

O usuário deve poder importar uma carta que não existe em banco externo.

Fontes válidas:

- PNG;
- JPEG;
- WebP;
- TIFF;
- SVG.

Modelo:

```text
Carta personalizada

Nome
Quantidade

Frente
Verso opcional

Formato
Magic Standard / Custom

Bleed
Herdar do projeto / Override
```

Uma imagem sem nome reconhecível deve continuar imprimível.

Exemplo:

```text
IMG_8372.png
→ Custom #37
```

---

## 19. Identidade da carta, frente/verso e arte atual

**Identidade da carta e imagem escolhida são conceitos separados.**

Uma carta pode ser identificada como `Sol Ring` e, sem recriar o item do projeto, usar:

- uma printing do Scryfall;
- uma arte do MPC Autofill;
- uma imagem enviada pelo usuário;
- outra arte local associada à mesma identidade.

Modelo sugerido:

```ts
interface CardIdentity {
  provider: "scryfall" | "manual" | "custom";
  name: string;

  // Para Magic, preferir IDs estáveis quando disponíveis.
  scryfallId?: string;
  oracleId?: string;

  // Usado principalmente quando a identidade foi inferida de um upload.
  resolutionMethod?:
    | "exact-id"
    | "filename"
    | "metadata"
    | "ocr"
    | "fuzzy"
    | "manual"
    | "unresolved";

  confidence?: number;
}
```

```ts
type ArtworkSource = "scryfall" | "mpc" | "upload" | "url" | "custom";

interface CardFace {
  id: string;

  artworkSource: ArtworkSource;
  selectedArtworkId?: string;

  sourceFile?: string;
  sourceUrl?: string;
  sourceHash: string;

  originalFormat: string;
  widthPx?: number;
  heightPx?: number;

  // Um upload pode estar ligado a uma carta conhecida.
  linkedIdentityId?: string;
}
```

```ts
interface ProjectCard {
  id: string;
  identity?: CardIdentity;
  quantity: number;

  front: CardFace;
  back?: CardFace;

  widthMm: number;
  heightMm: number;

  metadata?: Record<string, unknown>;
}
```

Regras:

- trocar a arte **não** troca a identidade da carta;
- corrigir a identidade **não** deve apagar a imagem enviada;
- uma carta customizada pode continuar sem identidade externa;
- uma imagem própria de uma carta conhecida deve poder ser vinculada a essa identidade;
- frente e verso podem ter fontes de arte diferentes quando necessário.

---

# PARTE V — SCRYFALL

## 20. Scryfall Provider

Scryfall será o principal provider de Magic, não a única forma de usar o programa.

Implementar:

- busca por nome;
- autocomplete;
- resolução por Scryfall ID;
- resolução por set + collector number;
- printings;
- idiomas;
- imagens;
- DFCs;
- tokens/related cards;
- cache local.

A seleção de arte deve ser visual.

Exemplo:

```text
Sol Ring

[arte] [arte] [arte] [arte]
 CMM    C21    LTC    ...
```

Filtros desejados:

- idioma;
- set;
- data;
- promo;
- digital;
- full-art;
- border;
- resolução;
- source.

---

## 21. Cache Scryfall

Implementar cache local desde o início.

Separar:

- metadata;
- thumbnails;
- originais.

Não baixar repetidamente a mesma imagem.

Respeitar rate limiting da API.

Quando o volume justificar, considerar Bulk Data.

---

# PARTE VI — MPC

## 22. MPC Autofill XML

Primeira integração MPC deve aceitar XML.

Preservar:

- ordem;
- slots;
- quantidade;
- IDs;
- frente;
- verso;
- arte escolhida.

Se o XML já identifica uma imagem específica, não substituir silenciosamente por uma arte do Scryfall.

---

## 23. MPC Artwork Provider

Implementar em fase posterior caso o acesso seja estável.

Objetivo:

- pesquisar arte por nome;
- exibir alternativas;
- filtrar por DPI/source/tags quando disponíveis;
- selecionar uma arte exatamente como no Scryfall.

Essa integração não deve bloquear o funcionamento do produto.

---

# PARTE VI-A — CARD IDENTITY & ARTWORK SOURCES

## 24. Regra central: identidade != arte

O sistema deve tratar cada item do projeto como uma **identidade de carta** com uma **arte selecionada**.

Exemplo:

```text
Identidade:
Sol Ring

Arte atual:
Upload próprio

Alternativas disponíveis:
Scryfall
MPC Autofill
Outros uploads ligados a Sol Ring
```

Isso é requisito estrutural, não apenas de UI.

O usuário deve conseguir trocar livremente a arte sem remover/reimportar a carta.

---

## 25. Artwork Source Switcher por carta

Na tela de detalhes de cada carta, disponibilizar:

```text
SOL RING

Identidade
Sol Ring                         [Alterar]

Fonte de arte
[ Todas ] [ Scryfall ] [ MPC Autofill ] [ Meus uploads ]

Arte atual
meu-sol-ring.png

Resultados
[arte] [arte] [arte] [arte] ...
```

Requisitos:

- fonte escolhida é individual por carta;
- não existe obrigação de usar uma única fonte para todo o projeto;
- a aba `Todas` agrega resultados dos providers disponíveis;
- cada resultado deve indicar claramente a origem;
- trocar de provider não deve perder a seleção atual até o usuário confirmar outra arte;
- o usuário pode voltar a uma arte anteriormente usada;
- favoritos/recentes podem ser adicionados futuramente sem alterar o modelo.

Exemplo válido de um único projeto:

```text
Sol Ring        → MPC Autofill
Rhystic Study   → Scryfall
Command Tower   → upload próprio
Treasure Token  → upload próprio
```

---

## 26. Artwork Catalog Aggregator

Criar uma camada acima dos providers:

```text
CardIdentity
     │
     ▼
ArtworkCatalog
     │
     ├─ ScryfallArtworkProvider
     ├─ MpcArtworkProvider
     └─ LocalArtworkProvider
     │
     ▼
ArtworkCandidate[]
```

Interface sugerida:

```ts
interface ArtworkCandidate {
  id: string;
  source: ArtworkSource;

  identityId?: string;

  previewUri: string;
  originalUri?: string;
  localOriginalPath?: string;

  widthPx?: number;
  heightPx?: number;
  effectiveDpi?: number;

  setCode?: string;
  collectorNumber?: string;
  language?: string;

  metadata?: Record<string, unknown>;
}

interface ArtworkProvider {
  searchArtwork(identity: CardIdentity): Promise<ArtworkCandidate[]>;
  getOriginal(candidateId: string): Promise<ImageSource>;
}
```

A UI não deve conhecer detalhes específicos da API de cada fonte.

---

## 27. Upload Card Resolver

Todo upload de imagem de carta deve tentar descobrir **qual carta aquela imagem representa**, sem obrigar o usuário a aceitar a sugestão.

Objetivo:

```text
upload meu-sol-ring-custom.png
          ↓
resolver identidade
          ↓
Sol Ring
          ↓
imagem entra como artwork local de Sol Ring
          ↓
usuário ainda pode trocar para Scryfall ou MPC
```

O upload não pode se tornar um "beco sem saída".

---

## 28. Pipeline de resolução de identidade de upload

Executar em ordem de custo/confiança.

### 1. IDs/metadados explícitos

Se o arquivo ou importador fornecer:

- Scryfall ID;
- oracle ID;
- set + collector number;
- nome explícito;
- metadata de projeto;

usar isso antes de qualquer inferência.

### 2. Nome do arquivo

Normalizar nomes como:

```text
Sol Ring.png
Sol_Ring_custom.png
01 - Sol Ring - alt art.jpg
Sol Ring [MPC].png
```

Remover padrões conhecidos:

- extensão;
- quantidade;
- `front/back`;
- `custom`;
- `proxy`;
- `alt art`;
- set/collector quando separáveis;
- prefixos numéricos.

Comparar com índice local/Scryfall.

### 3. OCR local

Quando filename/metadata não forem suficientes, tentar ler a região provável do nome da carta.

Prioridade inicial do OCR:

1. nome;
2. linha de tipo como sinal secundário;
3. collector/set apenas se ajudar na desambiguação.

OCR nunca deve alterar a imagem original.

### 4. Fuzzy matching

Exemplo:

```text
OCR: "SoI Ring"
        ↓
candidatos
        ↓
Sol Ring
```

Usar distância textual + sinais auxiliares.

### 5. Confirmação humana

Nunca transformar um resultado incerto em identidade definitiva silenciosamente.

Exemplo:

```text
Imagem: IMG_0231.png

Possíveis correspondências:
● Sol Ring                    92%
○ Sol Talisman                61%
○ Soul-Guide Lantern          43%

[Confirmar] [Escolher outra] [Manter como custom]
```

---

## 29. Confidence e estados de resolução

Estados sugeridos:

```ts
type IdentityResolutionStatus =
  | "resolved"
  | "suggested"
  | "ambiguous"
  | "unresolved"
  | "custom";
```

Regras sugeridas:

- match exato por ID → `resolved`;
- nome exato confiável → `resolved`;
- OCR/fuzzy → normalmente `suggested`;
- múltiplos candidatos próximos → `ambiguous`;
- nenhum candidato → `unresolved`;
- usuário escolheu manter sem vínculo → `custom`.

Os thresholds devem ser configurados e testados; não hardcodear uma porcentagem arbitrária como verdade universal.

---

## 30. UX de upload

Após upload de imagem:

```text
meu-sol-ring-custom.png

Carta sugerida
Sol Ring

Método
Nome do arquivo

[ Usar como arte de Sol Ring ]
[ Escolher outra carta ]
[ Manter como carta personalizada ]
```

Se o usuário confirmar `Sol Ring`:

```text
Identity = Sol Ring
Current artwork = meu-sol-ring-custom.png
Artwork source = upload
```

Imediatamente o Artwork Source Switcher deve permitir:

```text
[ Scryfall ] [ MPC Autofill ] [ Meus uploads ] [ Todas ]
```

---

## 31. Uploads reutilizáveis

Um upload ligado a uma identidade deve entrar na biblioteca local de artworks.

Exemplo:

```text
LocalArtworkLibrary
└─ Sol Ring
   ├─ meu-sol-ring-custom.png
   ├─ sol-ring-full-art.svg
   └─ sol-ring-foil-scan.tiff
```

Assim um artwork enviado em um projeto pode ser reutilizado em outro sem upload novamente.

Guardar:

- hash;
- caminho do original;
- identidade vinculada;
- data/import source;
- formato;
- dimensões;
- metadata.

Nunca duplicar fisicamente o mesmo arquivo quando o hash já existir.

---

## 32. Correção de identidade

O usuário deve conseguir clicar em:

```text
Identidade: Sol Ring [Alterar]
```

e mudar para outra carta.

Ao fazer isso:

- preservar o upload;
- remover apenas o vínculo anterior;
- oferecer vincular a imagem à nova identidade;
- atualizar candidatos de Scryfall/MPC;
- não destruir overrides de impressão sem necessidade.

---

## 33. DFC e faces

Uploads de cartas dupla-face precisam permitir:

```text
Identity: carta DFC conhecida

Front
→ upload próprio

Back
→ Scryfall
```

ou:

```text
Front
→ MPC

Back
→ MPC
```

Cada face tem artwork independente, mas ambas pertencem à mesma identidade lógica quando apropriado.

---

## 34. Testes obrigatórios do resolver

Criar fixtures para:

- filename exato;
- filename com `custom`;
- filename com quantidade;
- filename com `front/back`;
- OCR perfeito;
- OCR com erro pequeno;
- dois nomes ambíguos;
- carta inventada;
- token;
- DFC;
- imagem sem texto;
- SVG customizado.

Critérios:

- nunca sobrescrever identidade confirmada sem ação do usuário;
- nunca descartar upload por falha de reconhecimento;
- candidato incorreto deve poder ser corrigido;
- após mapear, Scryfall/MPC/uploads devem aparecer como fontes intercambiáveis.

---

# PARTE VII — IMAGE ENGINE

## 35. Regra de ouro

**O arquivo original nunca é modificado.**

Estrutura:

```text
data/
├─ originals/
├─ processed/
└─ thumbnails/
```

Qualquer transformação cria uma nova versão derivada.

---

## 36. Bleed

Bleed configurável:

```text
0.000 mm → 3.000 mm
```

Permitir entrada decimal livre.

Não fixar 3 mm como padrão.

Não criar um preset obrigatório "Alan Cha".

Quando um template importado tiver metadata/recomendação própria, o projeto pode guardar um bleed recomendado, mas o usuário deve continuar podendo alterá-lo.

---

## 37. Subtle Edge Stretch

Modo padrão de bleed.

Regra fundamental:

> A área de corte original da carta não pode ser ampliada, recortada ou deslocada para criar bleed.

Nunca fazer:

```text
imagem
 ↓
zoom
 ↓
crop
```

Fazer:

```text
canvas maior
 ↓
carta original colocada sem alteração no centro
 ↓
somente região externa é gerada
```

Visualmente:

```text
┌──────────────────────────────┐
│        BLEED EXTERNO         │
│  ┌────────────────────────┐  │
│  │                        │  │
│  │    CARTA ORIGINAL      │  │
│  │      INTACTA           │  │
│  │                        │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

---

## 38. Faixa de origem

O Edge Stretch deve usar uma faixa pequena da borda para que o esticamento seja discreto caso o corte passe ligeiramente da área original.

A largura da faixa fonte deve ser adaptativa e ajustável em modo avançado.

Não simplesmente esticar vários milímetros de conteúdo interno.

Possíveis controles:

- Auto;
- 0.25 mm;
- 0.50 mm;
- 0.75 mm;
- 1.00 mm;
- Custom.

Os valores finais devem ser definidos por testes visuais.

---

## 39. Cantos

Tratar separadamente:

```text
TL | TOP | TR
---+-----+---
L  |CARD | R
---+-----+---
BL | BOT | BR
```

Não deixar cantos com costuras evidentes.

Implementar estratégia própria para quatro cantos.

---

## 40. Outros modos de bleed

Suportar:

- Subtle Edge Stretch — fallback conservador;
- Smart Border Fill — automático para Scryfall raster quando aplicável;
- Mirror Edge;
- Solid/Edge Color Sample;
- Existing Bleed;
- None.

### Smart Border Fill

Objetivo:

> evitar que uma moldura externa preta/escura típica de scans Scryfall vire uma faixa de bleed preta dominante quando existe conteúdo visual adequado logo para dentro da borda.

O modo deve:

- classificar cada lado separadamente;
- detectar faixa escura/uniforme com limiares centralizados e testáveis;
- procurar a primeira faixa interna com informação visual suficiente dentro de um limite físico configurável;
- usar essa faixa apenas para sintetizar a região externa;
- nunca tocar nos pixels do trim;
- usar fallback para Subtle Edge Stretch quando a confiança for insuficiente;
- manter cantos determinísticos e sem costuras;
- ser versionado para reprodutibilidade;
- registrar a política efetiva no resultado/manifest quando disponível.

Não usar preenchimento generativo remoto nem reconstruir partes da carta dentro do trim.

---

## 41. Bleed e imagens já preparadas

Não tentar decidir tudo por uma heurística invisível.

Cada imagem pode ter política:

```text
Usar área inteira
Normalizar para trim
Imagem já contém bleed
Crop manual
```

Providers podem fornecer defaults, mas o usuário pode sobrescrever.

---

## 42. Teste obrigatório de integridade

Criar teste automatizado:

1. carregar imagem;
2. gerar bleed;
3. extrair região correspondente à carta original;
4. comparar com original.

Resultado obrigatório:

```text
original trim area == output trim area
```

O teste deve cobrir:

- 0 mm;
- 0.625 mm;
- 1 mm;
- 2 mm;
- 3 mm.

Não exigir identidade de bytes do arquivo inteiro; exigir identidade de pixels da área útil quando a pipeline permitir.

---

# PARTE VIII — LAYOUT ENGINE

## 43. Modos de layout

O engine deve suportar três modos:

```text
○ Automático
○ Manual
○ Baseado em template
```

### Automático

Calcular automaticamente linhas/colunas pelo espaço disponível considerando:

- tamanho da folha;
- margens;
- formato da carta;
- bleed;
- gaps;
- registration marks;
- reserved zones;
- template ativo.

Não hardcode:

```text
A4 = 3 × 3
```

### Manual

O usuário define explicitamente:

- número de colunas;
- número de linhas;
- orientação da página;
- orientação das cartas.

Exemplos válidos:

```text
4 × 2 em folha horizontal
2 × 4 em folha vertical
3 × 3
5 × 2
1 × 8
```

Isso é requisito importante para plotter/Silhouette e fluxos de corte específicos.

### Baseado em template

Quando houver template de corte, a geometria do template pode definir os slots e posições exatas.

---

## 44. LayoutRequest

Modelo sugerido:

```ts
type LayoutMode = "auto" | "manual" | "template";

interface LayoutRequest {
  mode: LayoutMode;

  paper;
  margins;
  cardFormat;

  bleedMm: number;
  horizontalGapMm: number;
  verticalGapMm: number;

  pageOrientation: "portrait" | "landscape";
  cardOrientation: "portrait" | "landscape";

  manualColumns?: number;
  manualRows?: number;

  reservedZones;
  templateGeometry?;
}
```

---

## 45. Validação do layout manual

Mesmo no modo manual, o sistema deve validar se a grade escolhida cabe fisicamente.

Validar:

- largura total;
- altura total;
- margens;
- bleed;
- gaps;
- registration marks;
- reserved zones;
- limites do template.

Se não couber, mostrar o motivo e impedir export incorreto.

Exemplo:

```text
Layout 4 × 3 não cabe em A4 horizontal.

Excesso horizontal: 2.41 mm
Excesso vertical: 0.00 mm
```

Não corrigir silenciosamente reduzindo cartas, DPI ou escala física.

---

## 46. Orientações independentes

Separar:

- orientação da página;
- orientação das cartas;
- orientação das registration marks;
- orientação/flip do duplex.

Exemplo válido:

```text
Página: Landscape
Grid: 4 × 2
Cartas: Portrait
Registration: Landscape
Duplex flip: Long edge
```

---

## 47. Espaçamento

Configurar independentemente:

- gap horizontal;
- gap vertical.

Permitir valores decimais em mm.

---

## 48. Slots desativados

Permitir skip de posições.

Exemplo:

```text
[1][2][3]
[4][X][5]
[6][7][8]
```

Útil para registration marks e layouts especiais.

---

# PARTE IX — CUT GUIDE ENGINE

## 49. Tipos de guia

Implementar:

- cantos;
- laterais;
- cruz;
- linha completa;
- guilhotina;
- nenhum.

Configurações:

- cor;
- espessura;
- opacidade;
- estilo;
- comprimento externo;
- comprimento interno;
- distância da carta.

Tudo deve ser definido em unidades físicas.

---

## 50. Guias vetoriais

As linhas de corte no PDF devem ser vetoriais.

Espessura em mm/points, não pixels.

---

## 51. Guilhotina

Modo de linhas contínuas ao longo da folha para facilitar:

- guilhotina;
- refiladora;
- cortador rotativo.

---

# PARTE X — SILHOUETTE E TEMPLATES

## 52. Template Library

Criar biblioteca local de templates.

Aceitar upload múltiplo de:

- .studio3
- .dxf
- .svg
- .json
- .zip

Campos:

- nome;
- origem;
- versão;
- papel;
- formato de carta;
- orientação;
- bleed recomendado opcional;
- registration type;
- arquivos associados;
- hash.

---

## 53. .studio3

Tratar .studio3 como arquivo oficial/opaco associado ao template.

Não fazer engenharia reversa do formato como requisito do projeto.

Armazenar intacto:

- arquivo;
- nome;
- hash;
- metadata;
- versão.

Se necessário, permitir "Abrir/mostrar arquivo para usar no Silhouette Studio".

---

## 54. DXF e SVG

Quando houver DXF/SVG correspondente, usar como geometria legível.

Objetivos:

- obter posições de corte;
- obter paths;
- obter dimensões;
- gerar preview;
- alinhar PDF.

Quando não houver, permitir configuração manual da geometria do template e salvar metadata.

---

## 55. Template Package

Representação sugerida:

```text
Alan-A4-Standard/
├─ template.studio3
├─ template.dxf
└─ template.json
```

Exemplo de metadata:

```json
{
  "name": "A4 Standard",
  "source": "Alan Cha / SCM",
  "paper": "a4",
  "cardFormat": "standard",
  "orientation": "landscape",
  "recommendedBleedMm": 0.625,
  "registration": "3-point"
}
```

A metadata não deve alterar o .studio3 original.

---

## 56. Versionamento de template

Projeto deve armazenar:

- template ID;
- versão;
- hash.

Um projeto criado com template v5 não deve passar automaticamente para v6.

Isso é necessário para reimpressões reproduzíveis.

---

## 57. Registration marks

Suportar:

- 3 pontos;
- 4 pontos;
- custom;
- none.

Separar:

- orientação da folha/cartas;
- orientação do sistema de registration.

Criar reserved/no-card zones no layout.

---

# PARTE XI — PDF ENGINE

## 58. LosslessPdfEngine — requisito obrigatório

O PDF final é parte crítica do produto. O objetivo **não é economizar espaço em disco**. O objetivo é preservar toda a informação disponível na fonte.

A implementação não deve usar uma biblioteca de PDF como caixa-preta para decidir resize, recompressão ou otimização das cartas.

Usar `@pdfme/pdf-lib` (fork mantido de pdf-lib) como base para a estrutura do PDF e implementar uma camada própria chamada, por exemplo, `LosslessPdfEngine`, responsável pela incorporação das imagens.

Regras obrigatórias:

- nunca reduzir resolução automaticamente;
- nunca downsamplear;
- nunca recomprimir JPEG para outro JPEG;
- nunca converter imagem de alta resolução para uma resolução fixa;
- nunca rasterizar a folha inteira;
- nunca gerar o PDF final a partir dos thumbnails;
- preservar SVG como vetor sempre que tecnicamente possível;
- qualquer processamento necessário deve ser lossless;
- tamanho de arquivo grande é aceitável;
- fidelidade é mais importante que tamanho do PDF.

Não gerar:

```text
Canvas gigante
→ Screenshot
→ JPEG/PNG da folha
→ PDF
```

Montar o PDF diretamente:

```text
PDF Page
├─ image XObjects das cartas
├─ SVG/vetores quando aplicável
├─ cut guides vetoriais
├─ registration marks vetoriais
└─ labels opcionais
```

---

## 59. Política por formato de imagem

### JPEG

Quando a carta JPEG não precisar de transformação:

```text
JPEG original bytes
      ↓
PDF Image XObject / DCTDecode
```

O stream JPEG original deve ser incorporado diretamente ao PDF.

**Não decodificar e reencodar o JPEG.**

Isso preserva exatamente o conteúdo JPEG que foi baixado/importado, sem nova perda geracional.

O tamanho físico impresso é definido somente pela transformation matrix do PDF; alterar a dimensão física desenhada na página **não implica redimensionar os pixels da imagem**.

### PNG

PDF não incorpora o container PNG da mesma forma que JPEG/DCT.

Para PNG:

- manter a resolução nativa completa;
- não resamplear;
- decodificar os pixels;
- armazenar RGB/Gray/Alpha usando compressão Flate lossless;
- preservar alpha quando existir;
- não transformar em JPEG.

O arquivo PNG dentro do PDF pode não ter o mesmo número de bytes do arquivo .png original, mas os pixels devem permanecer lossless e na resolução original.

### SVG

SVG deve permanecer vetorial sempre que seus recursos forem suportados pelo pipeline.

Não rasterizar SVG por conveniência.

Se um SVG utilizar recurso incompatível e realmente precisar ser rasterizado:

- preservar o arquivo SVG original;
- gerar derivado somente para export;
- usar resolução definida a partir da necessidade física, sem limite artificial de DPI;
- informar essa rasterização no diagnóstico/export summary.

### WebP / TIFF e outros formatos não nativos do PDF

Nunca converter para JPEG por padrão.

Pipeline:

```text
source
→ decode em resolução original
→ representação lossless RGB/Gray/Alpha
→ Flate no PDF
```

Se houver suporte direto lossless ao formato no futuro, preferir o caminho direto.

---

## 60. Imagens que precisam de bleed/processamento

Quando não houver bleed ou transformação, usar o caminho mais direto possível descrito acima.

Quando houver `Subtle Edge Stretch`, é inevitável criar uma imagem derivada maior porque novos pixels precisam existir fora da área original.

Regra:

```text
original
      ↓
decode uma única vez
      ↓
canvas maior
      ↓
copiar trim original sem resampling
      ↓
gerar somente os pixels externos de bleed
      ↓
armazenar derivado lossless
      ↓
PDF
```

Para JPEG de origem:

- não salvar o derivado novamente como JPEG;
- gerar o derivado em formato/pixel stream lossless;
- a região da carta deve corresponder exatamente aos pixels JPEG decodificados originalmente;
- somente a região externa do bleed é nova.

Portanto:

```text
SEM BLEED:
JPEG original → stream JPEG original no PDF

COM BLEED:
JPEG original → decode → composição lossless → PDF lossless
```

Não existe modo de criar novos pixels de bleed e simultaneamente manter o arquivo JPEG original inteiro como o único bitmap renderizado; por isso o caminho com bleed deve priorizar ausência de perda, não tamanho.

---

## 61. Proibição de otimizações destrutivas

Não implementar no export final:

- quality=80/90/95;
- resize automático;
- thumbnail substitution;
- JPEG recompression;
- WebP lossy intermediário;
- limite automático de 300/600/800 DPI;
- "optimize images";
- "reduce PDF size";
- qualquer conversão destrutiva silenciosa.

Se um dia for criado um modo de PDF reduzido, deve ser uma opção separada e explicitamente ativada pelo usuário.

O modo padrão e principal é:

```text
MAXIMUM / SOURCE QUALITY
```

---

## 62. Verificação de preservação

Criar testes específicos do `LosslessPdfEngine`.

### JPEG passthrough

Extrair o stream DCT do PDF de teste e validar:

```text
SHA256(JPEG original)
==
SHA256(DCT stream incorporado)
```

quando não houver processamento.

### PNG

Renderizar/extrair pixels e validar:

```text
dimensions original == dimensions embedded
pixel data original == pixel data embedded
```

Nenhum resampling.

### Bleed

Validar:

```text
trim pixels before
==
trim pixels after bleed
```

### SVG

Verificar que o PDF contém operadores/paths vetoriais e que não foi substituído por bitmap quando o SVG for compatível.

---

## 63. DPI efetivo

Exibir DPI real baseado em:

- pixel dimensions;
- tamanho físico de impressão.

Exemplo:

```text
745 × 1040 px
63.5 × 88.9 mm
≈ 298 DPI
```

Não alterar o arquivo para atingir um DPI escolhido.

DPI é um diagnóstico da relação entre pixels existentes e tamanho físico, não uma meta de resampling.

---

## 64. Indicador de qualidade

Sugestão:

```text
600+ DPI   Excelente
300+ DPI   Boa
200–299    Aviso
<200       Baixa
```

Informativo, não bloqueante.

---

## 65. Resolução / DPI de saída

**Não existir limite de resolução no modo padrão.**

Default obrigatório:

```text
Máxima / Original / Sem downsampling
```

Quando o usuário quiser definir manualmente uma resolução de processamento/rasterização para casos em que ela seja necessária, oferecer:

```text
Original / Sem limite
300 DPI
600 DPI
800 DPI
1000 DPI
1200 DPI
Custom
```

Regras:

- `Original / Sem limite` continua sendo o padrão;
- selecionar 1200 DPI nunca deve fazer upscale destrutivo ou inventar detalhe em uma imagem raster menor;
- para imagens já acima de 1200 DPI efetivos, o modo `Original / Sem limite` preserva toda a resolução;
- DPI configurado só deve afetar etapas que realmente precisem rasterizar/processar;
- JPEG passthrough sem transformação continua usando o stream original;
- SVG continua vetorial sempre que possível;
- não reduzir imagens automaticamente apenas para atingir um preset;
- o usuário pode escolher até 1200 DPI explicitamente quando quiser um pipeline raster de alta resolução.

Se futuramente houver um modo de arquivo reduzido, ele deve ficar separado do modo de produção e nunca ser o default.

---

# PARTE XII — PREVIEW

## 66. Preview separado do export

Preview deve usar thumbnails/cache.

Nunca carregar todas as imagens originais gigantes simultaneamente.

Mostrar:

- folha;
- cartas;
- bleed;
- trim;
- guias;
- registration marks;
- reserved zones;
- slots desativados.

Zoom:

- 25%;
- 50%;
- 100%;
- 200%;
- 400%.

O preview nunca deve ser a fonte do PDF final.

---

## 67. Galerias virtualizadas

Galerias de printings e listas grandes devem renderizar apenas itens visíveis + buffer.

Isso é importante para cartas com muitas printings e projetos com centenas de cards.

---

# PARTE XIII — PROJETOS

## 68. Persistência

SQLite.

Tabelas sugeridas:

- projects;
- project_cards;
- card_faces;
- artworks;
- cached_images;
- templates;
- template_files;
- printer_profiles;
- app_settings;
- exports.

---

## 69. Autosave

Salvar automaticamente:

- cartas;
- ordem;
- quantidade;
- arte escolhida;
- faces;
- backs;
- backMode por carta;
- sinalização/estado DFC;
- overrides manuais de front/back;
- verso padrão do projeto;
- tamanho;
- bleed;
- overrides;
- papel;
- layout;
- template;
- guides;
- printer profile;
- export settings.

---

## 70. Undo / Redo

Suportar:

- trocar arte;
- mover carta;
- deletar;
- adicionar;
- alterar quantidade;
- alterar layout;
- alterar bleed;
- alterar override.

---

# PARTE XIII-A — BACKS, DFC E SINALIZAÇÃO DE DUPLA FACE

## 71. Back selection por carta

Cada carta deve permitir configurar explicitamente o verso.

Estados possíveis:

```text
Back mode
○ Automático
○ Verso padrão do projeto
○ Escolher manualmente
○ Nenhum
```

A seleção manual pode usar:

- Scryfall;
- MPC Autofill;
- upload próprio;
- biblioteca local de backs;
- verso padrão do projeto.

Modelo sugerido:

```ts
type BackMode =
  | "auto"
  | "project-default"
  | "manual"
  | "none";

interface CardSideSelection {
  artworkSource:
    | "scryfall"
    | "mpc"
    | "upload"
    | "local"
    | "project-default";

  artworkId?: string;
  fileId?: string;
  autoResolved?: boolean;
}

interface ProjectCard {
  id: string;
  identity?: CardIdentity;
  quantity: number;

  front: CardSideSelection;
  back?: CardSideSelection;

  isDoubleFaced: boolean;
  backMode: BackMode;

  widthMm: number;
  heightMm: number;
}
```

---

## 72. Detecção e sinalização de cartas dupla-face

Toda carta identificada como dupla-face deve ser marcada visualmente na interface.

A sinalização precisa aparecer em:

- lista principal de cartas;
- detalhes da carta;
- seletor de arte;
- preview;
- validação pré-export.

Exemplo de lista:

```text
1  Sol Ring                         Scryfall
1  Fable of the Mirror-Breaker  ⇄   Scryfall
1  Delver of Secrets            ⇄   MPC
1  Custom Card                      Upload
```

O símbolo final pode ser definido na implementação, mas deve ser:

- simples;
- legível;
- não decorativo;
- acompanhado de tooltip/texto acessível como "Carta dupla-face".

Não depender somente de cor.

No detalhe:

```text
Fable of the Mirror-Breaker
[ Carta dupla-face ]

FRONT
[ artwork ]

BACK
[ artwork ]
```

Se a identidade vier do Scryfall e o layout da carta possuir duas faces, marcar automaticamente `isDoubleFaced = true`.

Para uploads próprios, o resolver pode sugerir DFC quando:

- a identidade resolvida for uma DFC conhecida;
- houver arquivos pareados front/back;
- metadata indicar duas faces.

O usuário pode corrigir manualmente quando necessário.

---

## 73. Resolução automática de back para DFC

Ao identificar uma DFC conhecida:

```text
CardIdentity
    ↓
provider metadata
    ↓
face A + face B
    ↓
front auto-resolved
back auto-resolved
```

Regras:

- preencher frente e verso automaticamente quando disponíveis;
- manter ambas ligadas à mesma identidade lógica;
- permitir trocar a fonte de cada face de forma independente;
- permitir front do Scryfall + back do MPC;
- permitir front do MPC + back de upload;
- permitir qualquer outra combinação válida.

Exemplo:

```text
DFC: Delver of Secrets // Insectile Aberration

Front source:
Scryfall

Back source:
MPC Autofill
```

---

## 74. Overrides e proteção contra sobrescrita

Se o usuário selecionar manualmente um verso, marcar a seleção como override.

Depois disso:

- refresh de metadata não pode sobrescrever silenciosamente;
- troca de provider não pode apagar o verso manual;
- reabertura do projeto deve preservar a seleção;
- re-resolução automática deve pedir confirmação se conflitar com override.

Estado sugerido:

```ts
interface SideResolutionState {
  mode: "auto" | "manual";
  lockedByUser: boolean;
}
```

---

## 75. Verso padrão do projeto

Configuração global:

```text
Verso padrão do projeto

○ Nenhum
○ Biblioteca local
○ Upload custom
○ Back padrão selecionado
```

Regras:

- cartas normais herdam o verso padrão quando `backMode = project-default`;
- DFCs conhecidas usam a própria face traseira quando `backMode = auto`;
- qualquer carta pode sobrescrever individualmente;
- mudar o verso padrão do projeto não altera overrides manuais.

---

## 76. Biblioteca de backs

Criar biblioteca local reutilizável.

Exemplo:

```text
Back Library
├─ MTG Back
├─ ProxyBembem Back
├─ Black Back
├─ White Back
└─ Custom uploads
```

Cada item deve preservar:

- original;
- hash;
- dimensões;
- formato;
- nome;
- metadata opcional.

Sem recompressão destrutiva.

---

## 77. Preview de frente e verso

O preview precisa permitir alternar:

```text
[ Frente ] [ Verso ]
```

e, opcionalmente:

```text
[ Lado a lado ]
```

Para DFC, deixar evidente:

```text
Front face ↔ Back face
```

A visualização do verso deve usar a mesma lógica de layout que o export correspondente.

---

## 78. Modos de exportação

Na tela de export:

```text
Conteúdo

○ Somente frente
○ Somente verso
○ Frente + verso separados
○ Duplex
```

### Somente frente

Gera apenas páginas de front.

Exemplo:

```text
Commander_front.pdf
```

### Somente verso

Gera somente o layout dos backs.

Exemplo:

```text
Commander_back.pdf
```

Esse modo é obrigatório para permitir reimpressão de verso sem refazer as frentes.

### Frente + verso separados

Gera:

```text
Commander_front.pdf
Commander_back.pdf
```

### Duplex

Gera páginas ordenadas/espelhadas conforme o modo de impressão duplex e configuração da impressora.

Pode ser um único PDF intercalado:

```text
front page 1
back page 1
front page 2
back page 2
...
```

A escolha entre PDFs separados e duplex não pode alterar as artes escolhidas.

---

## 79. Cards sem back no export de verso

O comportamento deve ser configurável.

Opções:

```text
Quando uma carta não possui back:

○ usar verso padrão do projeto
○ deixar slot em branco
○ gerar aviso e continuar
○ bloquear export
```

Default sugerido para uso local:

```text
usar verso padrão do projeto, se existir;
caso contrário, deixar em branco e avisar.
```

Nunca inventar um back silenciosamente.

---

## 80. Validação pré-export para DFC/backs

Antes de exportar `back`, `front + back` ou `duplex`, mostrar:

```text
100 cartas

12 cartas dupla-face
88 cartas simples

Backs:
12 automáticos de DFC
80 usando verso padrão
5 overrides manuais
3 sem verso
```

Os itens sem verso devem aparecer como warning clicável.

---

## 81. Testes obrigatórios

Criar testes para:

- carta normal + verso padrão;
- carta normal + verso manual;
- DFC Scryfall com auto front/back;
- DFC com front Scryfall + back MPC;
- DFC com front upload + back Scryfall;
- override manual preservado;
- front-only export;
- back-only export;
- front/back separados;
- duplex;
- slots sem back;
- alteração do verso padrão sem afetar overrides;
- sinalização visual/acessível de DFC.

Critério de conclusão:

> uma carta DFC é detectada e sinalizada, recebe automaticamente suas duas faces quando disponíveis, permite override independente por face e pode ser exportada corretamente em front-only, back-only, separado ou duplex.

---

# PARTE XIV — DUPLEX

## 82. Mirror e page pairing

A seleção de fronts/backs e os modos de exportação estão definidos na PARTE XIII-A.

O módulo Duplex é responsável especificamente pela geometria e ordenação física das páginas traseiras.

Implementar cálculo correto baseado em:

- orientação;
- long-edge / short-edge;
- layout;
- posição do slot;
- printer profile;
- template de corte;
- skips/reserved zones.

Criar testes de correspondência frente/verso com fixtures numeradas.

---

# PARTE XV — CALIBRAÇÃO DE IMPRESSORA E REGISTRO FRENTE/VERSO

## 83. Objetivo

Impressão duplex pode apresentar desalinhamento entre frente e verso mesmo quando o PDF está geometricamente correto.

O programa deve tratar isso como **registro de impressão**, separado do layout das cartas.

Problemas a corrigir:

- deslocamento horizontal;
- deslocamento vertical;
- rotação;
- diferença de escala horizontal;
- diferença de escala vertical;
- pequeno skew/shear quando necessário.

A calibração nunca deve alterar o tamanho nominal da carta no projeto. Ela é uma transformação aplicada à página/lado no momento do export.

---

## 84. Precisão dos ajustes

Todos os offsets lineares devem aceitar entrada manual com precisão mínima de:

```text
0.001 mm
```

Exemplos:

```text
+0.001 mm
-0.037 mm
+0.125 mm
-0.683 mm
+1.247 mm
```

Não limitar o usuário a passos de 1 mm ou 0.1 mm.

A interface deve oferecer nudges:

```text
Micro   ±0.001 mm
Fine    ±0.010 mm
Normal  ±0.100 mm
Coarse  ±1.000 mm
```

O campo continua aceitando valor digitado livremente.

**Importante:** aceitar 0.001 mm não significa que a impressora possua repetibilidade mecânica de 1 micrômetro. A granularidade fina serve para não introduzir uma limitação artificial no software e para permitir encontrar o melhor ajuste médio possível.

---

## 85. Representação interna de alta precisão

Para evitar acúmulo de erro por arredondamento em ajustes muito pequenos, preferir armazenar offsets de calibração como inteiro em micrômetros ou Decimal.

Exemplo:

```text
1 µm = 0.001 mm

-683 µm = -0.683 mm
```

A UI continua mostrando milímetros.

A geometria física geral do projeto continua sendo expressa em mm; esta representação de micrômetros é específica para valores finos de calibração.

---

## 86. Ajustes independentes por lado

Permitir configurar frente e verso separadamente.

Modelo sugerido:

```ts
interface SideCalibration {
  offsetXUm: number;
  offsetYUm: number;

  rotationDeg: number;

  scaleX: number;
  scaleY: number;

  skewXDeg?: number;
  skewYDeg?: number;
}

interface PrinterProfile {
  id: string;
  name: string;

  front: SideCalibration;
  back: SideCalibration;

  paperSize: string;
  pageOrientation: "portrait" | "landscape";

  duplexMode:
    | "manual-long-edge"
    | "manual-short-edge"
    | "automatic-long-edge"
    | "automatic-short-edge"
    | "single-sided";

  mediaType?: string;
  printQualityProfile?: string;
  feedSource?: string;

  notes?: string;
}
```

Default:

```text
Front = identidade / sem correção
Back  = correção relativa à frente
```

Mas a arquitetura permite corrigir ambos quando necessário.

---

## 87. Offset X/Y

Controles básicos:

```text
BACK OFFSET

X: -0.683 mm
Y: +0.247 mm
```

Convenção visual deve ser inequívoca:

```text
+X → direita
-X → esquerda

+Y → cima
-Y → baixo
```

Mostrar essa convenção na própria UI.

A transformação deve respeitar a orientação física da página traseira após o flip escolhido.

---

## 88. Rotação

Um simples X/Y não resolve quando um canto está alinhado e o outro não.

Permitir:

```text
Rotation
+0.000°
```

Entrada manual de alta precisão.

Sugestão de step:

```text
0.001°
```

A rotação deve ser aplicada em torno do centro físico da página ou de uma âncora explicitamente definida.

Não rotacionar individualmente cada carta para corrigir registro de folha.

---

## 89. Escala X/Y

Se o topo estiver alinhado mas houver erro crescente em direção ao fim da página, pode existir diferença de escala/alimentação.

Permitir:

```text
Scale X: 1.000000
Scale Y: 1.000000
```

ou UI equivalente:

```text
Scale X correction: +0.0000 %
Scale Y correction: +0.0000 %
```

X e Y devem ser independentes.

Nunca confundir esta calibração com resize das imagens ou redução do tamanho nominal das cartas.

A escala é aplicada à geometria da página de impressão para corrigir registro físico.

---

## 90. Skew / shear avançado

Modo avançado opcional.

Usar somente quando medições indicarem que translation + rotation + scale não conseguem alinhar todos os pontos.

Permitir correção de skew/shear pequena.

Não expor isso no modo básico.

---

## 91. Perfil específico por condições de impressão

O mesmo offset pode mudar conforme:

- impressora;
- tamanho do papel;
- orientação;
- tipo/espessura do papel;
- bandeja/feed source;
- qualidade/modo do driver;
- long-edge vs short-edge;
- forma como a folha é recolocada em duplex manual.

Portanto não ter apenas um "offset global".

Exemplos de profiles:

```text
Epson L1250 — A4 Photo Paper — Landscape — Manual Long Edge
Epson L1250 — A4 Matte — Portrait — Manual Long Edge
Epson L1250 — Letter — Portrait — Manual Short Edge
```

O projeto referencia o profile utilizado.

---

## 92. Calibration sheet

Gerar folha específica para medir registro.

Incluir:

- cruz central;
- alvos nos quatro cantos;
- réguas X/Y;
- grids;
- identificadores front/back;
- marcas de rotação;
- escalas para detectar crescimento de erro;
- instrução de flip/reinserção.

A frente e o verso devem usar marcas complementares que possam ser comparadas contra luz.

---

## 93. Calibration Wizard

Fluxo recomendado:

```text
1. Escolher impressora/profile
2. Escolher papel e orientação
3. Escolher long-edge / short-edge
4. Gerar Calibration PDF
5. Imprimir frente
6. Recolocar folha exatamente como indicado
7. Imprimir verso
8. Medir pontos
9. Informar desvios
10. Calcular transformação
11. Gerar Verification PDF
12. Repetir ajuste fino se necessário
13. Salvar profile
```

---

## 94. Modos de calibração

### Simple

Usuário informa somente:

```text
X
Y
Rotation
```

Adequado para a maioria dos casos.

### Advanced

Usar medições de:

- centro;
- top-left;
- top-right;
- bottom-left;
- bottom-right.

Com esses pontos, o sistema estima:

- X/Y;
- rotação;
- scale X;
- scale Y;
- skew quando necessário.

Não obrigar o usuário a calcular manualmente os parâmetros.

---

## 95. Ajuste visual interativo

A tela de calibração deve permitir overlay:

```text
Front
+
Back com opacidade
```

e controles:

```text
X       [-] -0.683 mm [+]
Y       [-] +0.247 mm [+]
Rotate  [-] +0.031°   [+]
Scale X     1.000120
Scale Y     0.999870
```

Adicionar seletor de step:

```text
[1 mm] [0.1 mm] [0.01 mm] [0.001 mm]
```

Isso permite ajuste rápido grosso e depois refinamento fino.

---

## 96. Aplicação no PDF

A calibração deve ser aplicada através de transformação geométrica do conteúdo da página.

Não:

- reamostrar as imagens;
- reduzir DPI;
- recomprimir;
- alterar originals.

Para translation/rotation/scale no PDF, usar transformation matrix do conteúdo sempre que possível.

Assim uma JPEG em passthrough continua com seus pixels originais e apenas sua posição física muda.

---

## 97. Ordem das transformações

Definir e testar explicitamente a ordem.

Sugestão:

```text
Layout nominal
      ↓
Duplex mirror/flip
      ↓
Scale calibration
      ↓
Skew calibration
      ↓
Rotation calibration
      ↓
X/Y translation
      ↓
PDF page
```

Não espalhar correções em vários módulos.

Um único `PrintCalibrationTransform` deve produzir a transformação final.

---

## 98. Tolerância e repetibilidade

A UI deve distinguir:

```text
Configured correction
vs
Observed repeatability
```

Exemplo:

```text
Correction:
X -0.683 mm
Y +0.247 mm

Últimos testes:
variação X ≈ 0.10 mm
variação Y ≈ 0.18 mm
```

Se a impressora variar mecanicamente de folha para folha, não tentar "corrigir" isso aumentando artificialmente a precisão matemática.

Permitir armazenar várias medições e mostrar média/min/max futuramente.

---

## 99. Presets e duplicação de profile

Permitir:

- criar;
- duplicar;
- renomear;
- exportar/importar;
- selecionar por projeto.

Nunca alterar retroativamente um projeto antigo sem confirmação se o profile tiver sido recalibrado.

Guardar versão/hash ou snapshot dos valores usados no export.

---

## 100. Testes obrigatórios de calibração

Testar:

- +X / -X;
- +Y / -Y;
- 0.001 mm;
- valores fracionários arbitrários;
- rotação positiva/negativa;
- scale X/Y;
- long-edge;
- short-edge;
- portrait;
- landscape;
- front-only;
- back-only;
- duplex;
- combinação com template de corte;
- combinação com registration marks.

Também validar que aplicar apenas translation/rotation/scale por matriz PDF não altera os pixels/streams das imagens quando não houver outro processamento.

---

# PARTE XVI — PERFORMANCE

## 101. Cache por hash

Exemplo de chave:

```text
SHA256(
  source-image-hash +
  bleed-mode +
  bleed-width +
  source-strip +
  processing-options
)
```

Se a mesma derivação já existe, reutilizar.

---

## 102. Worker Threads

Usar processamento concorrente controlado para:

- bleed;
- thumbnails;
- rasterizações;
- batches.

Nunca abrir um worker por carta sem limite.

Pool baseado em CPU/memória.

---

## 103. Escalas de teste

Testar:

- 9 cartas;
- 100 cartas;
- 500 cartas;
- 1000 cartas.

Medir:

- tempo de import;
- uso de memória;
- tempo de preview;
- tempo de export;
- tamanho de PDF.

---

# PARTE XVII — UX

## 104. Editor principal

Estrutura conceitual:

```text
┌─────────────────────────────────────────────────────────────┐
│ TCGPrint      Projeto                           Exportar     │
├──────────────┬──────────────────────────┬───────────────────┤
│ CARTAS       │                          │ CONFIGURAÇÕES     │
│              │      PREVIEW             │                   │
│ Sol Ring     │                          │ Papel             │
│ Island       │      [ páginas ]         │ Bleed             │
│ Forest       │                          │ Template          │
│ ...          │                          │ Corte             │
│              │                          │ Qualidade         │
│ + Importar   │                          │                   │
└──────────────┴──────────────────────────┴───────────────────┘
```

---

## 105. Básico vs avançado

Modo básico:

- papel;
- bleed;
- template;
- guides;
- qualidade;
- export.

Modo avançado:

- source strip do bleed;
- corner strategy;
- offsets;
- gaps;
- registration geometry;
- compression;
- individual card overrides.

Evitar uma UI com dezenas de controles abertos ao mesmo tempo.

---

# PARTE XVIII — EXPORTAÇÃO

## 106. Formatos

Exportar:

- PDF;
- PNG sheets;
- imagens individuais;
- SVG cut file;
- DXF cut file.

Quando um template .studio3 estiver associado, manter o arquivo disponível junto ao projeto/export.

---

## 107. Verificação pré-export

Mostrar resumo:

```text
100 cartas
12 páginas
A4
Magic Standard 63.5 × 88.9 mm
Bleed 0.625 mm

3 imagens abaixo de 300 DPI

Template
A4 Standard v5

Registration
3-point
```

Warnings devem ser claros.

---

## 108. Aviso de impressão

Sempre informar:

> Imprimir em 100% / Actual Size / Tamanho real. Não usar "Fit to page".

Essa mensagem deve fazer parte da UI e/ou export summary.

---

# PARTE XIX — TESTES

## 109. Teste físico de escala

Criar arquivo de teste com:

- retângulo 63.5 × 88.9 mm;
- régua 100 mm;
- cruzes de referência.

Critério:

```text
63.5 mm digital
≈
63.5 mm impresso em Actual Size
```

Qualquer divergência do driver deve ser documentada.

---

## 110. Fixtures de imagem

Criar fixtures:

- black border;
- white border;
- borderless;
- full art;
- old frame;
- DFC;
- token;
- dark edge;
- light edge;
- custom;
- SVG;
- very high DPI;
- low DPI.

---

## 111. Testes de bleed

Cobrir:

- 0 mm;
- 0.625 mm;
- 1 mm;
- 2 mm;
- 3 mm;
- todos os lados;
- todos os cantos;
- portrait;
- landscape.

Validar que o trim não muda.

---

## 112. Testes de geometry

Cobrir:

- mm ↔ PDF points;
- mm ↔ px;
- page sizes;
- margins;
- bleed;
- gaps;
- cards per page;
- reserved zones;
- slots skipped.

---

## 113. Testes de PDF

Validar programaticamente:

- tamanho físico da página;
- bounding boxes;
- posicionamento;
- número de páginas;
- dimensões do card trim;
- existência de vetores de guia;
- registration marks.

---

## 114. Testes de duplex

Validar frente e verso com fixtures numeradas.

Exemplo:

```text
Front:
1 2 3
4 5 6

Back esperado:
3 2 1
6 5 4
```

A regra exata dependerá da orientação/flip selecionados.

---

# PARTE XX — ROADMAP

## Fase 0 — Foundation

Implementar:

- Next.js/TypeScript;
- estrutura base;
- SQLite;
- módulo Units;
- módulo Geometry;
- testes.

### Critério de conclusão

Conversões físicas testadas e consistentes.

---

## Fase 1 — PDF mínimo

Entrada: imagens locais.

Gerar:

- A4;
- Magic Standard;
- várias cartas;
- PDF em tamanho real.

Sem Scryfall.

### Critério de conclusão

Teste físico confirma dimensão correta.

---

## Fase 2 — Bleed Engine

Implementar:

- 0–3 mm;
- Subtle Edge Stretch;
- cantos;
- cache;
- preview.

### Critério de conclusão

Área útil da carta permanece idêntica ao original nos testes.

---

## Fase 3 — Cut Guide Engine

Implementar:

- cantos;
- laterais;
- cruz;
- linha completa;
- guilhotina;
- espessura;
- offsets;
- opacidade;
- estilos.

### Critério de conclusão

Guias saem vetoriais e nas posições físicas corretas.

---

## Fase 4 — Universal Import Engine

Implementar:

- drag & drop;
- imagens;
- SVG;
- TXT;
- CSV;
- TSV;
- JSON;
- XML;
- ZIP;
- pasta;
- texto colado;
- detecção automática.

### Critério de conclusão

Uma carta customizada e uma decklist podem entrar sem qualquer dependência do Scryfall.

---

## Fase 5 — Card Identity + Scryfall + Artwork Switching

Implementar:

- `CardIdentity` separado da arte;
- Upload Card Resolver;
- filename resolver;
- OCR/fuzzy matching básico;
- confirmação/correção manual;
- Scryfall search;
- autocomplete;
- card resolver;
- printings;
- Scryfall artwork provider;
- Local artwork provider;
- Artwork Catalog Aggregator;
- Artwork Source Switcher;
- cache;
- DFC;
- tokens básicos.

### Critério de conclusão

Deve ser possível:

1. importar uma carta por decklist;
2. importar uma carta por imagem própria;
3. mapear o upload para uma identidade;
4. preservar a imagem enviada como artwork local;
5. trocar a arte da mesma carta entre Scryfall e upload local sem recriar a carta.

A interface do switcher já deve estar preparada para o provider MPC.

---

## Fase 5.5 — MPC Artwork Provider + Smart Scryfall Bleed

Esta fase foi antecipada após o primeiro teste real da Fase 5 porque o fluxo de uso prioritário depende de MPC Autofill e porque o PDF real mostrou a necessidade de um bleed mais natural para imagens Scryfall.

### Frente A — MPC Artwork Provider online

Implementar o provider MPC online antes do Editor:

- `MpcArtworkProvider` isolado atrás do contrato de `ArtworkProvider`;
- pesquisa por `CardIdentity`/nome sem alterar a identidade lógica da carta;
- thumbnails;
- download do original;
- cache/provenance;
- preservação de `providerAssetId`, `selectedArtworkId`, slots e shared cardback importados na Fase 4;
- integração ao `ArtworkCatalog`;
- switcher `Todas | Scryfall | MPC Autofill | Meus uploads`;
- falha do MPC não pode quebrar Scryfall/uploads;
- nenhum fallback silencioso de uma seleção MPC para Scryfall;
- DFC/MDFC continua com seleção independente por face;
- download de original somente quando necessário para seleção/export;
- validar estabilidade, limites, origem e formato do endpoint/protocolo usado antes de acoplar ao core;
- registrar ADR do provider e provenance suficiente para reproduzir a seleção.

Filtros avançados de DPI/source/tags podem evoluir depois, mas busca, thumbnail, seleção e original fazem parte desta fase antecipada.

### Frente B — Smart Scryfall Bleed / Auto Border Fill

O bleed padrão atual continua preservando integralmente o trim, mas imagens Scryfall com moldura externa escura podem produzir uma faixa externa visualmente preta porque o algoritmo amostra a borda física da carta.

Adicionar uma política automática específica para assets Scryfall:

`smart-border-fill`

Regras obrigatórias:

- nunca alterar, ampliar, recortar, deslocar ou reamostrar a área de trim original;
- gerar somente pixels externos ao trim;
- detectar quando a faixa periférica é predominantemente moldura/borda escura e de baixa variação;
- nesse caso, procurar uma faixa fonte mais interna e visualmente representativa antes de gerar o bleed;
- preservar cada lado de forma independente;
- tratar os quatro cantos sem costuras evidentes;
- para borderless/full-art/frames não escuros, usar a própria borda ou fazer fallback determinístico para `subtle-edge-stretch`;
- se a detecção for incerta, preferir fallback conservador em vez de inventar conteúdo;
- nenhuma IA/cloud/inpainting remoto;
- o algoritmo deve ser determinístico, versionado e entrar no cache key;
- preview e export devem usar exatamente a mesma política;
- o usuário deve poder sobrescrever o modo automático.

Política inicial sugerida por origem:

```text
Scryfall raster → Smart Border Fill (auto)
Upload local    → Subtle Edge Stretch, salvo override
MPC             → respeitar metadata/bleed existente quando conhecido; caso contrário não assumir silenciosamente
SVG             → manter regra vetorial atual até existir implementação específica
```

### Critério de conclusão

Para uma carta identificada, o usuário pode:

1. alternar entre Scryfall, MPC Autofill e upload local sem recriar o WorkingCard;
2. selecionar uma arte MPC online e exportar usando o original validado;
3. selecionar uma arte Scryfall e obter bleed externo visualmente preenchido sem transformar a borda preta em uma faixa externa dominante quando houver conteúdo adequado para extensão;
4. gerar PDF mantendo trim 63.5 × 88.9 mm intacto e guias vetoriais corretas.

Testes obrigatórios:

- Scryfall com borda preta clássica;
- Scryfall borderless/full-art;
- borda clara;
- borda assimétrica;
- cantos;
- 0 / 0.625 / 1 / 2 / 3 mm;
- prova de identidade de pixels da área de trim antes/depois;
- fallback determinístico;
- cache key muda com versão/política;
- MPC online indisponível sem quebrar Scryfall/uploads;
- seleção Scryfall ↔ MPC ↔ upload preserva WorkingCard.id e CardIdentity.id.

---

## Fase 6 — Editor

Implementar:

- lista;
- quantidade;
- reorder;
- drag & drop;
- duplicate;
- delete;
- card details;
- override por carta;
- undo/redo.

---

## Fase 7 — Projects

Implementar:

- create;
- autosave;
- open;
- duplicate;
- delete;
- persist settings;
- persist selected artwork.

---

## Fase 8 — URL Adapters

Implementar gradualmente:

- Scryfall;
- Moxfield;
- Archidekt;
- CubeCobra;
- Deckstats;
- MTGGoldfish;
- MTGTop8;
- TappedOut;
- mtg.wtf;
- direct files.

Cada adapter deve ser isolado.

Falha em um site não pode quebrar Universal Import.

---

## Fase 9 — Silhouette Template Library

Implementar:

- upload de .studio3;
- upload de DXF;
- upload de SVG;
- upload de ZIP;
- metadata;
- version/hash;
- associação ao projeto.

---

## Fase 10 — Registration

Implementar:

- 3 point;
- 4 point;
- custom;
- reserved zones;
- orientation;
- skipped slots.

Validar fisicamente com template real.

---

## Fase 11 — SVG/DXF Cut Export

Implementar:

- leitura de geometria;
- preview;
- export de paths;
- sincronização com layout.

---

## Fase 12 — Duplex

Implementar:

- backs;
- DFC;
- page pairing;
- mirror;
- print flip modes.

---

## Fase 13 — Precision Print Calibration

Implementar:

- printer profiles por papel/orientação/duplex mode;
- offset X/Y independente de front/back;
- input com precisão de 0.001 mm;
- nudges 1 / 0.1 / 0.01 / 0.001 mm;
- rotation;
- scale X/Y;
- skew avançado opcional;
- calibration sheet;
- calibration wizard;
- overlay front/back;
- verification sheet;
- snapshot/versionamento do profile usado.

### Critério de conclusão

Um desalinhamento duplex consistente deve poder ser compensado sem editar imagens, sem reduzir DPI e sem alterar o layout nominal das cartas.

---

## Fase 14 — MPC Artwork Provider avançado

O provider MPC básico foi antecipado para a Fase 5.5 por prioridade de uso.

Esta fase fica reservada apenas para melhorias que dependam de estabilidade externa ou metadata adicional, por exemplo:

- filtros avançados de DPI/source/tags;
- ranking e preferências avançadas;
- atualização/revalidação de assets;
- ferramentas de diagnóstico do provider;
- otimizações de cache e lote;
- recursos adicionais que não sejam necessários para busca, thumbnail, seleção e download básico.

Não duplicar o provider nem criar uma segunda arquitetura MPC.

---

## Fase 15 — Performance

Profiling e otimização:

- cache;
- workers;
- virtual lists;
- memory;
- PDF generation;
- incremental processing.

---

## Fase 16 — Outros TCGs

Adicionar providers/importers/card formats.

Não reescrever PDF, bleed ou layout.

---

# PARTE XXI — MVPs

## MVP 1 — Core Print

Deve permitir:

```text
Upload de PNG/JPG/SVG
      ↓
Projeto
      ↓
Magic Standard
      ↓
Layout em A4
      ↓
Bleed 0–3 mm
      ↓
Subtle Edge Stretch
      ↓
Guias
      ↓
PDF máxima qualidade
```

Esse MVP prova o motor de fabricação.

---

## MVP 2 — Magic Workflow + Artwork Identity

Adicionar:

```text
Decklist OU upload próprio
          ↓
Resolver identidade da carta
          ↓
CardIdentity
          ↓
┌─────────┼─────────────┐
│         │             │
Scryfall  Upload local  MPC*
│         │             │
└─────────┼─────────────┘
          ↓
Escolher arte por carta
          ↓
Projeto
          ↓
PDF
```

`* MPC Artwork Provider foi antecipado para a Fase 5.5 e passa a fazer parte do fluxo prioritário antes do Editor.`

Critérios adicionais:

> Uma imagem própria mapeada para uma carta conhecida deve continuar podendo trocar para outra arte da mesma carta sem excluir/reimportar o item.

> Cartas dupla-face conhecidas devem ser sinalizadas e carregar automaticamente front/back quando disponíveis.

> O editor deve permitir selecionar/alterar o back individualmente.

---

## MVP 3 — Silhouette

Adicionar:

```text
Upload de template
  ↓
metadata/geometria
  ↓
registration
  ↓
layout alinhado
  ↓
PDF
  ↓
.studio3 associado
  ↓
corte físico validado
```

---

# PARTE XXII — REGRAS PARA AGENTES

## 115. Não alterar decisões críticas silenciosamente

Qualquer mudança nestes itens deve ser explicitamente documentada:

- 63.5 × 88.9 mm para Magic Standard;
- mm como unidade canônica;
- trim original não deve ser ampliado para bleed;
- bleed 0–3 mm;
- Subtle Edge Stretch como modo principal;
- PDF não deve ser screenshot de canvas;
- export padrão é lossless/source-quality, sem downsampling ou recompressão destrutiva;
- JPEG sem processamento deve ser incorporado por passthrough do stream original;
- arquivos originais são imutáveis;
- .studio3 é tratado como arquivo associado/opaco;
- Importer e Provider permanecem separados.
- identidade da carta e artwork selecionado permanecem separados;
- uploads mapeados para cartas conhecidas continuam sendo artworks intercambiáveis;
- seleção de arte deve suportar providers por carta, não apenas por projeto.
- cartas dupla-face devem ser sinalizadas visualmente e de forma acessível;
- DFCs conhecidas devem auto-resolver front/back quando os providers fornecerem ambas as faces;
- exportação deve permitir front-only, back-only, front/back separados e duplex;
- overrides manuais de back nunca podem ser sobrescritos silenciosamente.
- calibração de impressão deve aceitar offsets até 0.001 mm sem quantização artificial;
- calibração deve ser aplicada por transformação de página, preservando os pixels/streams originais quando possível;
- layout manual deve permitir linhas/colunas e orientação escolhidas pelo usuário.

---

## 116. Cada fase deve entregar testes

Não considerar uma fase concluída apenas porque a UI "parece funcionar".

Cada módulo crítico deve ter testes.

Especialmente:

- units;
- geometry;
- bleed;
- layout;
- PDF;
- duplex;
- cut paths.

---

## 117. Evitar escopo desnecessário

Não implementar sem necessidade:

- login;
- pagamentos;
- cloud;
- social;
- marketplace;
- IA;
- edição completa de frames;
- app mobile.

Priorizar fabricação.

---

## 118. Não sacrificar qualidade por preview

Pode-se usar thumbnails e versões reduzidas na UI.

O export final sempre deve partir de:

- original;
- ou derivado lossless necessário.

Nunca gerar o PDF final a partir do thumbnail.

---

## 119. Commits e PRs

Sugestão para agentes:

- uma feature/módulo coerente por PR;
- testes no mesmo PR;
- descrição do impacto em geometria/impressão;
- screenshots para alterações de UI;
- fixtures quando a feature mexer com imagem/PDF.

Se uma mudança alterar dimensões, bleed, layout ou PDF, incluir evidência/teste específico.

---

# PARTE XXIII — DEFINITION OF DONE

O produto só deve ser considerado funcional para produção quando:

### A. Escala

Uma carta definida como 63.5 × 88.9 mm aparece com essa dimensão física ao imprimir em 100%/Actual Size dentro da tolerância prática do equipamento.

### B. Bleed

Adicionar bleed não remove nem amplia conteúdo da área útil.

### C. Qualidade

O PDF final não usa thumbnails, não faz downsampling e não introduz recompressão destrutiva.

Para JPEG sem processamento, o stream JPEG incorporado deve ser byte-identical ao original. Para PNG e outros rasters lossless, os pixels e dimensões devem ser preservados integralmente.

### D. Reprodutibilidade

Um projeto reaberto preserva:

- ordem;
- arte;
- bleed;
- layout;
- template;
- versões;
- backs;
- configurações.

### E. Silhouette

PDF + template correspondente produzem corte consistentemente alinhado após configuração/calibração adequada.

---

# PARTE XXIV — DECISÕES DE IMPLEMENTAÇÃO AINDA ABERTAS

Estas decisões **fazem parte do plano oficial**. Elas não estão indefinidas por falta de planejamento; estão deliberadamente abertas porque precisam de benchmark, protótipo ou teste físico antes de serem fechadas.

Agentes não devem escolher silenciosamente uma opção e tornar isso permanente sem registrar o motivo.

---

## 120. OCR para identificação de uploads

Objetivo:

- tentar reconhecer o nome de uma carta enviada pelo usuário;
- funcionar localmente sempre que possível;
- não alterar a imagem original;
- ter custo de CPU aceitável;
- suportar processamento em background;
- funcionar bem com nomes pequenos, molduras diferentes e scans imperfeitos.

A implementação deve ser avaliada por benchmark com fixtures reais.

Critérios:

- precisão no nome da carta;
- velocidade por imagem;
- consumo de memória;
- suporte local/offline;
- tamanho das dependências/modelos;
- facilidade de empacotamento;
- comportamento em Windows.

Pipeline desejado:

```text
filename/metadata
      ↓
match exato
      ↓
OCR somente se necessário
      ↓
fuzzy match
      ↓
confirmação do usuário
```

OCR não deve ser executado desnecessariamente quando nome/metadata já resolverem a carta.

### Spike obrigatório

Antes de fixar a biblioteca:

1. testar pelo menos duas opções viáveis;
2. usar conjunto de imagens reais de cartas;
3. medir precisão e tempo;
4. registrar resultados;
5. escolher a opção mais adequada.

---

## 121. Integração online com MPC Autofill

MPC não deve ser requisito para o funcionamento básico do TCGPrint.

A integração deve ser dividida em níveis:

### Nível 1 — obrigatório

- importar MPC Autofill XML;
- preservar IDs;
- preservar ordem;
- preservar front/back;
- preservar artwork escolhido;
- usar assets locais quando fornecidos.

### Nível 2 — desejado

`MpcArtworkProvider` integrado ao Artwork Catalog.

Objetivo:

```text
CardIdentity
   ↓
MPC artwork search
   ↓
thumbnails
   ↓
selecionar
   ↓
baixar original
```

### Critérios para habilitar integração online

Somente implementar como provider de primeira classe se houver forma tecnicamente estável de:

- pesquisar por carta;
- identificar artwork;
- obter preview;
- obter original;
- respeitar estrutura/IDs;
- lidar com indisponibilidade sem quebrar o app.

Se depender de scraping extremamente frágil, manter como integração opcional/experimental.

Falha do MPC nunca pode bloquear:

- Scryfall;
- uploads;
- projetos;
- PDF;
- export.

---

## 122. Algoritmo final dos cantos do bleed

O conceito está fechado:

> o trim original nunca deve ser ampliado ou recortado para criar bleed.

A implementação exata dos cantos deve ser decidida através de comparação visual.

Candidatos a testar:

- stretch radial;
- combinação de edge stretch horizontal/vertical;
- corner patch derivado da região local;
- mirror corner;
- interpolação/blend entre duas bordas.

Fixtures obrigatórias:

- canto preto;
- canto branco;
- frame antigo;
- borderless;
- full-art;
- texto próximo da borda;
- gradiente;
- textura;
- canto com elemento de alto contraste.

Critérios:

- nenhuma alteração no trim;
- baixa visibilidade da extensão;
- ausência de costura;
- ausência de artefato no canto;
- bom resultado em bleed pequeno, especialmente em torno de 0.625 mm;
- desempenho aceitável.

O modo final deve ser escolhido com testes lado a lado e armazenado como algoritmo versionado para reprodutibilidade.

---

## 123. Defaults e limites de campos

Valores padrão devem ser tratados como configuração de produto, não espalhados pelo código.

Criar um módulo único, por exemplo:

```text
core/defaults/
```

ou equivalente.

Defaults que precisam existir explicitamente:

- formato de carta;
- bleed;
- page size;
- orientação;
- gaps;
- layout mode;
- DPI mode;
- cut guide settings;
- registration settings;
- back policy;
- calibration step;
- preview quality;
- export mode.

Regras:

- defaults devem poder ser alterados sem modificar o engine;
- projetos existentes preservam os valores usados;
- atualizar default global não deve alterar projeto antigo;
- limites de UI não podem introduzir perda silenciosa;
- campos físicos devem aceitar entrada decimal precisa.

Exemplo:

```text
DPI default:
Original / Sem limite

Calibration default step:
0.100 mm
Disponíveis:
1 / 0.1 / 0.01 / 0.001 mm
```

---

## 124. Web local vs aplicativo desktop

A arquitetura deve manter o core independente da camada de empacotamento.

Primeira meta:

```text
Aplicação local funcional
```

O desenvolvimento pode iniciar como aplicação web local.

Depois comparar empacotamento desktop.

Critérios para decidir:

- acesso seguro e conveniente a arquivos/pastas;
- drag & drop;
- file picker;
- abrir .studio3;
- acesso a filesystem;
- SQLite;
- performance;
- Worker Threads;
- auto-update;
- tamanho do bundle;
- experiência no Windows;
- complexidade de manutenção.

O core não deve depender diretamente de APIs específicas do browser ou de um runtime desktop.

Criar abstrações para:

- filesystem;
- dialogs;
- open external file;
- persistent data directory.

Assim a UI pode migrar para um shell desktop sem reescrever engines.

---

## 125. Color management / ICC

Color management avançado não é requisito para o primeiro PDF funcional, mas deve estar previsto na arquitetura.

Regra inicial:

- não aplicar "melhorias" automáticas;
- não alterar saturação;
- não alterar contraste;
- não alterar gamma silenciosamente;
- preservar profiles/metadata relevantes quando possível;
- não converter espaço de cor sem necessidade.

Fase posterior deve avaliar:

- ICC input profile;
- printer/paper ICC profile;
- soft proof;
- conversão RGB/CMYK quando realmente necessária;
- rendering intent;
- embedding de output intent no PDF;
- preservação de perfis em imagens originais.

Critério:

> color management nunca pode ser aplicado silenciosamente de forma que altere a aparência da arte sem o usuário saber.

A UI futura pode oferecer:

```text
Color Management

○ Preservar original
○ Usar perfil da impressora/papel
○ Avançado
```

Default inicial:

```text
Preservar original
```

---

## 126. Spikes técnicos obrigatórios

Antes de consolidar decisões que dependem de comportamento externo ou qualidade visual, criar pequenos spikes isolados.

Spikes previstos:

### OCR Spike
Comparar bibliotecas/modelos com cartas reais.

### MPC Spike
Validar busca/download/IDs e estabilidade da integração.

### Bleed Corner Spike
Gerar matriz visual com múltiplos algoritmos.

### PDF Fidelity Spike
Confirmar JPEG passthrough, PNG lossless e SVG vetorial.

### Desktop Packaging Spike
Comparar manutenção/performance/acesso ao filesystem.

### ICC Spike
Testar preservação e transformação de profiles sem comprometer o pipeline lossless.

Cada spike deve gerar:

- código descartável ou isolado;
- resultados;
- benchmark;
- conclusão documentada.

Não misturar spike experimental diretamente no engine de produção sem decisão registrada.

---

## 127. Registro de decisões técnicas

Criar diretório:

```text
docs/decisions/
```

Usar ADRs simples para decisões relevantes.

Exemplos:

```text
0001-pdf-engine.md
0002-ocr-engine.md
0003-mpc-provider.md
0004-bleed-corner-algorithm.md
0005-desktop-packaging.md
0006-color-management.md
```

Cada decisão deve registrar:

- contexto;
- alternativas;
- testes;
- decisão;
- consequências;
- data;
- versão relevante.

Isso evita que futuros agentes "redescubram" ou revertam decisões sem saber por quê.

---


# PARTE XXV — PRE-IMPLEMENTATION HARDENING

Esta seção fecha pontos que costumam causar retrabalho quando só são percebidos depois que o projeto já cresceu.

Nenhum agente deve começar uma implementação grande sem respeitar estas regras.

---

## 128. Versionamento do formato de projeto

Todo projeto salvo deve possuir versão explícita de schema.

Exemplo:

~~~json
{
  "projectSchemaVersion": 1
}
~~~

Nunca assumir que o formato salvo hoje será o formato definitivo.

Criar desde o início:

~~~text
Project v1
   ↓
migration
   ↓
Project v2
~~~

Regras:

- migrations devem ser determinísticas;
- projeto antigo deve abrir em versão nova;
- nunca migrar destrutivamente sem backup/snapshot;
- versões futuras devem poder identificar projeto incompatível;
- engines devem evitar depender diretamente do shape cru do banco.

---

## 129. Autosave seguro e recuperação de crash

Autosave não pode corromper o projeto se o programa fechar no meio da gravação.

Usar escrita transacional/atômica.

Estratégia:

~~~text
estado atual
   ↓
salvar snapshot/transaction
   ↓
confirmar sucesso
   ↓
marcar nova versão como válida
~~~

Manter:

- último estado válido;
- timestamp do autosave;
- dirty state;
- recovery state.

Ao iniciar após crash:

~~~text
Foi encontrada uma recuperação mais recente.

[Restaurar]
[Usar último save]
~~~

---

## 130. Histórico e snapshots de projeto

Além de Undo/Redo em memória, permitir snapshots persistentes em pontos importantes.

Exemplos:

- antes de migration;
- antes de trocar template;
- antes de re-resolver uma lista inteira;
- antes de aplicar mudança global de back;
- antes de atualização grande do projeto.

Não precisa ser um sistema de Git interno.

Pode ser retenção simples das últimas N versões.

---

## 131. Deduplicação de assets

Assets originais devem ser content-addressed por hash.

Exemplo:

~~~text
SHA256(file)
      ↓
originals/<hash>
~~~

Se a mesma imagem for importada em 20 projetos:

- armazenar uma única cópia física;
- projetos referenciam o asset;
- nunca deletar asset ainda referenciado.

Separar:

- original asset;
- thumbnail;
- processed derivative;
- metadata.

---

## 132. Garbage collection de cache

Cache processado pode crescer muito.

Criar política explícita para:

- thumbnails;
- bleed derivatives;
- previews;
- downloads temporários;
- exports temporários.

Nunca apagar originals automaticamente sem confirmar que não há referências.

Cache pode usar:

- LRU;
- limite configurável;
- limpeza manual;
- "limpar derivados e reconstruir depois".

---

## 133. Reprodutibilidade de export

Todo export importante deve poder registrar um manifest.

Exemplo:

~~~json
{
  "projectId": "...",
  "projectSchemaVersion": 3,
  "exportedAt": "...",
  "paper": "A4",
  "layout": "4x2",
  "bleedMm": 0.625,
  "templateHash": "...",
  "printerProfileSnapshot": {},
  "cards": [
    {
      "identity": "Sol Ring",
      "artworkHash": "..."
    }
  ]
}
~~~

Objetivo:

> conseguir explicar exatamente como um PDF antigo foi produzido.

O manifest pode ser salvo no projeto e opcionalmente exportado como JSON ao lado do PDF.

---

## 134. Import report

Toda importação grande deve gerar um resumo antes de alterar o projeto.

Exemplo:

~~~text
Importação

100 entradas
96 resolvidas
2 ambíguas
1 não encontrada
1 custom

85 Scryfall
8 uploads
3 MPC

[Revisar problemas]
[Importar]
~~~

Nunca esconder falhas individuais em importações de dezenas/centenas de cartas.

---

## 135. Error model

Criar erros tipados por domínio.

Exemplos:

~~~text
ImportError
ProviderError
ImageDecodeError
PdfExportError
TemplateError
CalibrationError
FilesystemError
MigrationError
~~~

Erros técnicos podem ir para logs.

UI deve mostrar mensagem útil, por exemplo:

~~~text
Não foi possível baixar esta arte do MPC.
A carta e o restante do projeto foram preservados.
~~~

Não usar um único tratamento genérico para todos os erros.

---

## 136. Logging e diagnóstico

Criar logging local estruturado.

Níveis:

- error;
- warn;
- info;
- debug.

Registrar quando relevante:

- importer utilizado;
- provider;
- cache hit/miss;
- processamento de imagem;
- tempo de export;
- memória aproximada;
- falha de asset;
- migrations;
- calibração/profile aplicado.

Nunca gravar bytes completos de cartas nos logs.

Adicionar relatório de diagnóstico exportável para facilitar debug por agentes no futuro.

---

## 137. Performance budgets

Não esperar o programa ficar lento para então pensar em performance.

Criar metas iniciais mensuráveis, ajustáveis após benchmark.

Targets de desenvolvimento:

- abrir projeto de 100 cartas sem travar a UI;
- scroll da lista permanecer fluido;
- seleção de artwork não carregar originais completos;
- operações pesadas não bloquear thread da UI;
- projeto de 500 cartas continuar manipulável;
- processamento deve mostrar progresso/cancelamento quando durar perceptivelmente;
- export pode ser pesado, mas não deve causar consumo de memória ilimitado.

Benchmarks reais devem substituir números arbitrários conforme o projeto evoluir.

---

## 138. Cancelamento de operações pesadas

Import, download, OCR, bleed batch e PDF export devem suportar cancelamento quando tecnicamente seguro.

Estados:

~~~text
Queued
Running
Cancelling
Cancelled
Completed
Failed
~~~

Cancelar não pode:

- corromper projeto;
- apagar originals;
- deixar banco em estado parcial.

---

## 139. Progress reporting

Operações longas devem mostrar progresso útil.

Exemplos:

~~~text
Resolvendo cartas: 38 / 100
Baixando artes: 17 / 64
Gerando bleed: 41 / 100
Exportando páginas: 8 / 12
~~~

Não mostrar spinner infinito quando houver quantidade conhecida.

---

## 140. Dependency policy

Antes de adicionar dependência grande, verificar:

- manutenção ativa;
- licença;
- tamanho;
- compatibilidade Windows;
- compatibilidade Node/runtime escolhido;
- impacto em bundle;
- necessidade real.

Evitar adicionar biblioteca pesada para operação trivial.

Fixar versões de dependências críticas e atualizar deliberadamente.

---

## 141. Licenças e uso de código de referência

Referências externas não significam autorização para copiar código indiscriminadamente.

Regras:

- verificar licença antes de reutilizar código;
- registrar origem de trechos derivados;
- evitar copiar código GPL para o core sem decisão consciente sobre implicações;
- preferir reimplementar comportamento/matemática quando apropriado;
- não incorporar assets de terceiros no repositório sem autorização/licença compatível.

Criar THIRD_PARTY_NOTICES.md quando houver dependências/assets que exijam atribuição.

---

## 142. Fixtures próprias para testes

Testes automatizados não devem depender obrigatoriamente de artwork comercial real no repositório.

Criar fixtures próprias:

- grids;
- gradientes;
- texto;
- padrões geométricos;
- mock cards.

Para testes manuais locais, o usuário pode usar assets reais fora do repo.

Isso reduz tamanho do repositório e dependência em conteúdo de terceiros.

---

## 143. Provider contract e degradação

Cada provider deve ter contrato explícito de disponibilidade.

Exemplo conceitual:

~~~ts
interface ProviderHealth {
  available: boolean;
  degraded: boolean;
  message?: string;
}
~~~

Se MPC estiver fora:

~~~text
MPC indisponível
Scryfall e uploads continuam funcionando
~~~

Se Scryfall estiver fora:

- projetos existentes continuam abrindo;
- imagens locais/cache continuam funcionando;
- PDF continua exportando com assets já disponíveis.

O projeto deve ser offline-friendly sempre que os assets necessários já estiverem locais.

---

## 144. Cache provenance

Todo asset baixado deve guardar origem.

Exemplo:

~~~text
provider
providerAssetId
sourceUrl
downloadedAt
contentHash
originalFilename
~~~

Isso ajuda em:

- deduplicação;
- reprodução;
- debug;
- atualização futura;
- identificação de assets quebrados.

---

## 145. Validação de arquivos importados

Mesmo sendo aplicação local, arquivos podem estar corrompidos ou malformados.

Validar:

- MIME real quando possível;
- extensão;
- tamanho;
- dimensões;
- decode;
- XML/JSON válido;
- ZIP traversal;
- ZIP bomb/quantidade absurda;
- SVG malformado;
- DXF malformado.

Falha em um arquivo não deve derrubar importação inteira quando for possível isolar o item.

---

## 146. Normalização sem destruição

Metadata pode ser normalizada.

Original não.

Exemplo:

~~~text
Sol_Ring_CUSTOM.png
      ↓
normalized label:
Sol Ring
~~~

Os bytes do arquivo original permanecem intactos.

Nunca "corrigir" arquivo original no lugar.

---

## 147. Backup / export de projeto

Além de salvar no banco local, permitir futuramente exportar um projeto portátil.

Formato sugerido:

~~~text
.tcgprint
~~~

ou ZIP versionado contendo:

~~~text
project.json
manifest.json
assets/
templates/
profiles/
~~~

Modos possíveis:

- lightweight: referencia cache local;
- portable: inclui assets necessários.

O formato precisa possuir schema version.

---

## 148. Import de projeto portátil

Ao importar:

- validar versão;
- validar hashes;
- deduplicar assets;
- migrar schema quando suportado;
- não sobrescrever projeto existente silenciosamente.

---

## 149. Keyboard-first sem sacrificar touch

Mesmo com UI simples, operações repetitivas devem aceitar teclado.

Exemplos:

- Ctrl/Cmd+Z;
- Ctrl/Cmd+Y;
- Delete;
- setas;
- Enter;
- busca;
- próxima/anterior carta;
- atalhos para front/back futuramente.

Mas toda ação deve continuar possível por mouse/touch.

---

## 150. Acessibilidade funcional

Mesmo sendo ferramenta pessoal:

- não depender somente de cor;
- labels reais em inputs;
- foco visível;
- tooltip não pode ser única fonte de informação essencial;
- DFC precisa de texto acessível além do ícone;
- warnings precisam ser legíveis;
- navegação básica por teclado.

Isso melhora a própria qualidade da UI.

---

## 151. Design system mínimo

Não criar um design system complexo.

Definir apenas tokens básicos:

- spacing;
- font sizes;
- border;
- background;
- text;
- accent;
- warning;
- error;
- success.

Regras:

- sem glassmorphism;
- sem blur;
- sem gradientes decorativos;
- poucas sombras;
- animações apenas quando úteis;
- UI densa;
- informação em linha quando possível;
- painéis redimensionáveis;
- listas virtualizadas.

A aparência deve lembrar ferramenta técnica moderna, não landing page/SaaS.

---

## 152. Test matrix oficial

Antes de considerar release utilizável, cobrir uma matriz mínima.

### Sistema

- Windows principal;
- navegador/runtime suportado;
- filesystem local.

### Formatos

- JPEG;
- PNG;
- WebP;
- TIFF;
- SVG;
- TXT;
- CSV;
- JSON;
- XML;
- ZIP;
- DXF;
- .studio3 como arquivo opaco.

### Cartas

- normal;
- DFC;
- token;
- custom;
- upload reconhecido;
- upload não reconhecido.

### Layout

- auto;
- manual;
- template;
- portrait;
- landscape;
- 3×3;
- 4×2;
- custom.

### Export

- front;
- back;
- separados;
- duplex.

### Qualidade

- passthrough;
- bleed;
- 300 DPI;
- 600 DPI;
- 1200 DPI;
- original sem limite.

### Calibration

- X/Y;
- rotation;
- scale;
- input de 0.001 mm.

---

## 153. Release gates

Nenhuma versão deve ser considerada pronta só porque "abre e exporta".

Release utilizável exige:

- testes automáticos críticos passando;
- escala física verificada;
- PDF fidelity verificada;
- bleed verificado;
- projeto salva/reabre corretamente;
- crash recovery básico;
- import report;
- erros isolados;
- DFC/front/back funcionando;
- layout manual funcionando;
- export reproduzível;
- sem regressão conhecida que altere tamanho físico ou qualidade.

---

## 154. Regra final para agentes

Se um agente encontrar ambiguidade que possa afetar:

- qualidade;
- dimensão física;
- formato de projeto;
- compatibilidade de templates;
- perda de dados;
- reprodutibilidade;

ele deve:

1. não inventar comportamento silencioso;
2. criar/atualizar ADR;
3. implementar teste/spike;
4. registrar decisão;
5. só então consolidar no core.

---

# PARTE XXVI — PRIMEIRA TAREFA RECOMENDADA

O primeiro agente deve começar por:

1. criar o projeto TypeScript;
2. implementar `core/units`;
3. implementar `core/geometry`;
4. criar `CardFormat` e `PaperFormat`;
5. implementar PDF mínimo com imagens locais;
6. criar fixtures físicas;
7. adicionar testes para dimensões do PDF;
8. só então avançar para o Bleed Engine.

Não começar por Scryfall, banco de cartas ou interface sofisticada.

O núcleo físico é a fundação de todo o restante.

---

## Resumo da arquitetura final

```text
              INPUT
                │
                ▼
      Universal Import Engine
                │
      ┌─────────┼──────────┐
      │         │          │
     URL       FILE       TEXT
      │         │          │
      └─────────┼──────────┘
                ▼
          ProjectCard[]
                │
                ▼
        Card Identity Resolver
                │
                ▼
           CardIdentity
                │
                ▼
          Artwork Catalog
        ┌───────┼────────┐
        │       │        │
    Scryfall    MPC     Local
        │       │        │
        └───────┼────────┘
                ▼
       Selected Artwork
                │
                ▼
           Image Engine
                │
       ┌────────┼─────────┐
       │        │         │
   originals   bleed     cache
       │        │         │
       └────────┼─────────┘
                ▼
          Layout Engine
                │
       ┌────────┼───────────┐
       │        │           │
      paper    guides    templates
       │        │           │
       └────────┼───────────┘
                ▼
           PDF Engine
                │
        ┌───────┴────────┐
        │                │
      PRINT             CUT
                         │
                 SVG / DXF / .studio3
```

Este documento deve ser atualizado sempre que uma decisão estrutural importante for alterada.
