# M7 — Compositor interativo

## Baseline e limites preservados

M7 estende o Working Set e o compositor M5/M6 com uma sequência física persistente. `WorkingCard` continua sendo o único proprietário de identidade, artwork, faces, backs, origem e metadados. `RegistrationLayoutPreview` segue calculando a apresentação sobre a geometria canônica existente; M7 troca somente qual instância ocupa cada slot elegível. Não foi criado motor de posicionamento livre, geometria paralela ou ADR novo.

## Matriz de ownership

| Capability | Owner atual | Delta M7 | Owner canônico após M7 | Evidência |
|---|---|---|---|---|
| Working Cards e quantidade compacta | `WorkingCardEditorState.cards` | Reordenar referências físicas sem expandir/splitar entradas | Working Set editor | `physical-instance-order.test.ts` |
| Ordem física e IDs de cópia | Derivada de `WorkingCard.order → quantity` | `PhysicalOrder` persistido com IDs estáveis | `WorkingCardEditorState.physicalOrder`, incluído no Project v6 | `physical-instance-order.test.ts`, `project-serializer.test.ts`, `project-repository.test.ts` |
| Artwork/face/back | `WorkingCard` e seleção M6 | Split M6 troca apenas o vínculo da referência selecionada | Mesmo `WorkingCard` + referência física M6 | `artwork-selection-scope.test.ts`, `project-serializer.test.ts` |
| Seleção do compositor | Índice físico local M5 | Guardar ID da instância e derivar índice atual; sincronizar carta e face | `selectedPhysicalInstanceId` no Workbench (UI state) | `canonical-compositor.interaction.test.tsx`, `workspace-card-selection.interaction.test.tsx` |
| Página e slot | Plano canônico de placement | Resolver cada índice da sequência no slot canônico | `buildCanonicalPrintPlan` e o plano de placement atual | `page-placement.test.ts`, `canonical-compositor.interaction.test.tsx` |
| Reorder | Nenhuma ordem física editável | Inserção antes/depois e fim de sequência pela mesma operação | `movePhysicalInstance` no domínio | `physical-instance-order.test.ts`, `canonical-compositor.interaction.test.tsx` |
| Project save/autosave/recovery | Serializer e `ProjectRepository` | Snapshot v6 inclui a ordem; v1–v5 derivam ordem legacy em memória | Project snapshot canônico | `project-serializer.test.ts`, `project-repository.test.ts`, `project-session.test.ts`, `project-autosave-persistence.test.ts` |
| PDF | Export expandia entrada por quantidade | Expandir cópias pela ordem física antes do desenho/paginação | `orderedPhysicalCopies` → plano compartilhado e engine PDF existentes | `card-export.test.ts`, `card-api.test.ts` |
| Duplex/DFC | Plano compartilhado de páginas e pairing existente | A sequência reordered entra uma vez antes do pairing; DFC é uma instância indivisível | `createDuplexPagePairing` sobre placement canônico | `card-export.test.ts`, `duplex.test.ts` |
| Interação e HUD | Controles do preview M5 | Clique seleciona, botão `…`/clique secundário abre HUD; teclado oferece Mover antes/depois | Adaptador de interação de `RegistrationLayoutPreview` | `canonical-compositor.interaction.test.tsx` |

## Modelo e reconciliação

`PhysicalOrder` contém `nextInstanceId` e uma sequência de `{ id, workingCardId }`. IDs como `instance-24` são alocados monotonicamente e persistidos; o índice físico é sempre derivado da posição atual e pode mudar no reorder. A sequência referencia WorkingCards e não duplica seus dados.

Um Project antigo sem `physicalOrder` deriva IDs determinísticos na sequência legacy: `WorkingCard.order`, depois cada cópia da `quantity`. O serializer preserva leitura v1–v5 e migra em memória; uma gravação subsequente usa schema v6. Versões futuras continuam rejeitadas.

Reconciliação de quantidade mantém IDs/ordem das instâncias existentes. Ao aumentar, cria novas referências junto ao último exemplar da entrada (ou junto ao ponto lógico se ainda não houver exemplar). Ao reduzir quantity por edição genérica, remove os últimos exemplares daquela entrada na sequência; a ação “Remover uma cópia” remove exatamente o ID selecionado. O limite de export de 500 é validado no editor e novamente na API/export.

Duplicar como entrada independente cria um novo WorkingCard de quantity 1 imediatamente depois da instância selecionada. Remover uma entrada remove todas as suas referências. As duas operações passam pelo history editorial.

No split M6, a operação recebe `physicalInstanceId`, reduz a quantity da entrada original e liga aquela mesma referência ao novo WorkingCard. A posição da referência e a ordem relativa das demais não mudam. Artwork/back continuam sendo propriedades do WorkingCard.

## Seleção, HUD e reorder

`selectedPhysicalInstanceId` fica no Workbench como estado de UI e nunca entra no Project snapshot. O índice, página, cópia e WorkingCard são derivados da ordem física atual. Selecionar uma instância atualiza o WorkingCard da sidebar e a face disponível. Alternar Front/Back mantém o mesmo ID físico.

