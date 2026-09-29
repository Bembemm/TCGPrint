import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectAutosaveQueue, type ProjectAutosaveQueueOptions } from "../../src/app/project-autosave";

interface Snapshot { readonly value: number; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queueOptions(
  save: ProjectAutosaveQueueOptions<Snapshot>["save"],
  overrides: Omit<Partial<ProjectAutosaveQueueOptions<Snapshot>>, "save"> = {},
) {
  return {
    save,
    ...overrides,
  };
}

describe("ProjectAutosaveQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("saves only after 600 ms without another edit", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async ({ expectedRevision }: { expectedRevision: number }) => ({ revision: expectedRevision + 1 }));
    const queue = new ProjectAutosaveQueue<Snapshot>(queueOptions(save));
    queue.activate({ projectId: "project-1", revision: 4, savedSnapshotKey: "saved" });
    queue.observe("snapshot-1", { value: 1 });

    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      projectId: "project-1",
      expectedRevision: 4,
      snapshotKey: "snapshot-1",
      snapshot: { value: 1 },
    });
    expect(queue.getContext()).toMatchObject({ revision: 5, savedSnapshotKey: "snapshot-1" });
    queue.dispose();
  });

  it("flushes the newest snapshot at maxWait while edits keep resetting the debounce", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async ({ expectedRevision }: { expectedRevision: number }) => ({ revision: expectedRevision + 1 }));
    const queue = new ProjectAutosaveQueue<Snapshot>(queueOptions(save));
    queue.activate({ projectId: "project-1", revision: 1, savedSnapshotKey: "saved" });

    for (let value = 1; value <= 4; value += 1) {
      queue.observe(`snapshot-${value}`, { value });
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      snapshotKey: "snapshot-4",
      snapshot: { value: 4 },
    }));
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  it("serializes saves and writes the newest edit made while an earlier save is in flight", async () => {
    vi.useFakeTimers();
    const first = deferred<{ revision: number }>();
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async ({ expectedRevision }: { expectedRevision: number }) => ({ revision: expectedRevision + 1 }));
    const queue = new ProjectAutosaveQueue<Snapshot>(queueOptions(save));
    queue.activate({ projectId: "project-1", revision: 1, savedSnapshotKey: "saved" });
    queue.observe("snapshot-1", { value: 1 });
    const flushed = queue.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);

    queue.observe("snapshot-2", { value: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve({ revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await flushed;

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([request]) => request)).toEqual([
      { projectId: "project-1", expectedRevision: 1, snapshotKey: "snapshot-1", snapshot: { value: 1 } },
      { projectId: "project-1", expectedRevision: 2, snapshotKey: "snapshot-2", snapshot: { value: 2 } },
    ]);
    expect(queue.getContext()).toMatchObject({ revision: 3, savedSnapshotKey: "snapshot-2" });
    queue.dispose();
  });

  it("retries transient save failures with bounded backoff", async () => {
    vi.useFakeTimers();
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockImplementation(async ({ expectedRevision }: { expectedRevision: number }) => ({ revision: expectedRevision + 1 }));
    const queue = new ProjectAutosaveQueue<Snapshot>(queueOptions(save));
    queue.activate({ projectId: "project-1", revision: 1, savedSnapshotKey: "saved" });
    queue.observe("snapshot-1", { value: 1 });

    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(save).toHaveBeenCalledTimes(3);
    expect(queue.getContext()).toMatchObject({ revision: 2, savedSnapshotKey: "snapshot-1" });
    queue.dispose();
  });

  it("does not retry a CAS conflict automatically", async () => {
    vi.useFakeTimers();
    const conflict = Object.assign(new Error("revision conflict"), { status: 409 });
    const save = vi.fn().mockRejectedValue(conflict);
    const onSaveFailed = vi.fn();
    const queue = new ProjectAutosaveQueue<Snapshot>(queueOptions(save, { onSaveFailed }));
    queue.activate({ projectId: "project-1", revision: 7, savedSnapshotKey: "saved" });
    queue.observe("snapshot-1", { value: 1 });

    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(save).toHaveBeenCalledTimes(1);
    expect(onSaveFailed).toHaveBeenCalledWith(expect.anything(), conflict, "conflict");
    expect(queue.getContext()).toMatchObject({ revision: 7, savedSnapshotKey: "saved" });
    queue.dispose();
  });

  it("ignores a save response after the queue activates a different Project", async () => {
    vi.useFakeTimers();
    const first = deferred<{ revision: number }>();
    const save = vi.fn().mockImplementationOnce(() => first.promise);
    const onSaveSucceeded = vi.fn();
    const queue = new ProjectAutosaveQueue<Snapshot>(queueOptions(save, { onSaveSucceeded }));
    queue.activate({ projectId: "old-project", revision: 1, savedSnapshotKey: "old-saved" });
    queue.observe("old-pending", { value: 1 });
    const flushed = queue.flushNow();
    await vi.advanceTimersByTimeAsync(0);

    queue.activate({ projectId: "new-project", revision: 3, savedSnapshotKey: "new-saved" });
    first.resolve({ revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await flushed;

    expect(onSaveSucceeded).not.toHaveBeenCalled();
    expect(queue.getContext()).toMatchObject({ projectId: "new-project", revision: 3, savedSnapshotKey: "new-saved" });
    queue.dispose();
  });

  it("keeps a new Project save moving while an obsolete Project request is still unresolved", async () => {
    vi.useFakeTimers();
    const oldRequest = deferred<{ revision: number }>();
    const save = vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementation(async ({ expectedRevision }: { expectedRevision: number }) => ({ revision: expectedRevision + 1 }));
    const queue = new ProjectAutosaveQueue<Snapshot>(queueOptions(save));
    queue.activate({ projectId: "old-project", revision: 1, savedSnapshotKey: "old-saved" });
    queue.observe("old-pending", { value: 1 });
    void queue.flushNow();
    await vi.advanceTimersByTimeAsync(0);

    queue.activate({ projectId: "new-project", revision: 3, savedSnapshotKey: "new-saved" });
    queue.observe("new-pending", { value: 2 });
    const flushed = queue.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toMatchObject({ projectId: "new-project", expectedRevision: 3, snapshotKey: "new-pending" });
    expect(queue.getContext()).toMatchObject({ projectId: "new-project", revision: 4, savedSnapshotKey: "new-pending" });
    oldRequest.resolve({ revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    queue.dispose();
  });
});
