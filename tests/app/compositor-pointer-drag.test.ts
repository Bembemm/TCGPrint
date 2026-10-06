import { describe, expect, it } from "vitest";
import {
  deriveCompositorInsertionAxis,
  resolveCompositorInsertionPlacement,
} from "../../src/app/compositor-pointer-drag";

describe("compositor pointer insertion geometry", () => {
  it("uses the actual horizontal target midpoint for before and after", () => {
    const target = { left: 100, top: 40, width: 60, height: 80 };

    expect(resolveCompositorInsertionPlacement(target, 101, 78, "horizontal")).toBe("before");
    expect(resolveCompositorInsertionPlacement(target, 131, 78, "horizontal")).toBe("after");
  });

  it("uses the vertical target midpoint for a one-column sequence", () => {
    const target = { left: 100, top: 100, width: 60, height: 80 };

    expect(resolveCompositorInsertionPlacement(target, 120, 119, "vertical")).toBe("before");
    expect(resolveCompositorInsertionPlacement(target, 120, 141, "vertical")).toBe("after");
  });

  it("derives the insertion axis from neighboring visual slots", () => {
    expect(deriveCompositorInsertionAxis([
      { left: 0, top: 0, width: 60, height: 80 },
      { left: 70, top: 0, width: 60, height: 80 },
    ])).toBe("horizontal");

    expect(deriveCompositorInsertionAxis([
      { left: 0, top: 0, width: 60, height: 80 },
      { left: 0, top: 90, width: 60, height: 80 },
    ])).toBe("vertical");
  });
});
