# TCGPrint — Plano de Implementação

> Documento de referência para agentes e desenvolvedores que forem implementar o projeto.
>
> **Status:** planejamento inicial consolidado  
> **Escopo inicial:** Magic: The Gathering, execução local, foco em impressão de alta qualidade e corte preciso  
> **Arquitetura:** preparada para outros TCGs posteriormente

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
| PDF | pdf-lib + engine próprio |
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

## 19. Frente e verso

Modelo:

```ts
interface CardFace {
  id: string;
  sourceType: "file" | "url" | "scryfall" | "mpc";
  sourceFile?: string;
  sourceUrl?: string;
  sourceHash: string;
  originalFormat: string;
  widthPx?: number;
  heightPx?: number;
  selectedArtworkId?: string;
}
```

```ts
interface ProjectCard {
  id: string;
  name?: string;
  quantity: number;

  front: CardFace;
  back?: CardFace;

  widthMm: number;
  heightMm: number;

  source:
    | "scryfall"
    | "mpc"
    | "upload"
    | "url"
    | "custom";

  metadata?: Record<string, unknown>;
}
```

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

# PARTE VII — IMAGE ENGINE

## 24. Regra de ouro

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

## 25. Bleed

Bleed configurável:

```text
0.000 mm → 3.000 mm
```

Permitir entrada decimal livre.

Não fixar 3 mm como padrão.

Não criar um preset obrigatório "Alan Cha".

Quando um template importado tiver metadata/recomendação própria, o projeto pode guardar um bleed recomendado, mas o usuário deve continuar podendo alterá-lo.

---

## 26. Subtle Edge Stretch

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

## 27. Faixa de origem

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

## 28. Cantos

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

## 29. Outros modos de bleed

Suportar posteriormente:

- Subtle Edge Stretch — padrão;
- Mirror Edge;
- Solid/Edge Color Sample;
- Existing Bleed;
- None.

---

## 30. Bleed e imagens já preparadas

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

## 31. Teste obrigatório de integridade

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

## 32. Layout automático

Entrada:

```ts
interface LayoutRequest {
  paper;
  margins;
  cardFormat;
  bleedMm;
  horizontalGapMm;
  verticalGapMm;
  reservedZones;
  templateGeometry?;
}
```

Calcular linhas/colunas pelo espaço disponível.

Não hardcode:

```text
A4 = 3 × 3
```

O engine deve funcionar para qualquer tamanho.

---

## 33. Espaçamento

Configurar independentemente:

- gap horizontal;
- gap vertical.

Permitir valores decimais em mm.

---

## 34. Slots desativados

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

## 35. Tipos de guia

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

## 36. Guias vetoriais

As linhas de corte no PDF devem ser vetoriais.

Espessura em mm/points, não pixels.

---

## 37. Guilhotina

Modo de linhas contínuas ao longo da folha para facilitar:

- guilhotina;
- refiladora;
- cortador rotativo.

---

# PARTE X — SILHOUETTE E TEMPLATES

## 38. Template Library

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

## 39. .studio3

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

## 40. DXF e SVG

Quando houver DXF/SVG correspondente, usar como geometria legível.

Objetivos:

- obter posições de corte;
- obter paths;
- obter dimensões;
- gerar preview;
- alinhar PDF.

Quando não houver, permitir configuração manual da geometria do template e salvar metadata.

---

## 41. Template Package

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

## 42. Versionamento de template

Projeto deve armazenar:

- template ID;
- versão;
- hash.

Um projeto criado com template v5 não deve passar automaticamente para v6.

Isso é necessário para reimpressões reproduzíveis.

---

## 43. Registration marks

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

## 44. Não rasterizar a folha inteira

Não gerar:

```text
Canvas gigante
→ Screenshot
→ PDF
```

Montar o PDF diretamente.

Estrutura:

```text
PDF Page
├─ imagens das cartas
├─ vetores
├─ crop/cut guides
├─ registration marks
└─ labels opcionais
```

---

## 45. Preservação da imagem

Quando a imagem não precisar ser processada, evitar resize e recompressão.

Quando precisar de bleed:

```text
original
→ processamento lossless
→ versão derivada
→ PDF
```

Nunca substituir o original.

---

## 46. SVG

Preservar o SVG original.

Criar preview raster leve para UI.

No export, preservar vetores sempre que a biblioteca/fluxo suportar corretamente.

Se uma operação exigir rasterização, rasterizar apenas a versão processada em resolução suficiente.

---

## 47. DPI efetivo

Exibir DPI real baseado em:

- pixel dimensions;
- tamanho físico de impressão.

Exemplo:

```text
745 × 1040 px
63.5 × 88.9 mm
≈ 298 DPI
```

Não vender a ideia de "PDF 1200 DPI" se a origem tem ~300 DPI.

---

## 48. Indicador de qualidade

Sugestão:

```text
600+ DPI   Excelente
300+ DPI   Boa
200–299    Aviso
<200       Baixa
```

Informativo, não bloqueante.

---

