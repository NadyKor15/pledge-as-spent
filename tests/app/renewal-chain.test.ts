import { describe, expect, it } from "vitest";
import { chainRootId, groupByChain } from "../../src/ui/renewal-chain";

describe("renewal chains on screens", () => {
  const holds = [
    { pledgeId: "lena", renewedTo: "lena.r2" },
    { pledgeId: "mark" },
    { pledgeId: "lena.r1", renews: "lena" }, // declined: never linked
    { pledgeId: "lena.r2", renews: "lena", renewedTo: "lena.r2.r1" },
    { pledgeId: "lena.r2.r1", renews: "lena.r2" },
    { pledgeId: "yuki.r1", renews: "yuki" }, // its first hold is not in the list: it stands alone
  ];

  it("finds the first hold of a chain", () => {
    expect(chainRootId(holds, "lena.r2.r1")).toBe("lena");
    expect(chainRootId(holds, "lena.r1")).toBe("lena");
    expect(chainRootId(holds, "mark")).toBe("mark");
    expect(chainRootId(holds, "yuki.r1")).toBe("yuki.r1");
  });

  it("groups one donor's holds into one entry, linked holds first to latest, a declined renewal last", () => {
    const g = groupByChain(holds);
    expect(g.map((c) => c.root.pledgeId)).toEqual(["lena", "mark", "yuki.r1"]);
    const lena = g[0];
    expect(lena.members.map((m) => m.pledgeId)).toEqual(["lena", "lena.r2", "lena.r2.r1", "lena.r1"]);
    expect(lena.latest.pledgeId).toBe("lena.r2.r1");
    expect(g[1]).toMatchObject({ members: [{ pledgeId: "mark" }], latest: { pledgeId: "mark" } });
  });

  it("leaves a list without renewals as it was: one entry per hold, same order", () => {
    const plain = [{ pledgeId: "a" }, { pledgeId: "b" }, { pledgeId: "c" }];
    expect(groupByChain(plain).map((c) => [c.root.pledgeId, c.members.length])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
  });
});
