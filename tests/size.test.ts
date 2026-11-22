import { describe, expect, it } from "vitest";
import { extractSize, sizeSortKey } from "@/lib/size";

describe("size extraction (FR-SCR-05)", () => {
  it("height: anchored cm/mm/inch converted to cm", () => {
    expect(extractSize("height", ["Goku figure 30cm tall"])).toBe("30");
    expect(extractSize("height", ["Height: 250 mm"])).toBe("25");
    expect(extractSize("height", ["Statue, 10 inch high"])).toBe("25.4");
  });
  it("height: conflicting anchored values -> null, unanchored -> null", () => {
    expect(extractSize("height", ["Figure Height: 25cm Height: 30cm"])).toBeNull();
    expect(extractSize("height", ["Goku 30cm"])).toBeNull();
  });
  it("falls through sources: name, description, attributes", () => {
    expect(extractSize("height", ["Goku figure", "Stands 18cm tall"])).toBe("18");
  });
  it("length: anchored, single unanchored fallback, ambiguous null", () => {
    expect(extractSize("length", ["Katana overall length 104cm"])).toBe("104");
    expect(extractSize("length", ["Katana 100cm"])).toBe("100");
    expect(extractSize("length", ["Katana 104cm with 70cm blade"])).toBeNull();
  });
  it("scale: 1:N and 1/N both store 1:N, no cross-kind conversion", () => {
    expect(extractSize("scale", ["Skyline 1/18 scale"])).toBe("1:18");
    expect(extractSize("scale", ["Skyline 1 : 18"])).toBe("1:18");
    expect(extractSize("scale", ["Model 30cm"])).toBeNull();
    expect(extractSize("other", ["30cm"])).toBeNull();
  });
  it("range limits and sort key", () => {
    expect(extractSize("height", ["Height 500cm"])).toBeNull();
    expect(sizeSortKey("1:18")).toBe(18);
    expect(sizeSortKey("30.5")).toBe(30.5);
    expect(sizeSortKey(null)).toBeNull();
  });
});
