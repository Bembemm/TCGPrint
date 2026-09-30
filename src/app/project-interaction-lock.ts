export type ProjectInteractionLockListener = (locked: boolean) => void;

export interface ProjectOpenInteractionLock {
  beginOpen(): void;
  recoveryFound(): void;
  finishOpenRequest(): void;
  finishRecoveryDecision(): void;
  refreshRecovery(isPending: boolean): void;
  isLocked(): boolean;
}

export async function openProjectWithInteractionLock<T>(
  lock: ProjectOpenInteractionLock,
  open: () => Promise<T>,
  hasRecovery: (project: T) => boolean,
  loadProject: (project: T) => void | Promise<void>,
): Promise<{ readonly project: T; readonly recoveryPending: boolean }> {
  lock.beginOpen();
  try {
    const project = await open();
    if (hasRecovery(project)) {
      lock.recoveryFound();
      return { project, recoveryPending: true };
    }
    await loadProject(project);
    return { project, recoveryPending: false };
  } finally {
    lock.finishOpenRequest();
  }
}

export async function resolveProjectRecoveryWithInteractionLock<T>(
  lock: ProjectOpenInteractionLock,
  resolve: () => Promise<T>,
  loadProject: (project: T) => void | Promise<void>,
): Promise<T> {
  const project = await resolve();
  await loadProject(project);
  lock.finishRecoveryDecision();
  return project;
}

export function keepCurrentProjectWorkingSet(
  lock: ProjectOpenInteractionLock,
  clearRecoveryDecision: () => void,
): void {
  clearRecoveryDecision();
  lock.finishRecoveryDecision();
}

export function createProjectOpenInteractionLock(
  onLockChange: ProjectInteractionLockListener,
): ProjectOpenInteractionLock {
  let locked = false;
  let recoveryPending = false;

  function setLocked(next: boolean) {
    if (locked === next) return;
    locked = next;
    onLockChange(locked);
  }

  return {
    beginOpen() {
      recoveryPending = false;
      setLocked(true);
    },
    recoveryFound() {
      recoveryPending = true;
      setLocked(true);
    },
    finishOpenRequest() {
      if (!recoveryPending) setLocked(false);
    },
    finishRecoveryDecision() {
      recoveryPending = false;
      setLocked(false);
    },
    refreshRecovery(isPending) {
      recoveryPending = isPending;
      setLocked(isPending);
    },
    isLocked() {
      return locked;
    },
  };
}

export function runIfProjectInteractionUnlocked(
  isLocked: boolean,
  mutation: () => void,
): boolean {
  if (isLocked) return false;
  mutation();
  return true;
}
