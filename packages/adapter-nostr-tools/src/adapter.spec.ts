import { FetchTillEoseOptions, NostrFetcherBase } from "@nostr-fetch/kernel/fetcherBase";
import { setupMockRelayServer } from "@nostr-fetch/testutil/mockRelayServer";
import { SimplePoolExt } from "./adapter";

import { SimplePool } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WS } from "vitest-websocket-mock";

const collectAsyncIter = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const res: T[] = [];
  try {
    for await (const t of iter) {
      res.push(t);
    }
  } catch (err) {
    console.error(err);
  }
  return res;
};

describe("SimplePoolExt", () => {
  describe("fetchTillEose", () => {
    const defaultOpts: FetchTillEoseOptions = {
      abortSignal: undefined,
      abortSubBeforeEoseTimeoutMs: 5000,
      connectTimeoutMs: 1000,
      skipVerification: false,
      subId: "test",
    };
    const optsWithDefault = (opts: Partial<FetchTillEoseOptions>) => {
      return {
        ...defaultOpts,
        ...opts,
      };
    };

    const url = "ws://localhost:8000";
    let fetcherBase: NostrFetcherBase;
    let wsServer: WS;

    beforeEach(async () => {
      wsServer = new WS(url, { jsonProtocol: true });

      const simplePool = new SimplePool();
      fetcherBase = new SimplePoolExt(simplePool, { minLogLevel: "none" });
    });
    afterEach(() => {
      WS.clean();
    });

    test("fetches events until EOSE", async () => {
      setupMockRelayServer(wsServer, [{ type: "events", eventsSpec: { content: "test", n: 10 } }]);

      await fetcherBase.ensureRelays([url], { connectTimeoutMs: 1000 });
      const iter = fetcherBase.fetchTillEose(url, {}, defaultOpts);
      const evs = await collectAsyncIter(iter);
      expect(evs.length).toBe(10);

      await expect(wsServer).toReceiveMessage(["REQ", "test", {}]);
      await expect(wsServer).toReceiveMessage(["CLOSE", "test"]);
    });

    test("aborts subscription on NOTICE", async () => {
      setupMockRelayServer(wsServer, [
        { type: "events", eventsSpec: { content: "test", n: 9 } },
        { type: "notice", notice: "dummy notice" },
        { type: "events", eventsSpec: { content: "after notice", n: 1 } },
      ]);

      await fetcherBase.ensureRelays([url], { connectTimeoutMs: 1000 });
      const iter = fetcherBase.fetchTillEose(url, {}, defaultOpts);
      const evs = await collectAsyncIter(iter);
      expect(evs.length).toBe(9);

      await expect(wsServer).toReceiveMessage(["REQ", "test", {}]);
      await expect(wsServer).toReceiveMessage(["CLOSE", "test"]);
    });

    test("aborts subscription on WebSocket error", async () => {
      setupMockRelayServer(wsServer, [
        { type: "events", eventsSpec: { content: "test", n: 5 } },
        { type: "delay", delayMs: 1000 }, // prevent the connection close before event is received
        { type: "error" },
      ]);

      await fetcherBase.ensureRelays([url], { connectTimeoutMs: 1000 });
      const iter = fetcherBase.fetchTillEose(url, {}, defaultOpts);
      const evs = await collectAsyncIter(iter);
      expect(evs.length).toBe(5);

      // CLOSE shouldn't be sent
      await expect(wsServer).toReceiveMessage(["REQ", "test", {}]);
    });

    test("aborts before EOSE if relay doesn't return events for a while", async () => {
      setupMockRelayServer(wsServer, [
        { type: "events", eventsSpec: { content: "test", n: 9 } },
        { type: "delay", delayMs: 2000 },
        { type: "events", eventsSpec: { content: "deleyed", n: 1 } },
      ]);

      await fetcherBase.ensureRelays([url], { connectTimeoutMs: 1000 });
      const iter = fetcherBase.fetchTillEose(
        url,
        {},
        optsWithDefault({ abortSubBeforeEoseTimeoutMs: 1000 })
      );
      const evs = await collectAsyncIter(iter);
      expect(evs.length).toBe(9);

      await expect(wsServer).toReceiveMessage(["REQ", "test", {}]);
      await expect(wsServer).toReceiveMessage(["CLOSE", "test"]);
    });

    test("should be aborted by AbortController", async () => {
      setupMockRelayServer(wsServer, [
        { type: "events", eventsSpec: { content: "test", n: 10 }, intervalMs: 100 },
      ]);

      const ac = new AbortController();
      setTimeout(() => {
        ac.abort();
      }, 500);

      await fetcherBase.ensureRelays([url], { connectTimeoutMs: 1000 });
      const iter = fetcherBase.fetchTillEose(url, {}, optsWithDefault({ abortSignal: ac.signal }));
      const evs = await collectAsyncIter(iter);
      expect(evs.length).toBeLessThan(10);

      await expect(wsServer).toReceiveMessage(["REQ", "test", {}]);
      await expect(wsServer).toReceiveMessage(["CLOSE", "test"]);
    });

    test("skips signature verification if enabled", async () => {
      setupMockRelayServer(wsServer, [
        { type: "events", eventsSpec: { content: "test", n: 10 } },
        { type: "events", eventsSpec: { content: "invalid", invalidSig: true } },
      ]);

      await fetcherBase.ensureRelays([url], { connectTimeoutMs: 1000 });
      const iter = fetcherBase.fetchTillEose(url, {}, optsWithDefault({ skipVerification: true }));
      const evs = await collectAsyncIter(iter);
      expect(evs.length).toBe(11);

      await expect(wsServer).toReceiveMessage(["REQ", "test", {}]);
      await expect(wsServer).toReceiveMessage(["CLOSE", "test"]);
    });
  });
});
