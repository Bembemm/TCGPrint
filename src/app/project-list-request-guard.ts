export interface ProjectListRequestGuard {
  begin(): number;
  isCurrent(requestId: number): boolean;
  invalidate(): void;
}

export function createProjectListRequestGuard(): ProjectListRequestGuard {
  let currentRequestId = 0;
  return {
    begin() {
      currentRequestId += 1;
      return currentRequestId;
    },
    isCurrent(requestId) {
      return requestId === currentRequestId;
    },
    invalidate() {
      currentRequestId += 1;
    },
  };
}
