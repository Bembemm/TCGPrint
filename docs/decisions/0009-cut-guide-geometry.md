# ADR 0009: Geometria de Trim e External Cut Guides

- Status: Aceito
- Data: 2026-09-27
- Escopo: Fase 5.6 — guias vetoriais de corte no PDF
- Relacionado: ADR 0008 (Edge Extension e Rounded Corners, sem alteração nesta fase)

## Contexto

A inspeção de uso e impressão real após a Fase 5.5 esclareceu que “guia de corte” vinha sendo usado para dois sistemas distintos. Eles têm objetivos e áreas de desenho diferentes: marcas curtas na borda física da carta e linhas de alinhamento prolongadas pelas áreas livres da folha. A geometria precisa continuar inequívoca com qualquer valor de bleed e com Rounded Corners ligado.

A Fase 5.5 continua concluída. Este ADR não reabre nem altera o algoritmo `edge-extension-v1` ou `rounded-corners-v1`.

## Decisão

### Referencial físico

- `trimRect` é a fronteira física final da carta e a única referência de posição de corte. Magic Standard mede exatamente `63.5 × 88.9 mm`.
- `bleedRect` é `trimRect` expandido pelo bleed configurado. Bleed é somente margem gráfica de segurança e zona de exclusão para desenho externo.
- `sheet` é a folha/PDF que contém cartas e áreas livres.
- **Cut position = trim. Bleed is not a cut-guide coordinate.** Variar bleed não desloca trim, cartas ou coordenadas centrais das guias.

```text
┌──────────── bleedRect ────────────┐
│       ┌────── trimRect ──────┐    │
│       │        CARTA         │    │
│       └──────────────────────┘    │
└───────────────────────────────────┘
         ↑                         ↑
      posição                  limite do bleed
      de corte                 (não é corte)
```

### Dois sistemas independentes

O contrato explícito é:

```ts
interface TrimGuideConfig {
  enabled: boolean;
  extentMm: number | "full";
}

interface ExternalCutGuideConfig {
  enabled: boolean;
  strokeWidthPt: number;
}

interface CutGuideConfig {
  trim: TrimGuideConfig;
  external: ExternalCutGuideConfig;
}
```

Ambos começam desabilitados por segurança; habilitar um nunca habilita o outro. A extensão interna é expressa em milímetros ao longo das bordas. A única opção variável externa é a espessura em points. As cores são fixas nesta fase: Trim Guide ciano `#00A6D6`, External Cut Guide laranja `#E87500`; não há controles de cor ou comprimento externo.

### Trim Guide / Card Edge Guide

- A linha fica exatamente sobre a fronteira de `trimRect`, na transição trim → bleed. É o único sistema autorizado a ser desenhado sobre a imagem.
- Para um valor numérico `extentMm`, cada canto gera um segmento desse comprimento em cada uma das duas arestas adjacentes. O comprimento acompanha a aresta; não aponta para dentro da carta.
- Unir os intervalos por aresta antes de desenhar. Segmentos de cantos opostos que se encontram ou se sobrepõem tornam-se uma só aresta contínua, sem duplicação.
- `extentMm: "full"` desenha um retângulo vetorial limpo com dimensões físicas iguais às de `trimRect`.
- Quando desabilitada, nenhuma linha interna aparece. Artwork, bleed, posição e dimensões físicas permanecem iguais.
- Espessura interna fixa e fina: `0.2 pt`.

### External Cut Guide

- Cada guia externa fica na coordenada central da respectiva borda do `trimRect`, mas somente em intervalos visíveis fora de todos os `bleedRect`.
- Projetar as quatro bordas de trim até os limites úteis da folha; subtrair os intervalos obstruídos pelas regiões de bleed de todas as cartas, incluindo a carta de origem. Isso deixa as marcas começarem depois do bleed e permite prolongá-las por gutters/áreas livres até a borda da folha.
- Considerar a meia espessura do traço ao excluir obstáculos, para que nenhum pixel do stroke invada bleed ou artwork. Guias externas não atravessam outra carta nem seu bleed.
- Linhas com coordenada compartilhada podem ser consolidadas e unidas somente ao longo de intervalos livres; obstruções e limites da folha continuam respeitados.
- A espessura inicial da UI é `0.3 pt`; validar qualquer valor como finito e positivo. Usar a cor fixa externa especificada acima.

### Rounded Corners

`rounded-corners-v1` altera somente a representação visual/alpha da imagem. Não muda a geometria das guias nem o retângulo físico de trim. Mesmo com Rounded Corners ON, Trim Guide e External Cut Guide referenciam o retângulo físico de `trimRect`; o modo `full` é um contorno retangular de `63.5 × 88.9 mm` para Magic Standard, não uma curva inferida dos pixels arredondados. O algoritmo e a configuração de cantos arredondados permanecem intocados.

### Contrato legado

O contrato `cutGuides: "full" | "none"` não distingue sistemas nem configurações. Não mapear esses valores silenciosamente para novos significados. Migrar callers, formulários e testes ao objeto `CutGuideConfig`; rejeitar valores legados no limite da API com erro explícito de validação.

### PDF e invariantes

As duas guias são paths/strokes vetoriais do PDF, nunca rasterizados na imagem. Os testes devem inspecionar coordenadas reais em points/mm e provar:

1. Magic Standard trim é exatamente `63.5 × 88.9 mm`.
2. `extentMm: 1` mede 1 mm ao longo das duas bordas de cada canto.
3. `full` produz quatro arestas sem duplicatas nas dimensões exatas do trim.
4. Coordenadas externas coincidem com as bordas de trim; início/fim de cada segmento ficam fora de toda zona de bleed.
5. Nenhum stroke externo cobre trim, artwork ou bleed de qualquer carta.
6. Trocar configurações de guia não altera bytes da artwork, bleed, dimensões/posição do trim nem posição das cartas.
7. Todas as guias continuam vetoriais no PDF.

A matriz de geometria inclui ambos ON/OFF, extensões 1/intermediária/meia aresta/full, traços externos fino/maior, bleed `0`, `0.625`, `1`, `2`, `3 mm`, Rounded Corners OFF/ON, 1 carta e grid 3×3 com bordas da folha e gutters compartilhados.

## Consequências

- UI e API passam a expor dois controles independentes, eliminando a ambiguidade de “guias vetoriais”.
- A geometria de corte deixa de depender do bleed; bleed só determina onde os strokes externos podem aparecer.
- O default sem guias é deliberado para não inserir linhas no artwork nem prolongar traços na folha sem escolha explícita do usuário.
- PDFs e configuração antiga `full`/`none` precisam ser atualizados, em vez de receber uma conversão silenciosa.
