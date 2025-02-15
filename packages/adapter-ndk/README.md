# @nostr-fetch/adapter-ndk

This package includes the adapter for [NDK(Nostr Dev Kit)](https://github.com/nostr-dev-kit/ndk) which allows it to work with [**nostr-fetch**](https://github.com/jiftechnify/nostr-fetch), a utility library for fetching past events from Nostr relays.

If you want to use nostr-fetch, [here](https://github.com/jiftechnify/nostr-fetch#readme) is a good start point!

## Example

```ts
import NDK from '@nostr-dev-kit/ndk';
import { NostrFetcher, normalizeRelayUrls } from 'nostr-fetch';
import { ndkAdapter } from '@nostr-fetch/adapter-ndk';

// You should normalize relay URLs by `normalizeRelayUrls` before passing them to NDK's constructor if working with nostr-fetch!
const explicitRelays = normalizeRelayUrls([
    "wss://relay-jp.nostr.wirednet.jp",
    "wss://relay.damus.io",
]);

const main = async () => {
    const ndk = new NDK({ explicitRelayUrls: explicitRelays });
    await ndk.connect(); // ensure connections to the "explicit relays" before fetching events!

    const fetcher = NostrFetcher.withCustomPool(ndkAdapter(ndk));
    // ...
}
```
