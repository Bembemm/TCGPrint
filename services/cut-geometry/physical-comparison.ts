import { compareCutGeometryMm, type CutGeometryMm, type CutPathMm, type CutPointMm } from "../../core/cut";

export interface PhysicalCutGeometryComparison {
  readonly status: "equivalent" | "divergent" | "not-compared";
  readonly message?: string;
}

function closeNumber(left: number, right: number, toleranceMm: number): boolean {
  return Math.abs(left - right) <= toleranceMm;
}

function sameBounds(left: CutPathMm, right: CutPathMm, toleranceMm: number): boolean {
  return closeNumber(left.boundsMm.xMm, right.boundsMm.xMm, toleranceMm)
    && closeNumber(left.boundsMm.yMm, right.boundsMm.yMm, toleranceMm)
    && closeNumber(left.boundsMm.widthMm, right.boundsMm.widthMm, toleranceMm)
    && closeNumber(left.boundsMm.heightMm, right.boundsMm.heightMm, toleranceMm);
}

function compareBounds(left: CutPathMm, right: CutPathMm): number {
  return left.boundsMm.yMm - right.boundsMm.yMm
    || left.boundsMm.xMm - right.boundsMm.xMm
    || left.boundsMm.widthMm - right.boundsMm.widthMm
    || left.boundsMm.heightMm - right.boundsMm.heightMm;
}

function samePoint(left: CutPointMm, right: CutPointMm, toleranceMm: number): boolean {
  return closeNumber(left.xMm, right.xMm, toleranceMm) && closeNumber(left.yMm, right.yMm, toleranceMm);
}

function allLinear(path: CutPathMm): boolean {
  return path.segments.every((segment) => segment.type === "line");
}

function vertices(path: CutPathMm, toleranceMm: number): CutPointMm[] {
  const points: CutPointMm[] = [path.start];
  for (const segment of path.segments) {
    if (segment.type !== "line") return [];
    const previous = points.at(-1)!;
    if (!samePoint(previous, segment.from, toleranceMm)) return [];
    if (!samePoint(points.at(-1)!, segment.to, toleranceMm)) points.push(segment.to);
  }
  if (path.closed && points.length > 1 && samePoint(points[0]!, points.at(-1)!, toleranceMm)) points.pop();
  return points;
}

function removeCollinearVertices(points: readonly CutPointMm[], closed: boolean, toleranceMm: number): CutPointMm[] {
  const count = points.length;
  if (count <= (closed ? 3 : 2)) return [...points];
  const previous = Array.from({ length: count }, (_, index) => index === 0 ? (closed ? count - 1 : -1) : index - 1);
  const next = Array.from({ length: count }, (_, index) => index === count - 1 ? (closed ? 0 : -1) : index + 1);
  const active = Array.from({ length: count }, () => true);
  const queue = Array.from({ length: count }, (_, index) => index);
  const lineTolerance = toleranceMm / 2;
  let remaining = count;
  let cursor = 0;
  while (cursor < queue.length) {
    const index = queue[cursor++]!;
    if (!active[index] || remaining <= (closed ? 3 : 2)) continue;
    const previousIndex = previous[index]!;
    const nextIndex = next[index]!;
    if (previousIndex < 0 || nextIndex < 0) continue;
    const a = points[previousIndex]!;
    const b = points[index]!;
    const c = points[nextIndex]!;
    const dx = c.xMm - a.xMm;
    const dy = c.yMm - a.yMm;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= Number.EPSILON) continue;
    const projection = ((b.xMm - a.xMm) * dx + (b.yMm - a.yMm) * dy) / lengthSquared;
    const distance = Math.abs(dx * (b.yMm - a.yMm) - dy * (b.xMm - a.xMm)) / Math.sqrt(lengthSquared);
    if (projection < 0 || projection > 1 || distance > lineTolerance) continue;
    active[index] = false;
    remaining -= 1;
    next[previousIndex] = nextIndex;
    previous[nextIndex] = previousIndex;
    queue.push(previousIndex, nextIndex);
  }
  const first = active.findIndex(Boolean);
  if (first < 0) return [];
  const result: CutPointMm[] = [];
  let index = first;
  do {
    if (active[index]) result.push(points[index]!);
    index = next[index]!;
  } while (index >= 0 && index !== first && result.length <= remaining);
  return result;
}

