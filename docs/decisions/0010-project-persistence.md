# ADR 0010: Persistência de Projects

- Status: Aceito
- Data: 2026-09-29
- Escopo: Fase 7A — núcleo de persistência de Projects
- Relacionado: ADR 0001 (SQLite driver), ADR 0005 (identidade e artwork cache)

## Contexto

A Fase 7 precisa persistir Projects, enquanto o banco existente `artwork-cache.sqlite` armazena dados reconstruíveis de artwork. Os ciclos de vida, políticas de limpeza, backup e evolução desses dados são diferentes. O estado editorial atual já é representado por `WorkingCard`, cuja identidade, referências de artwork e bytes/arquivos de artwork têm responsabilidades distintas.

## Decisão

### Banco e versão física

- Persistir Projects em `.tcgprint/projects.sqlite`, separado de `.tcgprint/artwork-cache.sqlite`.
- Não criar um banco geral da aplicação nesta fase.
- Manter migrations físicas próprias em `persistence/projects/migrations.ts`, controladas por `PRAGMA user_version`.
- O schema SQLite v1 contém somente `projects` e `project_recovery`; cards e faces não são normalizados em tabelas.
- A exclusão de um Project remove seu recovery associado por `ON DELETE CASCADE`, sem tocar no banco, cache ou originais de artwork.

### Formato lógico

- O conteúdo editorial é armazenado como snapshot JSON validado e versionado.
- `CURRENT_PROJECT_SCHEMA_VERSION` é independente da versão física SQLite. Migrações futuras do snapshot seguem uma fronteira lógica dedicada, sem expor rows SQLite aos engines ou à UI.
- `ProjectSnapshotV1` contém `WorkingCard`s persistíveis e somente os settings atualmente existentes: `bleedMm`, `roundedCorners` e `cutGuides` (trim/external).
- Defaults: bleed `0.625 mm`, rounded corners desabilitado, trim desabilitado com extensão `1 mm` e azul, external desabilitado com espessura `0.3 pt` e preto.
- O serializer Project é dedicado. Não reutiliza o parser de API `parseWorkingCards()` como serializer.
- Não persistir seleção de card/face ativa, histórico Undo/Redo, estado de requisição/provedor, erros ou estado puramente visual/transitório. `WorkingCard.metadata` não integra o snapshot; metadados permitidos de identidade passam por allowlist compartilhada e validação própria.
- O payload de snapshot tem limite centralizado de 16 MiB e respeita o limite atual de 500 cartas físicas por exportação; valores de `order` são preservados sem reindexação.
- A validação do snapshot não incorpora bytes de artwork ou caminhos privados.

### Repository, revisão e recuperação

- O repository tipado encapsula rows SQLite, valida snapshots ao entrar e sair do banco e reporta conflitos de revisão com compare-and-swap.
- Projects iniciam na revisão 1; save e promoção de recovery avançam a revisão, e uma gravação baseada em revisão obsoleta não sobrescreve o estado canônico.
- Uma candidatura de recovery é armazenada separadamente por Project, associada à revisão-base e promovida ou descartada explicitamente. A promoção atualiza o snapshot canônico e remove a candidatura na mesma transação.
- A duplicação cria novo ID de Project, preserva os IDs dos `WorkingCard`s e copia o snapshot canônico. Não duplica nem remove bytes compartilhados de artwork.

## Consequências

- Dados duráveis do usuário ficam isolados da limpeza do cache descartável.
- A listagem e concorrência usam metadados relacionais; a evolução do conteúdo editorial é controlada pelo formato lógico versionado.
- Migrações físicas e lógicas podem evoluir independentemente.
- A Fase 7A entrega a camada de persistência e seus testes; UI, autosave integrado e fluxo de abertura/recuperação permanecem fora deste escopo.

## Verificação

A implementação correspondente é exercitada por testes de migration/isolamento SQLite, serializer v1, repository/CAS, recuperação, duplicação e exclusão. Os gates completos definidos para a fase são `npm test`, `npm run typecheck`, `npm run build` e `git diff --check`.
