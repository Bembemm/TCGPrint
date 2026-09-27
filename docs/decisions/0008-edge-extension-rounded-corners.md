# ADR 0008: Edge Extension e Rounded Corners opcionais

- Status: Aceito para implementação; auditoria da Fase 5.5 pendente
- Date: 2026-09-27
- Scope: Fase 5.5, bleed raster e geometria opcional dos cantos
- Substitui: ADR 0007, cuja busca de conteúdo interior foi abandonada

## Contexto

Bleed foi definido incorretamente como uma tentativa de evitar a moldura escura de scans Scryfall buscando uma faixa mais interna. Essa interpretação não corresponde ao objetivo do TCGPrint: criar margem de corte sem perda visual da carta.

A regra do produto é continuar exatamente os pixels imediatamente adjacentes ao trim. Uma moldura preta pode gerar bleed preto; full-art continua a partir dos pixels da própria arte. O algoritmo não deve inferir conteúdo de outras regiões.

Arredondar cantos é uma necessidade distinta e opcional. Não é uma operação de amostragem do bleed e não deve ser ativada por padrão.

## Decisão

### Bleed por extensão da borda imediata

- Raster bleed adiciona pixels somente fora do trim; a área de trim é copiada sem crop, deslocamento, resize ou resampling.
- A fonte de cada lado é sua linha/coluna externa de pixels: TOP usa a primeira linha, BOTTOM a última, LEFT a primeira coluna e RIGHT a última. Os pixels são repetidos para fora de acordo com o bleed físico solicitado.
- Cada lado é processado independentemente. Não existe busca por faixa interna, classificação por cor/luminância, seleção de conteúdo representativo ou inferência a partir de outras áreas.
- Cada canto externo é estendido deterministicamente a partir do pixel do canto correspondente do trim; as quatro extensões devem se unir sem lacunas ou costuras.
- Borda preta permanece preta; full-art, borda clara e arte texturizada continuam a partir de sua própria beirada.
- Nenhuma IA, inpainting, serviço remoto ou alteração de pixels internos participa do bleed.
- Bleed de 0 mm é passthrough do original. Bleed não-zero preserva alpha e profundidade de cor suportados pelo pipeline.
- Preview e export usam exatamente a mesma implementação/resultado de Edge Extension.
- O algoritmo é determinístico e versionado. A cache key representa os bytes originais, bleed físico, versão do algoritmo e toda configuração que efetivamente altera pixels; rótulos de policy que não alteram pixels não devem impedir deduplicação.

### Rounded corners separado e opcional

- A configuração explícita `roundedCorners: boolean` controla o recurso; seu padrão é `false`.
- Quando desligado, não há arredondamento automático e a comparação pixel a pixel do trim deve passar integralmente.
- Quando ligado, o sistema pode completar os cantos até o raio físico definido por `CardFormat`, somente se a origem ainda não tiver cantos completos compatíveis.
- `Magic Standard` inicia com `cornerRadiusMm = 3.175`; é um valor interno configurável, não uma inferência sobre pixels da imagem. Outros formatos precisam declarar seu raio.
- Uma origem que já tenha os cantos adequados não pode ser degradada nem arredondada duas vezes. Detecção e aplicação devem ser determinísticas; quando não houver evidência confiável ou raio configurado, preservar a origem.
- O arredondamento é uma transformação geométrica separada do Edge Extension. Não escolhe pixels-fonte do bleed nem altera a identidade dos demais pixels da carta; a mídia original permanece imutável.
- Preview e export obedecem ao mesmo valor da opção. A configuração e a versão da transformação entram na identidade/cache somente quando alterarem o derivado.

## Verificação para a Fase 5.5

A aceitação deve demonstrar, com fixtures controladas:

- moldura preta → bleed preto;
- full-art → continuidade da própria arte na borda;
- bordas claras e assimétricas, quatro lados e quatro cantos;
- 0, 0.625, 1, 2 e 3 mm;
- trim pixel-identical com `roundedCorners: false`;
- mesmo resultado/policy no preview e no export;
- cache versionado e derivação compartilhada apenas quando todos os inputs que alteram pixels forem equivalentes;
- opção de cantos desligada sem arredondar, ligada arredondando uma origem quadrada e ligada sem degradar uma origem já arredondada;
- regressões MPC continuam passando: formatos não suportados não são candidatos exportáveis e original MPC local validado continua exportável offline após expiração dos metadados.

## Decisão anterior abandonada

A versão anterior deste ADR descrevia `smart-border-fill`: classificar molduras e buscar uma faixa mais interna para evitar bleed preto. Essa decisão está supersedida e permanece somente como histórico no ADR 0007/Git. Seus limiares, resultados visuais e diagnósticos de busca interna não são requisitos nem evidência de aceitação para a nova direção.
