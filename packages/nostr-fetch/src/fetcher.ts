import { Channel, Deferred } from "@nostr-fetch/kernel/channel";
import { verifyEventSig } from "@nostr-fetch/kernel/crypto";
import { DebugLogger } from "@nostr-fetch/kernel/debugLogger";
import {
  EnsureRelaysOptions,
  FetchTillEoseOptions,
  NostrFetcherBase,
  NostrFetcherBaseInitializer,
  NostrFetcherCommonOptions,
  defaultFetcherCommonOptions,
} from "@nostr-fetch/kernel/fetcherBase";
import { Filter, NostrEvent } from "@nostr-fetch/kernel/nostr";
import { abbreviate, currUnixtimeSec, normalizeRelayUrls } from "@nostr-fetch/kernel/utils";

import { DefaultFetcherBase } from "./fetcherBase";
import {
  EventBuckets,
  KeyRelayMatrix,
  NostrFetchError,
  RelayCapCheckerInitializer,
  RelayCapabilityChecker,
  assertReq,
  checkIfNonEmpty,
  checkIfTimeRangeIsValid,
  checkIfTrue,
  createdAtDesc,
  initDefaultRelayCapChecker,
} from "./fetcherHelper";

export type FetchFilter = Omit<Filter, "limit" | "since" | "until">;
export type FetchTimeRangeFilter = Pick<Filter, "since" | "until">;

const MAX_LIMIT_PER_REQ = 5000;
const MAX_LIMIT_PER_REQ_IN_BACKPRESSURE = 500;

const MIN_HIGH_WATER_MARK = 5000;

export type FetchOptions = {
  skipVerification?: boolean;
  connectTimeoutMs?: number;
  abortSignal?: AbortSignal | undefined;
  abortSubBeforeEoseTimeoutMs?: number;
  limitPerReq?: number;
};

const defaultFetchOptions: Required<FetchOptions> = {
  skipVerification: false,
  connectTimeoutMs: 5000,
  abortSignal: undefined,
  abortSubBeforeEoseTimeoutMs: 10000,
  limitPerReq: MAX_LIMIT_PER_REQ,
};

export type AllEventsIterOptions = FetchOptions & {
  enableBackpressure?: boolean;
};

const defaultAllEventsIterOptions: Required<AllEventsIterOptions> = {
  ...defaultFetchOptions,
  enableBackpressure: false,
};

export type FetchAllOptions = FetchOptions & {
  sort?: boolean;
};

const defaultFetchAllOptions: Required<FetchAllOptions> = {
  ...defaultFetchOptions,
  sort: false,
};

export type FetchLatestOptions = FetchOptions & {
  reduceVerification?: boolean;
};

const defaultFetchLatestOptions: Required<FetchLatestOptions> = {
  ...defaultFetchOptions,
  reduceVerification: true,
};

/**
 * Type of the fiest argument of `fetchLatestEventsPerAuthor`/`fetchLastEventPerAuthor`
 */
export type AuthorsAndRelays = RelaySetForAllAuthors | RelaySetsPerAuthor;

/**
 * Use same relay set for all authors
 */
type RelaySetForAllAuthors = {
  authors: string[];
  relayUrls: string[];
};

/**
 * Use saperate relay set for each author.  Typically `Map<string, string[]>`
 */
type RelaySetsPerAuthor = Iterable<[author: string, relayUrls: string[]]>;

const isRelaySetForAllAuthors = (a2rs: AuthorsAndRelays): a2rs is RelaySetForAllAuthors => {
  return "relayUrls" in a2rs && "authors" in a2rs;
};
const isRelaySetsPerAuthor = (a2rs: AuthorsAndRelays): a2rs is RelaySetsPerAuthor => {
  return Symbol.iterator in Object(a2rs);
};

export class NostrFetcher {
  #fetcherBase: NostrFetcherBase;
  #relayCapChecker: RelayCapabilityChecker;
  #debugLogger: DebugLogger | undefined;

  private constructor(
    fetcherBase: NostrFetcherBase,
    relayCapChecker: RelayCapabilityChecker,
    initOpts: Required<NostrFetcherCommonOptions>
  ) {
    this.#fetcherBase = fetcherBase;
    this.#relayCapChecker = relayCapChecker;

    if (initOpts.minLogLevel !== "none") {
      this.#debugLogger = new DebugLogger(initOpts.minLogLevel);
    }
  }

