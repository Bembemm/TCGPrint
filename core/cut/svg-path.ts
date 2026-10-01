import type { CutArcSegmentMm, CutPathMm, CutPointMm } from "./types";

export function formatCutNumber(value: number, decimals = 6): string {
  if (!Number.isFinite(value)) throw new RangeError("Cut path coordinates must be finite.");
  const rounded = Number(value.toFixed(decimals));
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(decimals).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
}

function ellipseParameters(segment: CutArcSegmentMm): { rx: number; ry: number; rotationDegrees: number; startAngle: number; sweepAngle: number } {
  const { axisU, axisV } = segment;
  const xx = axisU.xMm ** 2 + axisV.xMm ** 2;
  const xy = axisU.xMm * axisU.yMm + axisV.xMm * axisV.yMm;
  const yy = axisU.yMm ** 2 + axisV.yMm ** 2;
  const discriminant = Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2);
  const majorSquared = (xx + yy + discriminant) / 2;
  const minorSquared = (xx + yy - discriminant) / 2;
  if (majorSquared <= 0 || minorSquared <= 1e-20) throw new RangeError("Cut path contains a degenerate ellipse arc.");
  const rx = Math.sqrt(majorSquared);
  const ry = Math.sqrt(minorSquared);
  const rotation = 0.5 * Math.atan2(2 * xy, xx - yy);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const r00 = cos / rx * axisU.xMm + sin / rx * axisU.yMm;
  const r10 = -sin / ry * axisU.xMm + cos / ry * axisU.yMm;
  const r01 = cos / rx * axisV.xMm + sin / rx * axisV.yMm;
  const r11 = -sin / ry * axisV.xMm + cos / ry * axisV.yMm;
  const determinant = r00 * r11 - r01 * r10;
  if (Math.abs(Math.abs(determinant) - 1) > 1e-6) throw new RangeError("Cut path ellipse transform is not numerically stable.");
  const direction = determinant < 0 ? -1 : 1;
  const delta = Math.atan2(r10, r00);
  return { rx, ry, rotationDegrees: rotation * 180 / Math.PI, startAngle: delta + direction * segment.startAngleRad, sweepAngle: direction * segment.sweepAngleRad };
}

function arcCommands(segment: CutArcSegmentMm): string[] {
  const ellipse = ellipseParameters(segment);
  const fullTurn = Math.PI * 2;
  const pieces = Math.abs(ellipse.sweepAngle) >= fullTurn - 1e-10 ? 2 : 1;
  const partSweep = ellipse.sweepAngle / pieces;
  const commands: string[] = [];
  for (let index = 1; index <= pieces; index += 1) {
    const end: CutPointMm = index === pieces ? segment.to : {
      xMm: segment.center.xMm + segment.axisU.xMm * Math.cos(segment.startAngleRad + segment.sweepAngleRad * index / pieces)
        + segment.axisV.xMm * Math.sin(segment.startAngleRad + segment.sweepAngleRad * index / pieces),
      yMm: segment.center.yMm + segment.axisU.yMm * Math.cos(segment.startAngleRad + segment.sweepAngleRad * index / pieces)
        + segment.axisV.yMm * Math.sin(segment.startAngleRad + segment.sweepAngleRad * index / pieces),
    };
    const large = Math.abs(partSweep) > Math.PI + 1e-10 ? 1 : 0;
    const sweep = partSweep >= 0 ? 1 : 0;
    commands.push(`A ${formatCutNumber(ellipse.rx)} ${formatCutNumber(ellipse.ry)} ${formatCutNumber(ellipse.rotationDegrees, 12)} ${large} ${sweep} ${formatCutNumber(end.xMm)} ${formatCutNumber(end.yMm)}`);
  }
  return commands;
}

/** Converts canonical segments to SVG path syntax only at a serialization/rendering boundary. */
export function cutPathToSvgD(path: CutPathMm): string {
  const commands = [`M ${formatCutNumber(path.start.xMm)} ${formatCutNumber(path.start.yMm)}`];
  for (const segment of path.segments) {
    if (segment.type === "line") commands.push(`L ${formatCutNumber(segment.to.xMm)} ${formatCutNumber(segment.to.yMm)}`);
    else if (segment.type === "quadratic") commands.push(`Q ${formatCutNumber(segment.control.xMm)} ${formatCutNumber(segment.control.yMm)} ${formatCutNumber(segment.to.xMm)} ${formatCutNumber(segment.to.yMm)}`);
    else if (segment.type === "cubic") commands.push(`C ${formatCutNumber(segment.control1.xMm)} ${formatCutNumber(segment.control1.yMm)} ${formatCutNumber(segment.control2.xMm)} ${formatCutNumber(segment.control2.yMm)} ${formatCutNumber(segment.to.xMm)} ${formatCutNumber(segment.to.yMm)}`);
    else commands.push(...arcCommands(segment));
  }
  if (path.closed) commands.push("Z");
  return commands.join(" ");
}
