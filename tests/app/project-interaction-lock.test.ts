import { describe, expect, it, vi } from "vitest";
import {
  createProjectOpenInteractionLock,
  keepCurrentProjectWorkingSet,
  openProjectWithInteractionLock,
  resolveProjectRecoveryWithInteractionLock,
  runIfProjectInteractionUnlocked,
} from "../../src/app/project-interaction-lock";

describe("Project recovery interaction lock", () => {
  it("keeps the editor locked from opening through the complete recovery decision", () => {
    const changes: boolean[] = [];
    const lock = createProjectOpenInteractionLock((locked) => changes.push(locked));

    lock.beginOpen();
    lock.recoveryFound();
    lock.finishOpenRequest();

    expect(lock.isLocked()).toBe(true);
    expect(changes).toEqual([true]);

    lock.finishRecoveryDecision();

    expect(lock.isLocked()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("holds the lock when opening returns recovery and does not load until a choice", async () => {
    const changes: boolean[] = [];
    const lock = createProjectOpenInteractionLock((locked) => changes.push(locked));
    let resolveOpen!: (value: { recovery: boolean }) => void;
    const open = vi.fn(() => new Promise<{ recovery: boolean }>((resolve) => { resolveOpen = resolve; }));
    const loadProject = vi.fn();

    const opening = openProjectWithInteractionLock(lock, open, (project) => project.recovery, loadProject);
    expect(lock.isLocked()).toBe(true);
    resolveOpen({ recovery: true });
    const result = await opening;

    expect(result).toEqual({ project: { recovery: true }, recoveryPending: true });
    expect(lock.isLocked()).toBe(true);
    expect(loadProject).not.toHaveBeenCalled();
    expect(changes).toEqual([true]);
  });

  it("loads an ordinary Project before releasing the opening lock", async () => {
    const lock = createProjectOpenInteractionLock(vi.fn());
    const loadProject = vi.fn(() => expect(lock.isLocked()).toBe(true));

    const result = await openProjectWithInteractionLock(
      lock,
      async () => ({ recovery: false }),
      (project) => project.recovery,
      loadProject,
    );

    expect(result.recoveryPending).toBe(false);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(lock.isLocked()).toBe(false);
  });

  it("releases when opening a Project without recovery or when keeping the current Working Set", () => {
    const changes: boolean[] = [];
    const lock = createProjectOpenInteractionLock((locked) => changes.push(locked));

    lock.beginOpen();
    lock.finishOpenRequest();
    expect(lock.isLocked()).toBe(false);

    lock.beginOpen();
    lock.recoveryFound();
    lock.finishOpenRequest();
    lock.finishRecoveryDecision();

    expect(changes).toEqual([true, false, true, false]);
  });

  it.each(["restore", "discard", "copy"])("releases only after a successful %s decision", async (_choice) => {
      const changes: boolean[] = [];
      const lock = createProjectOpenInteractionLock((locked) => changes.push(locked));

      lock.beginOpen();
      lock.recoveryFound();
      lock.finishOpenRequest();
      expect(lock.isLocked()).toBe(true);

      await resolveProjectRecoveryWithInteractionLock(
        lock,
        async () => ({ id: "resolved-project" }),
        () => expect(lock.isLocked()).toBe(true),
      );

      expect(lock.isLocked()).toBe(false);
      expect(changes).toEqual([true, false]);
  });

  it("keeps the Working Set unchanged and releases when the user keeps it", () => {
    const lock = createProjectOpenInteractionLock(vi.fn());
    const workingSet = { id: "current-working-set", cards: ["local-edit"] };
    const clearDecision = vi.fn();
    lock.beginOpen();
    lock.recoveryFound();
    lock.finishOpenRequest();

    keepCurrentProjectWorkingSet(lock, clearDecision);

    expect(clearDecision).toHaveBeenCalledOnce();
    expect(workingSet).toEqual({ id: "current-working-set", cards: ["local-edit"] });
    expect(lock.isLocked()).toBe(false);
  });

  it("keeps the lock when the recovery operation fails before loading the replacement", async () => {
    const lock = createProjectOpenInteractionLock(vi.fn());
    const failure = new Error("recovery failed");
    lock.beginOpen();
    lock.recoveryFound();
    lock.finishOpenRequest();

    await expect(resolveProjectRecoveryWithInteractionLock(
      lock,
      async () => { throw failure; },
      vi.fn(),
    )).rejects.toBe(failure);

    expect(lock.isLocked()).toBe(true);
    lock.refreshRecovery(true);
    expect(lock.isLocked()).toBe(true);
  });

  it("retains the lock while a failed resolution still has recovery pending", () => {
    const changes: boolean[] = [];
    const lock = createProjectOpenInteractionLock((locked) => changes.push(locked));

    lock.beginOpen();
    lock.recoveryFound();
    lock.finishOpenRequest();
    lock.refreshRecovery(true);

    expect(lock.isLocked()).toBe(true);
    expect(changes).toEqual([true]);

    lock.refreshRecovery(false);
    expect(lock.isLocked()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("does not run persistable mutations while locked and permits them after release", () => {
    const lock = createProjectOpenInteractionLock(vi.fn());
    const settings = {
      bleedMm: 0.625,
      roundedCorners: false,
      trimGuideEnabled: false,
      trimGuideExtentMm: "1",
      trimGuideColor: "blue",
      externalGuideEnabled: false,
      externalGuideStrokeWidthPt: "0.3",
      externalGuideColor: "black",
    };
    const before = { ...settings };
    const updates = [
      () => { settings.bleedMm = 1; },
      () => { settings.roundedCorners = true; },
      () => { settings.trimGuideEnabled = true; },
      () => { settings.trimGuideExtentMm = "5"; },
      () => { settings.trimGuideColor = "green"; },
      () => { settings.externalGuideEnabled = true; },
      () => { settings.externalGuideStrokeWidthPt = "0.7"; },
      () => { settings.externalGuideColor = "white"; },
    ];
    lock.beginOpen();
    lock.recoveryFound();
    lock.finishOpenRequest();

    for (const update of updates) {
      expect(runIfProjectInteractionUnlocked(lock.isLocked(), update)).toBe(false);
    }
    expect(settings).toEqual(before);

    lock.finishRecoveryDecision();
    expect(runIfProjectInteractionUnlocked(lock.isLocked(), updates[0])).toBe(true);
    expect(settings.bleedMm).toBe(1);
  });
});