function cyclicPathEquals(left: readonly CutPointMm[], right: readonly CutPointMm[], toleranceMm: number): boolean | undefined {
  if (left.length !== right.length || left.length === 0) return false;
  const candidateStarts = right.flatMap((point, index) => samePoint(left[0]!, point, toleranceMm) ? [index] : []);
  // Repeated self-intersection vertices can make cyclic matching ambiguous and
  // quadratic; such a path is deliberately reported as not comparable.
  if (candidateStarts.length > 32) return undefined;
  for (const start of candidateStarts) {
    for (const direction of [1, -1] as const) {
      let matches = true;
      for (let index = 0; index < left.length; index += 1) {
        const otherIndex = (start + direction * index + right.length * 2) % right.length;
        if (!samePoint(left[index]!, right[otherIndex]!, toleranceMm)) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }
  return false;
}

function openPathEquals(left: readonly CutPointMm[], right: readonly CutPointMm[], toleranceMm: number): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  const forward = left.every((point, index) => samePoint(point, right[index]!, toleranceMm));
  if (forward) return true;
  return left.every((point, index) => samePoint(point, right[right.length - index - 1]!, toleranceMm));
}

function duplicateBounds(paths: readonly CutPathMm[], toleranceMm: number): boolean {
  for (let index = 1; index < paths.length; index += 1) {
    if (sameBounds(paths[index - 1]!, paths[index]!, toleranceMm)) return true;
  }
  return false;
}

/** Compares alternate sources by physical contour where the supported line subset is unambiguous. */
export function comparePhysicalCutGeometryMm(
  left: CutGeometryMm,
  right: CutGeometryMm,
  toleranceMm: number,
): PhysicalCutGeometryComparison {
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0) throw new RangeError("Physical cut comparison tolerance must be finite and non-negative.");
  if (!closeNumber(left.pageSizeMm.widthMm, right.pageSizeMm.widthMm, toleranceMm)
    || !closeNumber(left.pageSizeMm.heightMm, right.pageSizeMm.heightMm, toleranceMm)) {
    return { status: "divergent", message: "Physical page dimensions differ beyond the alternate-source tolerance." };
  }
  if (left.paths.length !== right.paths.length) return { status: "divergent", message: "Cut path count differs." };

  const leftPaths = [...left.paths].sort(compareBounds);
  const rightPaths = [...right.paths].sort(compareBounds);
  for (let index = 0; index < leftPaths.length; index += 1) {
    const first = leftPaths[index]!;
    const second = rightPaths[index]!;
    if (!sameBounds(first, second, toleranceMm)) return { status: "divergent", message: `Path ${index + 1} bounds differ beyond the alternate-source tolerance.` };
    if (first.closed !== second.closed) return { status: "divergent", message: `Path ${index + 1} closure differs.` };
  }

  // Exact parameter equality is safe for curves; differing parameterizations
  // are not approximated here, so they cannot become a false divergence.
  if (compareCutGeometryMm(left, right, toleranceMm, { compareIds: false }).equal) return { status: "equivalent" };
  if (leftPaths.some((path) => !allLinear(path)) || rightPaths.some((path) => !allLinear(path))) {
    return { status: "not-compared", message: "At least one curved path has a parameterization that is not safely comparable to the alternate source." };
  }
  if (duplicateBounds(leftPaths, toleranceMm) || duplicateBounds(rightPaths, toleranceMm)) {
    return { status: "not-compared", message: "Multiple cut paths share bounds, so alternate path matching is ambiguous." };
  }

  for (let index = 0; index < leftPaths.length; index += 1) {
    const first = leftPaths[index]!;
    const second = rightPaths[index]!;
    const firstVertices = removeCollinearVertices(vertices(first, toleranceMm), first.closed, toleranceMm);
    const secondVertices = removeCollinearVertices(vertices(second, toleranceMm), second.closed, toleranceMm);
    if (!firstVertices.length || !secondVertices.length) {
      return { status: "not-compared", message: `Path ${index + 1} has a discontinuity or ambiguous linear contour.` };
    }
    const equivalent = first.closed
      ? cyclicPathEquals(firstVertices, secondVertices, toleranceMm)
      : openPathEquals(firstVertices, secondVertices, toleranceMm);
    if (equivalent === undefined) return { status: "not-compared", message: `Path ${index + 1} has too many repeated vertices to compare within bounded work.` };
    if (!equivalent) return { status: "divergent", message: `Path ${index + 1} contour differs beyond the alternate-source tolerance.` };
  }
  return { status: "equivalent" };
}
