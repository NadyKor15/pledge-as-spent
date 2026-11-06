import { describe, expect, it } from "vitest";
import { crc32, readZip, zipStore } from "./zip";

describe("zipStore", () => {
  it("CRC32 matches the published check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("round-trips names and bytes, uncompressed", () => {
    const enc = new TextEncoder();
    const zip = zipStore([
      { name: "a.txt", data: enc.encode("hello") },
      { name: "dir/ü-日本.xml", data: enc.encode("<x>日本</x>") },
      { name: "empty", data: new Uint8Array(0) },
    ]);
    const back = readZip(zip);
    expect(back.map((f) => f.name)).toEqual(["a.txt", "dir/ü-日本.xml", "empty"]);
    expect(new TextDecoder().decode(back[1].data)).toBe("<x>日本</x>");
    expect(back.every((f) => f.method === 0 && f.crcOk)).toBe(true);
  });

  it("detects a flipped byte through the CRC", () => {
    const zip = zipStore([{ name: "a", data: new TextEncoder().encode("payload") }]);
    zip[30 + 1 + 2] ^= 0xff; // inside the data, after the 30-byte header and the 1-byte name
    expect(readZip(zip)[0].crcOk).toBe(false);
  });

  it("rejects duplicate names", () => {
    expect(() => zipStore([{ name: "a", data: new Uint8Array(1) }, { name: "a", data: new Uint8Array(1) }])).toThrow(/duplicate/i);
  });
});
