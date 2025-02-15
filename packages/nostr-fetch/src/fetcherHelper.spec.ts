import { describe, expect, test } from "vitest";
import { EventBuckets, KeyRelayMatrix } from "./fetcherHelper";

const dummyEvent = (id: string) => {
  return {
    id,
    pubkey: "",
    kind: 0,
    content: "",
    tags: [],
    created_at: 0,
    sig: "",
  };
};

describe("EventBuckets", () => {
  test("has buckets for all keys specified on initialization", () => {
    const buckets = new EventBuckets(["alice", "bob"], 10);

    expect(buckets.getBucket("alice")).toBeDefined();
    expect(buckets.getBucket("bob")).toBeDefined();
    expect(buckets.getBucket("unknown")).toBeUndefined();
  });

  test("add() works correctly", () => {
    const e1 = dummyEvent("1");
    const e2 = dummyEvent("2");

    const buckets = new EventBuckets(["alice", "bob"], 2);

    expect(buckets.add("alice", e1).state).toBe("open");
    expect(buckets.add("alice", e2)).toEqual({
      state: "fulfilled",
      events: expect.arrayContaining([e1, e2]),
    });
    expect(buckets.add("alice", e1).state).toBe("dropped");

    buckets.add("bob", e1);
    expect(buckets.add("bob", e2)).toEqual({
      state: "fulfilled",
      events: expect.arrayContaining([e1, e2]),
    });

    expect(buckets.add("unknown", e1).state).toBe("dropped");
  });

  test("calcKeyAndLimitForNextReq() works correctly", () => {
    const e = dummyEvent("1");

    const buckets = new EventBuckets(["alice", "bob"], 2);
    expect(buckets.calcKeysAndLimitForNextReq()).toEqual({
      keys: expect.arrayContaining(["alice", "bob"]),
      limit: 4,
    });

    buckets.add("alice", e);
    expect(buckets.calcKeysAndLimitForNextReq()).toEqual({
      keys: expect.arrayContaining(["alice", "bob"]),
      limit: 3,
    });

    buckets.add("bob", e);
    expect(buckets.calcKeysAndLimitForNextReq()).toEqual({
      keys: expect.arrayContaining(["alice", "bob"]),
      limit: 2,
    });

    buckets.add("bob", e);
    expect(buckets.calcKeysAndLimitForNextReq()).toEqual({
      keys: ["alice"],
      limit: 1,
    });

    buckets.add("alice", e);
    expect(buckets.calcKeysAndLimitForNextReq()).toEqual({
      keys: [],
      limit: 0,
    });
  });
});

describe("KeyRelayMatrix", () => {
  test("has expected entries", () => {
    const matrix = new KeyRelayMatrix(
      new Map([
        ["relay1", [1, 2, 3]],
        ["relay2", [2, 3]],
        ["relay3", [3]],
      ]),
      () => 0
    );

    expect(matrix.get(1, "relay1")).toBeDefined();
    expect(matrix.get(2, "relay1")).toBeDefined();
    expect(matrix.get(3, "relay1")).toBeDefined();
    expect(matrix.get(2, "relay2")).toBeDefined();
    expect(matrix.get(3, "relay2")).toBeDefined();
    expect(matrix.get(3, "relay3")).toBeDefined();

    expect(matrix.get(1, "relay2")).toBeUndefined();
    expect(matrix.get(1, "relay3")).toBeUndefined();
    expect(matrix.get(2, "relay3")).toBeUndefined();

    expect(matrix.itemsByKey(1)?.length ?? -1).toBe(1);
    expect(matrix.itemsByKey(2)?.length ?? -1).toBe(2);
    expect(matrix.itemsByKey(3)?.length ?? -1).toBe(3);
  });
});