## 49. Limite opcional de resolução

Configuração:

```text
Máxima / Original
800 DPI máximo
600 DPI máximo
300 DPI máximo
```

Default:

```text
Máxima / Original
```

---

# PARTE XII — PREVIEW

## 50. Preview separado do export

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

## 51. Galerias virtualizadas

Galerias de printings e listas grandes devem renderizar apenas itens visíveis + buffer.

Isso é importante para cartas com muitas printings e projetos com centenas de cards.

---

# PARTE XIII — PROJETOS

## 52. Persistência

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

## 53. Autosave

Salvar automaticamente:

- cartas;
- ordem;
- quantidade;
- arte escolhida;
- faces;
- backs;
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

## 54. Undo / Redo

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

# PARTE XIV — DUPLEX

## 55. Modos

Suportar:

- frente apenas;
- verso universal;
- versos individuais;
- DFC.

---

## 56. Mirror e page pairing

Implementar cálculo correto do verso baseado em:

- orientação;
- long-edge / short-edge;
- layout;
- posição do slot.

Criar testes de correspondência frente/verso.

---

# PARTE XV — CALIBRAÇÃO DE IMPRESSORA

## 57. Printer profiles

Modelo:

```ts
interface PrinterProfile {
  id: string;
  name: string;

  offsetXmm: number;
  offsetYmm: number;

  rotationDeg: number;

  scaleX: number;
  scaleY: number;
}
```

---

## 58. Calibration sheet

Gerar PDF de calibração com:

- cruzes;
- régua;
- marcas numeradas;
- frente;
- verso.

Permitir registrar o resultado e aplicar ao perfil.

---

# PARTE XVI — PERFORMANCE

## 59. Cache por hash

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

## 60. Worker Threads

Usar processamento concorrente controlado para:

- bleed;
- thumbnails;
- rasterizações;
- batches.

Nunca abrir um worker por carta sem limite.

Pool baseado em CPU/memória.

---

## 61. Escalas de teste

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

## 62. Editor principal

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

## 63. Básico vs avançado

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

## 64. Formatos

Exportar:

- PDF;
- PNG sheets;
- imagens individuais;
- SVG cut file;
- DXF cut file.

Quando um template .studio3 estiver associado, manter o arquivo disponível junto ao projeto/export.

---

## 65. Verificação pré-export

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

## 66. Aviso de impressão

Sempre informar:

> Imprimir em 100% / Actual Size / Tamanho real. Não usar "Fit to page".

Essa mensagem deve fazer parte da UI e/ou export summary.

---

# PARTE XIX — TESTES

## 67. Teste físico de escala

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

## 68. Fixtures de imagem

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

## 69. Testes de bleed

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

## 70. Testes de geometry

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

## 71. Testes de PDF

Validar programaticamente:

- tamanho físico da página;
- bounding boxes;
- posicionamento;
- número de páginas;
- dimensões do card trim;
- existência de vetores de guia;
- registration marks.

---

## 72. Testes de duplex

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

## Fase 5 — Scryfall

Implementar:

- search;
- autocomplete;
- card resolver;
- printings;
- artwork picker;
- cache;
- DFC;
- tokens básicos.

### Critério de conclusão

Decklist de Magic pode ser importada, resolvida e ter artes trocadas visualmente.

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

## Fase 13 — Calibration

Implementar:

- printer profiles;
- offset X/Y;
- rotation;
- scale;
- calibration sheet.

---

## Fase 14 — MPC

Primeiro:

- MPC Autofill XML;
- local assets.

Depois:

- artwork browser/provider, se integração for estável.

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

## MVP 2 — Magic Workflow

Adicionar:

```text
Decklist
  ↓
Scryfall
  ↓
Seleção visual de printing
  ↓
Projeto
  ↓
PDF
```

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

## 73. Não alterar decisões críticas silenciosamente

Qualquer mudança nestes itens deve ser explicitamente documentada:

- 63.5 × 88.9 mm para Magic Standard;
- mm como unidade canônica;
- trim original não deve ser ampliado para bleed;
- bleed 0–3 mm;
- Subtle Edge Stretch como modo principal;
- PDF não deve ser screenshot de canvas;
- arquivos originais são imutáveis;
- .studio3 é tratado como arquivo associado/opaco;
- Importer e Provider permanecem separados.

---

## 74. Cada fase deve entregar testes

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

## 75. Evitar escopo desnecessário

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

## 76. Não sacrificar qualidade por preview

Pode-se usar thumbnails e versões reduzidas na UI.

O export final sempre deve partir de:

- original;
- ou derivado lossless necessário.

Nunca gerar o PDF final a partir do thumbnail.

---

## 77. Commits e PRs

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

O PDF final não usa thumbnails e não introduz recompressão destrutiva desnecessária.

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

# PARTE XXIV — PRIMEIRA TAREFA RECOMENDADA

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
          Card Providers
        ┌───────┼────────┐
        │       │        │
    Scryfall    MPC     Local
        │       │        │
        └───────┼────────┘
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
