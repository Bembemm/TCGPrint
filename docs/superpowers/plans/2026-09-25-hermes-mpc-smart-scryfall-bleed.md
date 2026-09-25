# Hermes Handoff — MPC Autofill Online + Smart Scryfall Bleed

## Estado de partida

- Repositório: `Bembemm/TCGPrint`
- Base obrigatória: `main`
- Main no início deste handoff: `48a4ce7b1d0fcf8c009e6a0dfdc2ef1f2e951283`
- Fases 0–5 concluídas e mergeadas.
- Hotfixes da Fase 5 concluídos:
  - resolução de identidade desacoplada de listagem de printings;
  - seleção de artwork usa `faceId` corretamente.
- Primeiro PDF real de 9 cartas foi gerado com sucesso.
- Próxima prioridade NÃO é Editor. É MPC online + melhoria visual do bleed Scryfall.

## Papel do Hermes

Hermes é o orquestrador operacional.

Fluxo:

```text
Hermes
→ cria branches isoladas
→ delega implementação a agentes/Codex
→ exige testes/typecheck/build
→ recebe relatório
→ NÃO faz merge em main
→ entrega commits/diffs para revisão do ChatGPT
```

Preferência: executar as duas frentes em paralelo porque tocam áreas majoritariamente diferentes.

---

# Frente A — MPC Artwork Provider online

Branch sugerida:

```text
codex/mpc-artwork-provider
```

Objetivo: transformar a aba MPC Autofill já existente em provider funcional online.

Requisitos:

1. Implementar `MpcArtworkProvider` atrás do contrato atual de `ArtworkProvider`.
2. Não alterar `CardIdentity` ao trocar artwork.
3. Busca por carta/identidade.
4. Thumbnails para UI.
5. Download do original validado para impressão.
6. Cache/provenance.
7. Preservar:
   - `providerAssetId`;
   - `selectedArtworkId`;
   - slots;
   - XML importado;
   - shared MPC cardback;
   - seleções MPC já existentes.
8. Não substituir MPC por Scryfall silenciosamente.
9. DFC/MDFC por face.
10. Falha/offline do MPC não quebra Scryfall/uploads.
11. UI:
   ```text
   Todas | Scryfall | MPC Autofill | Meus uploads
   ```
12. Não baixar original para montar grid; thumbnail primeiro, original somente quando necessário.
13. Validar endpoint/protocolo atual usado pelo ecossistema MPC Autofill antes de consolidar.
14. Documentar qualquer risco de estabilidade externa.
15. Testes com fake HTTP sempre que possível; não depender de serviço real no CI.
16. Não implementar Projects/Editor junto.

Critério final:

```text
Sol Ring
→ Scryfall
→ MPC Autofill
→ upload local
→ trocar entre as fontes
→ mesmo WorkingCard
→ mesma CardIdentity
→ PDF usa original selecionado
```

---

# Frente B — Smart Scryfall Bleed / Auto Border Fill

Branch sugerida:

```text
codex/scryfall-smart-bleed
```

Problema observado no PDF real:

O `subtle-edge-stretch` atual usa a região periférica da imagem. Em scans Scryfall com moldura preta/escura, isso pode produzir bleed externo predominantemente preto.

Objetivo: criar bleed visualmente mais natural para Scryfall SEM tocar no trim.

Novo modo/política:

```text
smart-border-fill
```

Arquitetura:

- manter `BleedEngine` como único engine;
- não criar pipeline paralelo dentro do provider Scryfall;
- provider apenas informa/sugere a política;
- engine recebe política/mode e gera derivado;
- original permanece imutável;
- cache inclui algoritmo/version/policy.

Algoritmo esperado:

1. analisar cada lado separadamente;
2. medir cor/luminância/variação da faixa periférica;
3. se detectar moldura predominantemente escura e uniforme:
   - avançar para dentro da carta somente para escolher a faixa FONTE do bleed;
   - nunca recortar nem mover o trim;
4. gerar bleed externo por extensão/mirror apropriado da faixa fonte;
5. cantos tratados separadamente;
6. se não houver confiança:
   - fallback para `subtle-edge-stretch`;
7. borderless/full-art não deve ser tratado como borda preta clássica;
8. nenhuma IA/cloud/inpainting remoto.

Guardrails:

- trim pixels before == trim pixels after;
- Magic continua 63.5 × 88.9 mm;
- bleed continua 0–3 mm;
- PDF não pode sofrer downsampling;
- JPEG/PNG fidelity permanece;
- SVG continua com regra atual até implementação específica;
- preview = export em política efetiva.

Provider defaults:

```text
Scryfall raster → smart-border-fill auto
Upload local    → subtle-edge-stretch por padrão
MPC             → respeitar metadata/bleed existente quando conhecida
```

Não assumir que todo MPC precisa de bleed gerado.

Testes obrigatórios:

- fixture com borda preta clássica;
- full-art/borderless;
- borda clara;
- lados diferentes;
- cantos;
- 0 mm passthrough;
- 0.625 / 1 / 2 / 3 mm;
- pixel-integrity do trim;
- determinismo;
- cache-key/version;
- fallback;
- prova de que uma borda preta não domina o bleed quando a detecção encontra faixa interna válida.

Gerar matriz visual de comparação:

```text
original edge
subtle-edge-stretch
smart-border-fill
```

para revisão humana antes de considerar concluído.

---

## Integração final

Depois que as duas branches passarem por revisão individual:

1. atualizar cada branch com main;
2. resolver conflitos somente se necessários;
3. rodar suíte completa integrada;
4. gerar PDF real:
   - 1 Sol Ring
   - 1 Lightning Bolt
   - 1 Counterspell
   - 6 Island
5. validar:
   - Scryfall;
   - MPC;
   - upload;
   - troca de artwork;
   - smart bleed;
   - PDF 3x3;
   - guias;
   - trim intacto.
6. não fazer merge sem revisão do ChatGPT.

Comandos finais obrigatórios por branch:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Relatório de saída deve conter:

- branch;
- commits;
- arquivos principais;
- testes;
- limitações;
- riscos externos;
- screenshots/PDFs de comparação quando houver;
- nenhuma alteração em main.
