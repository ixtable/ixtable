import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../src/lib/utils";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const timestampOf = (id: string) => Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);

describe("newId", () => {
  afterEach(() => vi.useRealTimers());

  it("returns a lowercase UUIDv7 with the RFC 9562 variant", () => {
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(UUID_V7);
  });

  it("encodes the creation time in the first 48 bits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
    expect(timestampOf(newId())).toBe(Date.parse("2030-01-01T12:00:00.000Z"));
  });

  it("never goes backwards when the clock does", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-03T00:00:00.000Z"));
    const first = newId();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    expect(newId() > first).toBe(true);
  });

  it("orders ids made later, including within one millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-02T12:00:00.000Z"));
    const sameMs = Array.from({ length: 5000 }, () => newId());
    vi.setSystemTime(new Date("2030-01-02T12:00:01.000Z"));
    const later = newId();
    const all = [...sameMs, later];
    expect([...all].sort()).toEqual(all);
    expect(new Set(all).size).toBe(all.length);
  });
});