  /**
   * Initializes `NostrFetcher` with the default relay pool implementation.
   */
  public static init(
    options: NostrFetcherCommonOptions = {},
    initRelayCapChecker: RelayCapCheckerInitializer = initDefaultRelayCapChecker
  ): NostrFetcher {
    const finalOpts = { ...defaultFetcherCommonOptions, ...options };
    const base = new DefaultFetcherBase(finalOpts);
    const relayCapChecker = initRelayCapChecker(finalOpts);
    return new NostrFetcher(base, relayCapChecker, finalOpts);
  }

  /**
   * Initializes `NostrFetcher` with the given custom relay pool implementation.
   *
   *
   * @example
   * ```ts
   * const pool = new SimplePool();
   * const fetcher = NostrFetcher.withCustomPool(simplePoolAdapter(pool));
   * ```
   */
  public static withCustomPool(
    poolAdapter: NostrFetcherBaseInitializer,
    options: NostrFetcherCommonOptions = {},
    initRelayCapChecker: RelayCapCheckerInitializer = initDefaultRelayCapChecker
  ): NostrFetcher {
    const finalOpts = { ...defaultFetcherCommonOptions, ...options };
    const relayCapChecker = initRelayCapChecker(finalOpts);
    return new NostrFetcher(poolAdapter(finalOpts), relayCapChecker, finalOpts);
  }