Primary click seleciona. Context menu é prevenido somente no slot de carta quando existe HUD para abrir. Em toque há o botão explícito `…`; long-press não é requisito para acessar ações. A HUD apresenta carta, cópia, face e indicação DFC; inclui seleção M6, configurar Back/face sem picker paralelo, quantidade, cópia, duplicação independente, remoção da entrada, settings e controles acessíveis Mover antes/depois.

Arrastar usa `movePhysicalInstance`: a origem é removida da sequência e inserida antes/depois da instância alvo. Soltar em slot vazio só é válido quando ele fica depois da última carta no último page; isso significa inserir no final. Slots skipped e reservados rejeitam drop com feedback. O estado de drag é visual e a operação ocorre uma vez no drop. O modo Back usa a mesma sequência Front, então o pairing acompanha a instância física.

O Workbench preserva a instância selecionada. Se reorder, repaginação ou alteração da ordem mudar sua localização, o compositor navega para a nova página; navegar manualmente entre páginas não apaga a seleção nem força retorno à página anterior. `interactionBusy` desativa drag e mutações da HUD durante operações bloqueantes; autosave captura snapshots serializados com sua ordem e revisão próprias.

Após revisão independente, o SVG do compositor usa `role="group"` para que os slots filhos mantenham sua semântica interativa de botão na árvore de acessibilidade. Recarregar o Working Set pelo fluxo de adicionar cartas limpa a seleção física UI antes de instalar as novas instâncias, evitando que IDs determinísticos reutilizados selecionem outra carta do conjunto novo.

A HUD mantém seu alvo como o par `{ instanceId, workingCardId }`; as ações, inclusive Mover antes/depois, usam a instância derivada desse contexto, sem consultar a seleção global. Selecionar explicitamente outra cópia fecha a HUD; contextmenu seleciona e abre a HUD para o novo alvo em uma ação. Se a referência some ou passa a apontar para outra entrada durante remoção, replace ou reconciliação, o contexto é limpo. Assim undo que restaure o mesmo ID não reabre uma HUD antiga. O alvo da HUD permanece estado local e não é persistido.

## PDF, duplex e fidelidade

O `handleCardExport` valida referências antes de qualquer leitura de artwork. O serviço exporta cópias ordenadas a partir do mesmo `PhysicalOrder`; a geometria recebe a sequência global antes de paginação. O Back duplex é montado a partir dos mesmos índices e consome o plano compartilhado, sem paginador independente. A cobertura M7 inclui ordem customizada PDF, cartas simples + DFC, long-edge e short-edge.

M7 não altera engine de geometria, placement, bleed, trim, cut, registration, calibration, templates ou serialização de imagens. Os originais continuam sendo a fonte do PDF; thumbnails permanecem preview do compositor.

## Evidências de teste

Cobertura focada:

- `tests/core/cards/physical-instance-order.test.ts`: migração legacy determinística, IDs estáveis, reorder sem split, aumento/redução, remoção exata, cópia independente, delete e undo/redo.
- `tests/core/cards/artwork-selection-scope.test.ts`: split de artwork e generic back preserva posição intercalada M6.
- `tests/app/canonical-compositor.interaction.test.tsx`: seleção por ID, lado pareado, M6 no contexto físico customizado, clique secundário, fallback `…`, teclado, drag entre páginas, busy, skipped/reserved e ordem do preview.
- `tests/app/canonical-compositor.interaction.test.tsx`: regressões HUD A→seleção B fecha e seleciona B; reorder explícito da instância B; contextmenu A→B substitui o único contexto HUD e move B; remover a cópia da HUD fecha suas ações, e restaurar seu ID não reabre a HUD.
- `tests/app/compositor-zoom.interaction.test.tsx`: grupo acessível do compositor preserva o comportamento de zoom.
- `tests/app/workspace-card-selection.interaction.test.tsx`: recarregar outro Working Set enquanto `instance-2` estava selecionada deixa a cópia homóloga do conjunto novo desmarcada; o teste falha sem limpar a seleção no fluxo `load-cards`.
- `tests/persistence/project-serializer.test.ts`, `project-repository.test.ts`, `project-session.test.ts`, `project-autosave-persistence.test.ts`: v1–v5, round-trip v6, Project save/reopen, duplicate e recovery da ordem física.
- `tests/services/card-export.test.ts`: sequência física refletida na lista de imagens PDF e pairing simple/DFC long-edge/short-edge.
- `tests/app/card-api.test.ts`: estado physical-order malformado rejeitado antes de iniciar leitura de originals; limite de 500 cópias preservado.
- `tests/core/page-placement.test.ts`, `tests/core/placement.test.ts`, `tests/core/duplex.test.ts`, `tests/cut/layout-sync.test.ts`: geometria/pairing/cut existentes.

Gates finais no delta commitado: 21 suites focadas / 389 testes passaram; `npm test` passou com 117 arquivos e 1.306 testes aprovados (1 arquivo e 1 teste ignorados); `npm run typecheck`, `npm run build` e `git diff --check` passaram. O build foi executado preservando o hash preexistente `0f70629890b72a0a82e91972cc032c04b658b26c265373cb711cf576bfbf8fcc` de `next-env.d.ts`, que permanece modificação local fora da branch. Os testes regeneraram seis referências em `artifacts/phase-10-registration` e `artifacts/phase-13-calibration`; elas foram restauradas para seus bytes commitados antes da conferência final.
