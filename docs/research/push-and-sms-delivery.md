# How Push and SMS delivery work

Research for issue #7 (parent map #2). Purpose: the Notification model must leave room for Push and SMS, even if v1 builds neither.

Sources are primary. Claims marked **(unverified)** came from background knowledge, not a fetched primary page, and should be checked before they drive a decision.

## Summary

- All three are **fan-out per target**, not per person. One person has many targets (browsers, phones). One Notification therefore produces many delivery attempts, each with its own outcome.
- The target (Web Push subscription, device token, phone number) is **volatile**. The provider tells you when it dies, asynchronously, and you must prune it.
- "Accepted by the provider" is not "delivered". Push gives almost no delivery receipt. SMS gives a status callback.
- SMS is the only Channel with a **legal consent record** requirement and registration (A2P 10DLC). Consent state must be stored with evidence.
- A Notification's content must be small and re-renderable per Channel (push payload about 4 KB; SMS is billed per segment).

## Web Push

### Subscription and lifecycle
- The browser creates a subscription via `pushManager.subscribe()`. It generates a P-256 ECDH key pair and an auth secret and requests an endpoint from the push service. Requires a secure context and notification permission; denial rejects with `NotAllowedError`. [W3C Push API](https://w3c.github.io/push-api/)
- Serialised shape (`toJSON()`): `endpoint`, `expirationTime` (ms or `null`), `keys.p256dh`, `keys.auth` (base64url). [W3C Push API](https://w3c.github.io/push-api/), [MDN PushSubscription](https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription)
- `userVisibleOnly` may be required `true`; every push must then show a visible notification. [W3C Push API](https://w3c.github.io/push-api/)
- The `pushsubscriptionchange` service-worker event fires when the browser refreshes or loses a subscription. It carries `oldSubscription` and `newSubscription` (null if none could be made). A refresh uses a new key pair. [W3C Push API](https://w3c.github.io/push-api/)
- The endpoint is a capability URL (bearer secret, at least 120 bits entropy). Whoever holds it can post to it, so treat it as a secret. [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)
- Subscriptions have a limited lifetime; either side can end them. 404 means expired. [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)

### Sending
- HTTP POST to the endpoint. Required `TTL` header (seconds; 0 means deliver only if the device is reachable now). Optional `Urgency` (very-low, low, normal, high) and `Topic` (at most 32 URL-safe chars; a new message with the same topic replaces a pending one). [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)
- Payload is encrypted with the subscription's `p256dh` and `auth` (aes128gcm). Push services need only support 4096 bytes of body; max plaintext 3993 bytes. [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)
- **VAPID**: the app server holds one ECDSA P-256 key pair (distinct from the encryption keys), and sends `Authorization: vapid t=<JWT>, k=<public key>`. JWT claims: `aud` (push service origin), `exp` (at most 24 h), optional `sub` (`mailto:` or `https:`). A subscription created with an `applicationServerKey` is bound to that key; changing the key requires new subscriptions. [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)

### Receipts, failures, limits
- 201 = accepted by the push service, **not delivered**. 404/410 = subscription gone, delete it. 413 = too large. 429 = rate limited, honour `Retry-After`. 400 = bad headers. [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030), [web.dev](https://web.dev/articles/push-notifications-web-push-protocol)
- Optional delivery receipts (`Prefer: respond-async`) give a receipt URI reporting 204 (acknowledged by the user agent) or 410 (never delivered). Support is optional and browser push services rarely use it **(unverified)**. [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)
- Push services may rate-limit and may terminate subscriptions that get too many messages. [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)
- Providers: no vendor needed; each browser's push service is addressed by the endpoint URL. Libraries such as `web-push` do VAPID and encryption.

## Mobile push

### APNs (iOS)
- Device token is issued by the OS per app per device; it can change (reinstall, restore), so the app should re-register and upload on each launch **(unverified: Apple's current registration page was not fetchable)**.
- Sandbox and production use different hosts and tokens are not interchangeable. Store the environment with the token **(unverified, same reason)**.
- Request: HTTP/2 POST to `/3/device/<token>`. Headers: `apns-topic` (bundle ID; required with token auth), `apns-expiration` (0 = try once, do not store), `apns-priority` (10 immediate, must show alert/sound/badge; 5 power-aware, throttled and sometimes not delivered), `apns-collapse-id` (at most 64 bytes), `apns-id` (UUID; returned if omitted). Auth: provider token (JWT bearer). Max body 4096 bytes (5120 VoIP). [Apple archived APNs guide](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html)
- Responses: 410 `Unregistered` with a `timestamp`: stop pushing until the device registers a token with a later timestamp. 413 payload too large. 429 too many requests for one token. [same guide](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html)
- No per-device delivery receipt is returned to the server; success means APNs accepted it **(unverified)**.

### FCM (Android, and iOS/Web via Firebase)
- Registration token (or installation ID) per app instance. Stale after about a month without connecting; Android registrations expire after 270 days of inactivity; iOS has no equivalent so prune yourself. Store a timestamp with each token, refreshed on each upload, and prune on a schedule. [FCM token management](https://firebase.google.com/docs/cloud-messaging/manage-tokens)
- Errors (HTTP v1): `UNREGISTERED` 404 (delete token), `INVALID_ARGUMENT` 400 (check payload first, then token), `QUOTA_EXCEEDED` 429 (back off at least 1 minute), `UNAVAILABLE` 503 (retry, honour `Retry-After`), `SENDER_ID_MISMATCH` 403. Payload limit 4096 bytes (2048 for topics). [FCM errors](https://firebase.google.com/docs/cloud-messaging/error-codes)
- TTL 0 to 2,419,200 s (28 days); default is 4 weeks. `collapse_key` replaces a still-pending message for the same token. [FCM lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan)
- Topics are a fan-out feature; subscriptions are keyed to the token and must be redone when it changes. [FCM token management](https://firebase.google.com/docs/cloud-messaging/manage-tokens)
- Per-project and per-device quota numbers were not retrievable from the fetched pages.

## SMS

### Numbers and lifecycle
- The target is an E.164 phone number. Numbers get recycled to new people; carriers can disconnect them; landlines cannot receive SMS. Nothing in the fetched sources covers recycling or landline handling **(unverified)**; validate with a lookup before first send.
- Twilio statuses: `queued`, `sending`, `sent`, `delivered`, `undelivered`, `failed` (plus `accepted`/`scheduled` for Messaging Services, `read` for RCS/WhatsApp). `ErrorCode` is set on `failed`/`undelivered`; Twilio says not to rely on code and message values programmatically. A `StatusCallback` URL receives a POST on every status change. [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource)
- Billing and size: split into segments above 160 GSM-7 or 70 UCS-2 characters; each segment is billed. [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource)

### Opt-out is also an inbound event
- Twilio handles STOP, UNSUBSCRIBE, END, QUIT, STOPALL, REVOKE, OPTOUT, CANCEL by default (case-insensitive), sends the confirmation, blocks the number, and later sends fail with error 21610. START/UNSTOP re-opt-in; HELP is reserved. The webhook carries `OptOutType`. [Twilio opt-out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out)
- So the system must ingest inbound messages/webhooks and record the opt-out itself, since the carrier-level block is invisible to our own preferences.

### Registration (US): A2P 10DLC
- All US SMS from 10-digit long codes is A2P and must register a **Brand** (who is sending) and a **Campaign** (use case, how users opt in, opt out, get help). Unregistered traffic is filtered more and incurs extra carrier fees. Toll-free and short codes are separate regimes. [Twilio A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)
- Daily throughput to T-Mobile depends on Brand type: Sole Proprietor 1,000 segments; Low-Volume Standard up to 2,000; Standard 2,000 to unlimited by Trust Score. [Twilio A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)
- Operational consequence: SMS needs an approved Campaign before launch.

### US law (TCPA, FCC rules)
- Autodialed or prerecorded calls/texts to cell numbers without the recipient's prior express consent are unlawful. [47 U.S.C. 227(b)(1)(A)(iii)](https://www.law.cornell.edu/uscode/text/47/227)
- Private right of action: greater of actual loss or $500 per violation, up to three times for willful or knowing violation. [47 U.S.C. 227(b)(3)](https://www.law.cornell.edu/uscode/text/47/227)
- For autodialed telemarketing, **prior express written consent** is required: "an agreement, in writing, bearing the signature of the person called". [47 CFR 64.1200](https://www.law.cornell.edu/cfr/text/47/64.1200)
- Revocation: any reasonable method clearly expressing a wish to stop; must be honoured within a reasonable time not exceeding ten business days; one confirming text is allowed. [47 CFR 64.1200](https://www.law.cornell.edu/cfr/text/47/64.1200)
- Telemarketing calling-time limit: not before 8 a.m. or after 9 p.m. at the called party's location (the cited text is the telemarketing rule; applying it to every text is conservative) **(unverified scope)**. [47 CFR 64.1200](https://www.law.cornell.edu/cfr/text/47/64.1200)
- Not verified here: that purely informational/transactional texts need only prior express (not written) consent; the status of the FCC's "one-to-one consent" rule. Get these checked before building SMS.
- Cadence relevance: marketing is already out of scope. Purely transactional texts are the lowest-risk case, but still need a recorded opt-in.

## Cross-cutting comparison

| | Web Push | APNs | FCM | SMS |
|---|---|---|---|---|
| Target | endpoint URL + p256dh + auth | device token (+ environment) | registration token / FID | E.164 number |
| Permission | browser prompt | OS prompt | OS prompt | recorded consent |
| Dies when | 404/410, `pushsubscriptionchange` | 410 Unregistered | UNREGISTERED, 30/270-day staleness | STOP, 21610, number recycled |
| Receipt | 201 only (optional receipts) | accepted only | accepted only | status callback |
| Size | 4096 B encrypted | 4096 B | 4096 B | 160/70 chars per billed segment |
| Replace/collapse | `Topic` | `apns-collapse-id` | `collapse_key` | none |
| Expiry | `TTL` | `apns-expiration` | `ttl` (max 28 d) | n/a |
| Rate limits | 429 + Retry-After | 429 per token | QUOTA_EXCEEDED 429 | 10DLC daily caps by Brand |
| Sender credential | VAPID key pair | provider JWT / .p8 key | service account | Brand + Campaign + number |

## What the data model must store per Channel

Principle: a **Notification** (one event, one recipient) is channel-agnostic. Each Channel gets a **delivery attempt** row per target, and each target gets its own table, because one recipient has many targets and each can die independently.

### All Channels (per Notification)
- Recipient, event type, structured payload (ids and params, not rendered text), created time.
- Which Channels were *intended* (resolved from the recipient's preferences at creation time).
- Content renderable per Channel and small enough for the smallest limit (push about 4 KB; SMS segments).
- Optional `collapse_key` (maps to Topic / collapse-id / collapse_key; also supports burst grouping).
- Optional expiry (maps to TTL / apns-expiration / ttl).

### Per delivery attempt (Notification x Channel x target)
- Notification id, Channel, target id (nullable for In-app/Email).
- State: pending, sent (provider accepted), delivered (only where the provider reports it), failed, expired, suppressed.
- Provider message id (Twilio `SM...`, APNs `apns-id`, FCM message name, Postmark id), attempt count, last attempt time, next retry time.
- Provider error code and status as raw strings, plus our own normalised failure class: `permanent_target_dead`, `retryable`, `rate_limited`, `payload_invalid`, `auth_config`. Do not branch on Twilio's error text.
- Suppression reason (no consent, opted out, quiet hours, target stale).

### Web Push subscription (per browser profile)
- Recipient, endpoint (unique; treat as secret), `p256dh`, `auth`, `expirationTime`.
- The VAPID public key it was created with (a key change forces resubscribe).
- User agent / label (so people can see and revoke devices), created, last successful send, last failure, `disabled_at` + reason (404/410 or `pushsubscriptionchange`).

### Mobile device token (APNs / FCM)
- Recipient, platform (ios/android/web), provider (apns/fcm), token (unique per provider + app id), app id / bundle id (APNs topic), **environment** (sandbox/production) for APNs.
- Token last-registered timestamp (APNs 410 compares against it; FCM staleness pruning uses it), last successful send, `disabled_at` + reason (410 Unregistered, UNREGISTERED), device label, optional app version.
- Provider credentials are per-app config, not per target.

### Phone number (SMS)
- Recipient, E.164 number, verified at (proof of possession, e.g. code), line type if looked up, `disabled_at` + reason (carrier failure, recycled).
- **Consent record**: status (opted in / opted out / never asked), timestamp, source (form, inbound keyword, support), the exact consent wording or version shown, IP / user agent where captured, and the revocation timestamp and source. Keep it after opt-out; it is the evidence in a TCPA dispute.
- Inbound opt-out ingestion: record inbound STOP/START/HELP so carrier-level blocks and our consent state stay in sync.
- The Campaign / sender id used (A2P 10DLC Campaign, messaging service), so volume and use-case can be audited.
- Recipient timezone, if quiet-hours rules are applied.

### Recipient preferences
- Per recipient, per event type, per Channel: enabled flag. Defaults per Channel (In-app and Email on; Push and SMS off until opted in).
- Preferences are separate from consent: a preference to receive SMS is not enough without a consent record, and a revocation overrides it.

### Operational config (not per recipient)
- VAPID key pair and subject, APNs key id / team id / bundle id, FCM service account, Twilio account / messaging service / Campaign ids. Secrets, so handled by the secrets tooling, not the Notification tables.

### Implications for the spec
1. Do not model Channel as an enum column on Notification alone; model Notification x Channel x target delivery rows. In-app and Email are the degenerate cases (one implicit target).
2. Delivery state must be updatable asynchronously (webhooks, receipts), and the system must tolerate "sent" never advancing to "delivered".
3. Target tables can be added later without changing Notification, provided delivery rows already carry a Channel and a nullable target reference.
4. Triggers with no actor (scheduled jobs, payment callbacks) are fine: nothing here depends on a person being present, but SMS and push need quiet-hours and rate-limit awareness, which implies a recipient timezone.

## Open items to verify before building Push/SMS
- Apple's current (non-archived) APNs docs, especially token change rules and the 410 timestamp format.
- FCM per-project and per-device quotas.
- TCPA: consent standard for transactional texts; current status of FCC consent rules; whether the 8am-9pm window applies to non-marketing texts.
- Number recycling and landline handling (Twilio Lookup, reassigned numbers database).