  async #ensureRelaysWithCapCheck(
    relayUrls: string[],
    opts: EnsureRelaysOptions,
    requiredNips: number[]
  ): Promise<string[]> {
    const connectedRelays = await this.#fetcherBase.ensureRelays(relayUrls, opts);

    if (requiredNips.length === 0) {
      // if capability check is not needed, return early
      return connectedRelays;
    }

    this.#debugLogger?.log("info", `required NIPs: ${requiredNips}`);

    const res: string[] = [];
    await Promise.all(
      connectedRelays.map(async (rurl) => {
        if (await this.#relayCapChecker.relaySupportsNips(rurl, requiredNips)) {
          res.push(rurl);
        }
      })
    );

    this.#debugLogger?.log("info", `eligible relays: ${res}`);
    return res;
  }

  #calcRequiredNips(filter: { search?: string }): number[] {
    const res: number[] = [];
    if ("search" in filter) {
      res.push(50); // NIP-50: Search Capability
    }
    return res;
  }

  /**
   * Returns an async iterable of all events matching the filter from Nostr relays specified by the array of URLs.
   *
   * You can iterate over events using for-await-of loop.
   *
   * Note: there are no guarantees about the order of returned events.
   *
   * Throws {@linkcode NostrFetchError} if `timeRangeFilter` is invalid (`since` > `until`).
   *
   * @param relayUrls
   * @param filter
   * @param timeRangeFilter
   * @param options
   * @returns
   */
  public async allEventsIterator(
    relayUrls: string[],
    filter: FetchFilter,
    timeRangeFilter: FetchTimeRangeFilter,
    options: AllEventsIterOptions = {}
  ): Promise<AsyncIterable<NostrEvent>> {
    assertReq(
      { relayUrls, timeRangeFilter },
      [
        checkIfNonEmpty((r) => r.relayUrls, "warn", "Specify at least 1 relay URL"),
        checkIfTimeRangeIsValid(
          (r) => r.timeRangeFilter,
          "error",
          "Invalid time range (since > until)"
        ),
      ],
      this.#debugLogger
    );

    const filledOpts: Required<AllEventsIterOptions> = {
      ...defaultAllEventsIterOptions,
      ...options,
    };

    // use smaller limit if backpressure is enabled
    const finalOpts: Required<AllEventsIterOptions> = {
      ...filledOpts,
      limitPerReq: filledOpts.enableBackpressure
        ? Math.min(filledOpts.limitPerReq, MAX_LIMIT_PER_REQ_IN_BACKPRESSURE)
        : filledOpts.limitPerReq,
    };
    this.#debugLogger?.log("verbose", "finalOpts=%O", finalOpts);

    const reqNips = this.#calcRequiredNips(filter);
    const eligibleRelayUrls = await this.#ensureRelaysWithCapCheck(relayUrls, filledOpts, reqNips);

    const highWaterMark = finalOpts.enableBackpressure
      ? Math.max(finalOpts.limitPerReq * eligibleRelayUrls.length, MIN_HIGH_WATER_MARK)
      : undefined;
    const [tx, chIter] = Channel.make<NostrEvent>({ highWaterMark });

    const globalSeenEventIds = new Set<string>();
    const initialUntil = timeRangeFilter.until ?? currUnixtimeSec();

    // fetch events from each relay
    Promise.all(
      eligibleRelayUrls.map(async (rurl) => {
        // repeat subscription until one of the following conditions is met:
        // 1. the relay didn't return new event
        // 2. aborted by AbortController
        // E. an error occured while fetching events

        const logger = this.#debugLogger?.subLogger(rurl);

        let nextUntil = initialUntil;
        const localSeenEventIds = new Set<string>();

        while (true) {
          const refinedFilter = {
            ...timeRangeFilter,
            ...filter,
            until: nextUntil,
            // relays are supposed to return *latest* events by specifying `limit` explicitly (cf. [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)).
            // nostream doesn't accept a filter which has `limit` grater than 5000, so limit `limit` to this threshold or less.
            limit: Math.min(finalOpts.limitPerReq, MAX_LIMIT_PER_REQ),
          };
          logger?.log("verbose", "refinedFilter=%O", refinedFilter);

          let gotNewEvent = false;
          let oldestCreatedAt = Number.MAX_SAFE_INTEGER;

          try {
            for await (const e of this.#fetcherBase.fetchTillEose(rurl, refinedFilter, finalOpts)) {
              // eliminate duplicated events
              if (!localSeenEventIds.has(e.id)) {
                gotNewEvent = true;
                localSeenEventIds.add(e.id);
                if (e.created_at < oldestCreatedAt) {
                  oldestCreatedAt = e.created_at;
                }

                if (!globalSeenEventIds.has(e.id)) {
                  globalSeenEventIds.add(e.id);
                  tx.send(e);
                }
              }
            }
          } catch (err) {
            // an error occured while fetching events
            logger?.log("error", err);
            break;
          }

          if (!gotNewEvent) {
            // termination contidion 1
            logger?.log("info", `got ${localSeenEventIds.size} events`);
            break;
          }
          if (finalOpts.abortSignal?.aborted) {
            // termination contidion 2
            logger?.log("info", "aborted");
            break;
          }

          // set next `until` to `created_at` of the oldest event returned in this time.
          // `+ 1` is needed to make it work collectly even if we used relays which has "exclusive" behaviour with respect to `until`.
          nextUntil = oldestCreatedAt + 1;

          // receive backpressure: wait until the channel is drained enough
          await tx.waitUntilDrained();
        }
      })
    ).then(() => {
      // all subscription loops have been terminated
      tx.close();
    });
    return chIter;
  }

  /**
   * Fetches all events matching the filter from Nostr relays specified by the array of URLs,
   * and collect them into an array.
   *
   * Note: there are no guarantees about the order of returned events if `sort` options is not specified.
   *
   * Throws {@linkcode NostrFetchError} if `timeRangeFilter` is invalid (`since` > `until`).
   *
   * @param relayUrls
   * @param filter
   * @param timeRangeFilter
   * @param options
   * @returns
   */
  public async fetchAllEvents(
    relayUrls: string[],
    filter: FetchFilter,
    timeRangeFilter: FetchTimeRangeFilter,
    options: FetchAllOptions = {}
  ): Promise<NostrEvent[]> {
    assertReq(
      { relayUrls, timeRangeFilter },
      [
        checkIfNonEmpty((r) => r.relayUrls, "warn", "Specify at least 1 relay URL"),
        checkIfTimeRangeIsValid(
          (r) => r.timeRangeFilter,
          "error",
          "Invalid time range (since > until)"
        ),
      ],
      this.#debugLogger
    );

    const finalOpts = {
      ...defaultFetchAllOptions,
      ...options,
    };

    const res: NostrEvent[] = [];

    const allEvents = await this.allEventsIterator(relayUrls, filter, timeRangeFilter, {
      ...finalOpts,
      enableBackpressure: false,
    });
    for await (const ev of allEvents) {
      res.push(ev);
    }

    // sort events in "newest to oldest" order if `sort` options is specified
    if (finalOpts.sort) {
      res.sort(createdAtDesc);
    }
    return res;
  }

  /**
   * Fetches latest events matching the filter from Nostr relays specified by the array of URLs.
   *
   * Events are sorted in "newest to oldest" order.
   *
   * Throws {@linkcode NostrFetchError} if `limit` is a non-positive number.
   *
   * @param relayUrls
   * @param filter
   * @param limit
   * @param options
   * @returns
   */
  public async fetchLatestEvents(
    relayUrls: string[],
    filter: FetchFilter,
    limit: number,
    options: FetchLatestOptions = {}
  ): Promise<NostrEvent[]> {
    assertReq(
      { relayUrls, limit },
      [
        checkIfNonEmpty((r) => r.relayUrls, "warn", "Specify at least 1 relay URL"),
        checkIfTrue((r) => r.limit > 0, "error", '"limit" should be positive number'),
      ],
      this.#debugLogger
    );

    const finalOpts: Required<FetchLatestOptions> = {
      ...defaultFetchLatestOptions,
      ...options,
    };
    this.#debugLogger?.log("verbose", "finalOpts=%O", finalOpts);

    // options for subscription
    const subOpts: FetchTillEoseOptions = {
      ...finalOpts,
      // skip "full" verification if `reduceVerification` is enabled
      skipVerification: finalOpts.skipVerification || finalOpts.reduceVerification,
    };

    const reqNips = this.#calcRequiredNips(filter);
    const eligibleRelayUrls = await this.#ensureRelaysWithCapCheck(relayUrls, finalOpts, reqNips);

    const [tx, chIter] = Channel.make<NostrEvent>();
    const globalSeenEventIds = new Set<string>();
    const initialUntil = currUnixtimeSec();

    // fetch at most `limit` events from each relay
    Promise.all(
      eligibleRelayUrls.map(async (rurl) => {
        // repeat subscription until one of the following conditions is met:
        // 1. got enough amount of events
        // 2. the relay didn't return new event
        // 3. aborted by AbortController
        // E. an error occured while fetching events

        const logger = this.#debugLogger?.subLogger(rurl);

        let nextUntil = initialUntil;
        let remainingLimit = limit;
        const localSeenEventIds = new Set<string>();

        while (true) {
          const refinedFilter = {
            ...filter,
            until: nextUntil,
            // relays are supposed to return *latest* events by specifying `limit` explicitly (cf. [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)).
            // nostream doesn't accept a filter which has `limit` grater than 5000, so limit `limit` to this threshold or less.
            limit: Math.min(remainingLimit, MAX_LIMIT_PER_REQ),
          };
          logger?.log("verbose", "refinedFilter=%O", refinedFilter);

          let numNewEvents = 0;
          let oldestCreatedAt = Number.MAX_SAFE_INTEGER;

          try {
            for await (const e of this.#fetcherBase.fetchTillEose(rurl, refinedFilter, subOpts)) {
              // eliminate duplicated events
              if (!localSeenEventIds.has(e.id)) {
                numNewEvents++;
                localSeenEventIds.add(e.id);
                if (e.created_at < oldestCreatedAt) {
                  oldestCreatedAt = e.created_at;
                }

                if (!globalSeenEventIds.has(e.id)) {
                  globalSeenEventIds.add(e.id);
                  tx.send(e);
                }
              }
            }
          } catch (err) {
            // an error occured while fetching events
            logger?.log("error", err);
            break;
          }

          remainingLimit -= numNewEvents;
          if (numNewEvents === 0 || remainingLimit <= 0) {
            // termination condition 1, 2
            logger?.log("info", `got ${localSeenEventIds.size} events`);
            break;
          }
          if (finalOpts.abortSignal?.aborted) {
            // termination condition 3
            logger?.log("info", `aborted`);
            break;
          }

          // set next `until` to `created_at` of the oldest event returned in this time.
          // `+ 1` is needed to make it work collectly even if we used relays which has "exclusive" behaviour with respect to `until`.
          nextUntil = oldestCreatedAt + 1;
        }
      })
    ).then(() => {
      // all subnscription loops have been terminated
      tx.close();
    });

    // collect events from relays. events are already deduped
    const evs: NostrEvent[] = [];
    for await (const ev of chIter) {
      evs.push(ev);
    }
    evs.sort(createdAtDesc);

    // return latest `limit` events if not "reduced verification mode"
    if (finalOpts.skipVerification || !finalOpts.reduceVerification) {
      return evs.slice(0, limit);
    }
    // reduced verification: return latest `limit` events whose signature is valid
    const verified: NostrEvent[] = [];
    for (const ev of evs) {
      if (verifyEventSig(ev)) {
        verified.push(ev);
        if (verified.length >= limit) {
          break;
        }
      }
    }
    return verified;
  }

  /**
   * Fetches the last event matching the filter from Nostr relays specified by the array of URLs.
   *
   * Returns `undefined` if no event matching the filter exists in any relay.
   *
   * @param relayUrls
   * @param filter
   * @param options
   * @returns
   */
  public async fetchLastEvent(
    relayUrls: string[],
    filter: FetchFilter,
    options: FetchLatestOptions = {}
  ): Promise<NostrEvent | undefined> {
    const finalOpts: FetchLatestOptions & { abortSubBeforeEoseTimeoutMs: number } = {
      ...defaultFetchLatestOptions,
      ...{
        // override default value of `abortSubBeforeEoseTimeoutMs` (10000 -> 1000)
        abortSubBeforeEoseTimeoutMs: 1000,
        ...options,
      },
    };
    const latest1 = await this.fetchLatestEvents(relayUrls, filter, 1, finalOpts);
    return latest1[0];
  }

  // creates mapping of available relays to authors.
  // returns that mapping and array of all authors.
  async #mapAvailableRelayToAuthors(
    a2rs: AuthorsAndRelays,
    ensureOpts: EnsureRelaysOptions,
    reqNips: number[]
  ): Promise<[map: Map<string, string[]>, allAuthors: string[]]> {
    if (isRelaySetForAllAuthors(a2rs)) {
      assertReq(
        a2rs,
        [
          checkIfNonEmpty((r) => r.relayUrls, "warn", "Specify at least 1 relay URL"),
          checkIfNonEmpty((r) => r.authors, "warn", "Specify at least 1 author (pubkey)"),
        ],
        this.#debugLogger
      );

      const eligibleRelays = await this.#ensureRelaysWithCapCheck(
        a2rs.relayUrls,
        ensureOpts,
        reqNips
      );
      return [new Map(eligibleRelays.map((rurl) => [rurl, a2rs.authors])), a2rs.authors];
    }

    if (isRelaySetsPerAuthor(a2rs)) {
      const a2rsArr = [...a2rs];
      assertReq(
        a2rsArr,
        [
          checkIfNonEmpty((a2rs) => a2rs, "warn", "Specify at least 1 author"),
          checkIfTrue(
            (a2rs) => a2rs.every(([, relays]) => relays.length > 0),
            "warn",
            "Specify at least 1 relay URL for all authors"
          ),
        ],
        this.#debugLogger
      );

      // transpose: author to rurls -> rurl to authors
      const rurl2authors = new Map<string, string[]>();
      for (const [author, rurls] of a2rsArr) {
        const normalized = normalizeRelayUrls(rurls);
        for (const rurl of normalized) {
          const authors = rurl2authors.get(rurl);
          rurl2authors.set(rurl, [...(authors ?? []), author]);
        }
      }
      const eligibleRelays = await this.#ensureRelaysWithCapCheck(
        [...rurl2authors.keys()],
        ensureOpts,
        reqNips
      );

      // retain eligible relays only
      return [
        /* eslint-disable-next-line @typescript-eslint/no-non-null-assertion */
        new Map(eligibleRelays.map((rurl) => [rurl, rurl2authors.get(rurl)!])),
        a2rsArr.map(([author]) => author),
      ];
    }

    throw new NostrFetchError(
      "malformed first argument for fetchLatestEventsPerAuthor/fetchLastEventPerAuthor"
    );
  }

  /**
   * Fetches latest up to `limit` events **for each author specified by `authorsAndRelays`**.
   *
   * `authorsAndRelays` can be either of two types:
   *
   * - `{ authors: string[], relayUrls: string[] }`: The fetcher will use the same relay set (`relayUrls`) for all `authors` to fetch events.
   * - `Map<string, string[]>`: Key must be author's pubkey and value must be relay set for that author. The fetcher will use separate relay set for each author to fetch events.
   *
   * Result is an async iterable of `{ author (pubkey), events (from the author) }` pairs.
   *
   * Each array of events in the result are sorted in "newest to oldest" order.
   *
   * Throws {@linkcode NostrFetchError} if `limit` is a non-positive number.
   *
   * @param authorsAndRelays
   * @param otherFilter
   * @param limit
   * @param options
   * @returns
   */
  public async fetchLatestEventsPerAuthor(
    authorsAndRelays: AuthorsAndRelays,
    otherFilter: Omit<FetchFilter, "authors">,
    limit: number,
    options: FetchLatestOptions = {}
  ): Promise<AsyncIterable<{ author: string; events: NostrEvent[] }>> {
    assertReq(
      { limit },
      [checkIfTrue((r) => r.limit > 0, "error", '"limit" should be positive number')],
      this.#debugLogger
    );

    const finalOpts = {
      ...defaultFetchLatestOptions,
      ...options,
    };
    this.#debugLogger?.log("verbose", "finalOpts=%O", finalOpts);

    // options for subscription
    const subOpts: FetchTillEoseOptions = {
      ...finalOpts,
      // skip "full" verification if `reduceVerification` is enabled
      skipVerification: finalOpts.skipVerification || finalOpts.reduceVerification,
    };

    // get mapping of available relay to authors and list of all authors
    const reqNips = this.#calcRequiredNips(otherFilter);
    const [relayToAuthors, allAuthors] = await this.#mapAvailableRelayToAuthors(
      authorsAndRelays,
      finalOpts,
      reqNips
    );
    this.#debugLogger?.log("verbose", "relayToAuthors=%O", relayToAuthors);

    const [tx, chIter] = Channel.make<{ author: string; events: NostrEvent[] }>();
    const initialUntil = currUnixtimeSec();

    // for each pair of author and relay URL, create a promise that act as "latch", so that the "merger" can wait for a subscription to complete
    const latches = new KeyRelayMatrix(relayToAuthors, () => new Deferred<NostrEvent[]>());

    // the "fetcher" fetches events from each relay
    Promise.all(
      [...relayToAuthors].map(async ([rurl, authors]) => {
        // repeat subscription until one of the following conditions is met:
        // 1. have fetched required number of events for all authors
        // 2. the relay didn't return new event
        // 3. aborted by AbortController
        // E. an error occured while fetching events

        const logger = this.#debugLogger?.subLogger(rurl);

        let nextUntil = initialUntil;
        const evBucketsPerAuthor = new EventBuckets(authors, limit);
        const localSeenEventIds = new Set<string>();

        // procedure to complete the subscription in the middle, resolving all remaining promises.
        // resolve() is called even if a promise is already resolved, but it's not a problem.
        const resolveAllOnEarlyBreak = () => {
          logger?.log("verbose", `resolving bucket on early return`);
          for (const pk of authors) {
            latches.get(pk, rurl)?.resolve(evBucketsPerAuthor.getBucket(pk) ?? []);
          }
        };

        while (true) {
          const { keys: nextAuthors, limit: nextLimit } =
            evBucketsPerAuthor.calcKeysAndLimitForNextReq();

          if (nextAuthors.length === 0) {
            // termination condition 1
            logger?.log("verbose", `fulfilled buckets for all authors`);
            break;
          }

          const refinedFilter = {
            ...otherFilter,
            authors: nextAuthors,
            until: nextUntil,
            limit: Math.min(nextLimit, MAX_LIMIT_PER_REQ),
          };
          logger?.log("verbose", `refinedFilter=%O`, refinedFilter);

          let gotNewEvent = false;
          let oldestCreatedAt = Number.MAX_SAFE_INTEGER;

          try {
            for await (const e of this.#fetcherBase.fetchTillEose(rurl, refinedFilter, subOpts)) {
              if (!localSeenEventIds.has(e.id)) {
                gotNewEvent = true;
                localSeenEventIds.add(e.id);

                if (e.created_at < oldestCreatedAt) {
                  oldestCreatedAt = e.created_at;
                }

                // add the event to the bucket for the author(pubkey)
                const addRes = evBucketsPerAuthor.add(e.pubkey, e);
                if (addRes.state === "fulfilled") {
                  // notify that event fetching is completed for the author at this relay
                  // by resolveing the Promise corresponds to the author and the relay
                  latches.get(e.pubkey, rurl)?.resolve(addRes.events);
                  logger?.log("verbose", `fulfilled a bucket for author=${e.pubkey}`);
                }
              }
            }
          } catch (err) {
            // an error occured while fetching events
            logger?.log("error", err);
            resolveAllOnEarlyBreak();
            break;
          }

          if (!gotNewEvent) {
            // termination condition 2
            logger?.log("info", `got ${localSeenEventIds.size} events`);
            resolveAllOnEarlyBreak();
            break;
          }
          if (finalOpts.abortSignal?.aborted) {
            // termination condition 3
            logger?.log("info", `aborted`);
            resolveAllOnEarlyBreak();
            break;
          }

          nextUntil = oldestCreatedAt + 1;
        }
      })
    );

    // the "merger".
    // for each author: merges result from relays, sorts events, takes latest events and sends it to the result channel.
    Promise.all(
      allAuthors.map(async (pubkey) => {
        const logger = this.#debugLogger?.subLogger(abbreviate(pubkey, 6));

        // wait for all the buckets for the author to fulfilled
        const evsPerRelay = await Promise.all(
          latches.itemsByKey(pubkey)?.map((d) => d.promise) ?? []
        );
        logger?.log("verbose", `fulfilled all buckets for this author`);

        // merge and sort
        const evsDeduped = (() => {
          const res = [];
          const seenIds = new Set();

          for (const evs of evsPerRelay) {
            for (const ev of evs) {
              if (!seenIds.has(ev.id)) {
                res.push(ev);
                seenIds.add(ev.id);
              }
            }
          }
          return res;
        })();
        evsDeduped.sort(createdAtDesc);

        const res = (() => {
          // return latest `limit` events if not "reduced verification mode"
          if (finalOpts.skipVerification || !finalOpts.reduceVerification) {
            return evsDeduped.slice(0, limit);
          }

          // reduced verification: return latest `limit` events whose signature is valid
          const verified = [];
          for (const ev of evsDeduped) {
            if (verifyEventSig(ev)) {
              verified.push(ev);
              if (verified.length >= limit) {
                break;
              }
            }
          }
          return verified;
        })();
        tx.send({ author: pubkey, events: res });
      })
    ).then(() => {
      // finished to fetch events for all authors
      tx.close();
    });

    return chIter;
  }

  /**
   * Fetches the last event **for each author specified by `authorsAndRelays`**.
   *
   * `authorsAndRelays` can be either of two types:
   *
   * - `{ authors: string[], relayUrls: string[] }`: The fetcher will use the same relay set (`relayUrls`) for all `authors` to fetch events.
   * - `Map<string, string[]>`: Key must be author's pubkey and value must be relay set for that author. The fetcher will use separate relay set for each author to fetch events.
   *
   * Result is an async iterable of `{ author (pubkey), event }` pairs.
   *
   * `event` in result will be `undefined` if no event matching the filter for the author exists in any relay.
   *
   * @param authorsAndRelays
   * @param otherFilter
   * @param options
   * @returns
   */
  public async fetchLastEventPerAuthor(
    authorsAndRelays: AuthorsAndRelays,
    otherFilter: Omit<FetchFilter, "authors">,
    options: FetchLatestOptions = {}
  ): Promise<AsyncIterable<{ author: string; event: NostrEvent | undefined }>> {
    const finalOpts: FetchLatestOptions & { abortSubBeforeEoseTimeoutMs: number } = {
      ...defaultFetchLatestOptions,
      ...{
        // override default value of `abortSubBeforeEoseTimeoutMs` (10000 -> 1000)
        abortSubBeforeEoseTimeoutMs: 1000,
        ...options,
      },
    };

    const latest1Iter = await this.fetchLatestEventsPerAuthor(
      authorsAndRelays,
      otherFilter,
      1,
      finalOpts
    );
    const mapped = async function* () {
      for await (const { author, events } of latest1Iter) {
        yield { author, event: events[0] };
      }
    };
    return mapped();
  }

  /**
   * Cleans up all the internal states of the fetcher.
   */
  public shutdown() {
    this.#fetcherBase.shutdown();
  }
}
