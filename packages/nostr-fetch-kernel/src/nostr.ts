/**
 * Nostr event data structure
 */
export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

/**
 * Known Nostr event kinds
 */
export const eventKind = {
  metadata: 0,
  text: 1,
  recommendRelay: 2,
  contacts: 3,
  encryptedDirectMessage: 4,
  eventDeletion: 5,
  repost: 6,
  reaction: 7,
  badgeAward: 8,
  channelCreation: 40,
  channelMetadata: 41,
  channelMessage: 42,
  channelHideMessage: 43,
  channelMuteUser: 44,
  fileMetadata: 1063,
  report: 1984,
  zapRequest: 9734,
  zap: 9735,
  muteList: 10000,
  pinList: 10001,
  relayList: 10002,
  walletInfo: 13194,
  clientAuth: 22242,
  walletRequest: 23194,
  walletResponse: 23195,
  nostrConnect: 24133,
  categorizedPeopleList: 30000,
  categorizedBookmarkList: 30001,
  profileBadges: 30008,
  badgeDefinition: 30009,
  marketplaceStall: 30017,
  marketplaceProduct: 30018,
  article: 30023,
  appSpecificData: 30078,
} as const;

/**
 * Filter for event subscription
 */
export type Filter = {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
  [key: `#${string}`]: string[];
};

// client to relay messages
type C2RReq = [type: "REQ", subId: string, ...filters: Filter[]];
type C2RClose = [type: "CLOSE", subId: string];

export type C2RMessage = C2RReq | C2RClose;
export type C2RMessageType = C2RMessage[0];

// relay to client messages
type R2CEvent = [type: "EVENT", subId: string, event: NostrEvent];
type R2CEose = [type: "EOSE", subId: string];
type R2CNotice = [type: "NOTICE", notice: unknown];

export type R2CMessage = R2CEvent | R2CEose | R2CNotice;
export type R2CMessageType = R2CMessage[0];

export type R2CSubMessage = R2CEvent | R2CEose;
export type R2CSubMessageType = R2CSubMessage[0];

const msgTypeNames: string[] = ["EVENT", "EOSE", "NOTICE", "OK", "AUTH", "COUNT"];

export const parseR2CMessage = (rawMsg: string): R2CMessage | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMsg) as unknown;
  } catch (err) {
    console.error("failed to parse R2C message as JSON:", err);
    return undefined;
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "string") {
    console.error("malformed R2C message");
    return undefined;
  }

  const msgType = parsed[0] as string;
  if (!msgTypeNames.includes(msgType)) {
    console.error("unknown R2C message type:", parsed[0]);
    return undefined;
  }
  if (msgType === "OK" || msgType === "AUTH" || msgType === "COUNT") {
    console.warn("ignoring R2C OK/AUTH/COUNT message");
    return undefined;
  }
  switch (msgType) {
    case "EVENT": {
      if (parsed.length !== 3) {
        console.error("malformed R2C EVENT");
        return undefined;
      }
      const [, subId, ev] = parsed;
      if (typeof subId !== "string" || typeof ev !== "object" || ev === null) {
        console.error("malformed R2C EVENT");
        return undefined;
      }
      if (!validateEvent(ev)) {
        console.error("malformed event in R2C EVENT");
        return undefined;
      }
      return parsed as R2CEvent;
    }
    case "EOSE": {
      if (parsed.length !== 2 || typeof parsed[1] !== "string") {
        console.error("malformed R2C EOSE");
        return undefined;
      }
      return parsed as R2CEose;
    }
    case "NOTICE": {
      if (parsed.length !== 2) {
        console.error("malformed R2C NOTICE");
        return undefined;
      }
      return parsed as R2CNotice;
    }
    default:
      return undefined;
  }
};

// schema validation for Nostr events
export const validateEvent = (rawEv: Record<string, unknown>): rawEv is NostrEvent => {
  // id: 32-bytes lowercase hex-encoded sha256
  if (!("id" in rawEv) || typeof rawEv["id"] !== "string" || !is32BytesHexStr(rawEv["id"])) {
    return false;
  }

  // pubkey: 32-bytes lowercase hex-encoded public key
  if (
    !("pubkey" in rawEv) ||
    typeof rawEv["pubkey"] !== "string" ||
    !is32BytesHexStr(rawEv["pubkey"])
  ) {
    return false;
  }

  // created_at: unix timestamp in seconds
  if (!("created_at" in rawEv) || typeof rawEv["created_at"] !== "number") {
    return false;
  }

  // kind: integer
  if (!("kind" in rawEv) || typeof rawEv["kind"] !== "number") {
    return false;
  }

  // tags: array of arrays of non-null strings
  if (!("tags" in rawEv) || !Array.isArray(rawEv["tags"])) {
    return false;
  }
  if (rawEv["tags"].some((tag) => !Array.isArray(tag) || tag.some((e) => typeof e !== "string"))) {
    return false;
  }

  // content: string
  if (!("content" in rawEv) || typeof rawEv["content"] !== "string") {
    return false;
  }

  // sig: 64-bytes hex of the signature
  if (!("sig" in rawEv) || typeof rawEv["sig"] !== "string" || !is64BytesHexStr(rawEv["sig"])) {
    return false;
  }

  return true;
};

const is32BytesHexStr = (s: string): boolean => {
  return /^[a-f0-9]{64}$/.test(s);
};

const is64BytesHexStr = (s: string): boolean => {
  return /^[a-f0-9]{128}$/.test(s);
};

/* Check Relay's Capabilities */
/**
 * Queries supported NIP numbers of the given relay.
 */
export const querySupportedNips = async (relayUrl: string): Promise<Set<number>> => {
  try {
    const httpUrl = toHttpUrl(relayUrl);

    const abortCtrl = new AbortController();
    const abortTimer = setTimeout(() => {
      abortCtrl.abort();
    }, 5000);

    const resp = await fetch(httpUrl, {
      headers: { Accept: "application/nostr+json" },
      signal: abortCtrl.signal,
    });
    clearTimeout(abortTimer);

    if (!resp.ok) {
      console.error("relay information response is not ok");
      return new Set();
    }

    const relayInfo = await resp.json();
    if (!relayInfoHasSupportedNips(relayInfo)) {
      console.error("relay information document doesn't have proper 'supported_nips' property");
      return new Set();
    }
    return new Set(relayInfo.supported_nips);
  } catch (err) {
    console.error(err);
    return new Set();
  }
};

const toHttpUrl = (url: string): string => {
  const u = new URL(url);
  switch (u.protocol) {
    case "wss:":
      u.protocol = "https:";
      break;
    case "ws:":
      u.protocol = "http:";
      break;
  }
  return u.toString();
};

type RelayInfoWithSupportedNips = {
  supported_nips: number[];
};

const relayInfoHasSupportedNips = (relayInfo: unknown): relayInfo is RelayInfoWithSupportedNips =>
  typeof relayInfo === "object" &&
  relayInfo !== null &&
  "supported_nips" in relayInfo &&
  Array.isArray(relayInfo.supported_nips) &&
  (relayInfo.supported_nips.length === 0 ||
    relayInfo.supported_nips.every((e: unknown) => typeof e === "number"));

/* Utilities */
// utility to generate a random subscription ID
export const generateSubId = () => {
  return Date.now().toString() + Math.random().toString(32).substring(2, 4);
};
