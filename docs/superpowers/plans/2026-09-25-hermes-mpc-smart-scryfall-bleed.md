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

# Frente B — nota de supersessão

Esta parte do plano inicial não está mais vigente. A fonte normativa da Fase 5.5 é a seção correspondente em `IMPLEMENTATION_PLAN.md`, com a decisão registrada em [ADR 0008](../../decisions/0008-edge-extension-rounded-corners.md).

Não usar critérios, modos, medições nem artefatos desta versão histórica para implementar ou aceitar o bleed atual. O histórico anterior permanece no ADR 0007 supersedido e no histórico Git.

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
