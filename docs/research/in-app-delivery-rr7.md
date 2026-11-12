# How can In-app Notifications reach an open browser in React Router 7?

Ticket: schickm/cohort-005-project#5 (parent map #2).

## Answer in brief

Three options exist. Recommendation for v1: **revalidation on navigation and after actions (free, already happens), plus a short poll for the unread count, paused while the tab is hidden**. Do not build SSE in v1. Keep the delivery seam (a loader that returns "unread Notifications for this recipient") independent of transport so SSE can replace the poll later.

| Option | Latency | Cost | Complexity | Deployment constraint |
| --- | --- | --- | --- | --- |
| Revalidation on navigation / action | Next click | None; already on | None | None |
| Polling via `useRevalidator` | Poll interval (e.g. 30-60s) | One loader run per tick per open tab | Low (one component) | None; works anywhere |
| SSE via a resource route | Near-instant | One open connection per tab, held for the tab's life | Medium-high | Single process (or a shared bus), proxy/compression buffering, HTTP/1.1 6-connection limit |

## Project facts (checked in the repo)

- `react-router` and `@react-router/*` are `8.3.0` (`package.json`). The ticket says "React Router 7"; the installed version is 8.x. The docs cited below are the current ones.
- Framework mode with `ssr: true` (`react-router.config.ts`). Served by `react-router-serve ./build/server/index.js` (`package.json` `start` script).
- `@react-router/serve` is an Express app that applies `compression()` unless building for RSC (`node_modules/@react-router/serve/dist/cli.js`, line 113).
- Database: `better-sqlite3` + Drizzle, one file `data.db`, opened lazily as a per-process singleton with `journal_mode = WAL` (`app/db/index.ts`).

## Option 1: revalidation on navigation and after actions

- "In framework mode with SSR, route loaders are automatically revalidated after all navigations and form submissions", and after `<Form>`, `useFetcher`, `useSubmit` actions. Source: https://reactrouter.com/start/framework/route-module
- A loader in a layout route (e.g. `layout.app.tsx`) that returns the unread count will refresh on every navigation and mutation with no extra code. A page left idle never updates.
- `shouldRevalidate` can opt a route out, but defaults to revalidating; do not opt the notification-bearing route out.
- Gap: a Learner watching a lesson (no navigation) sees nothing new. Options 2 and 3 close that.

## Option 2: polling with `useRevalidator`

- `useRevalidator` "lets you reload the current page's data without a navigation or a data mutation", explicitly for "reasons outside of normal data mutations like Window focus or polling on an interval." Framework and Data modes. `revalidate()` returns `Promise<void>`; `state` reports whether a revalidation is running. Source: https://reactrouter.com/api/hooks/useRevalidator
- The docs page has no polling snippet; the usual shape is `setInterval(() => revalidator.revalidate(), ms)` in an effect with cleanup.
- Cost: `revalidate()` re-runs **all active loaders on the page**, not just the notification one. A way around that is a `useFetcher` pointed at a small resource route (`/api/notifications/unread`) returning only the count, so only that loader runs. This is an inference from documented fetcher/resource-route behavior; confirm in a spike.
- Cost on SQLite: an indexed `count(*) where recipient = ? and read_at is null` is a trivial read; WAL mode lets reads proceed alongside writes.
- Refinements: skip ticks when `document.hidden`; revalidate on window focus (the docs' own example use case); add jitter.
- Deployment constraints: none. Works on a single process, multiple processes, serverless, any proxy.
- Failure mode: bounded staleness equal to the interval. Easy to reason about and test (fake timers).

## Option 3: SSE or streaming

- Resource routes serve non-UI responses: a route that exports a `loader` or `action` but no default component; GET goes to `loader`; "return `Response` instances" for external consumption. Source: https://reactrouter.com/how-to/resource-routes
- That page does **not** document streaming bodies, `text/event-stream` or `EventSource`. Returning a `Response` wrapping a `ReadableStream` from a loader is an inference from "routes return standard `Response`", not a documented pattern. Needs a spike. (The `Await`/promise streaming in the docs streams data into the React tree during a single response; it does not push later events.)
- Protocol facts (MDN, https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events):
  - Server responds `Content-Type: text/event-stream`; MDN's example also sends `Cache-Control: no-cache` and `X-Accel-Buffering: no` (nginx buffering off).
  - Messages are UTF-8 blocks terminated by a blank line.
  - `EventSource` reconnects automatically; the server can set the delay with `retry:`. `id:` sets the last event ID (the SSE spec sends it back as `Last-Event-ID`; MDN's page only describes the `id` field).
  - "When not used over HTTP/2, SSE suffers from a limitation to the maximum number of open connections ... per browser ... (6)", which hurts with multiple tabs. HTTP/2 negotiates 100 streams by default.
  - `evtSource.close()` ends it; call it on unmount.
- Pushing needs a trigger inside the server process. SQLite has no LISTEN/NOTIFY-style change feed, so the code that inserts a Notification would also have to publish to an in-memory emitter that open SSE handlers subscribe to.
- That emitter only works if writer and SSE handler share a process. SQLite WAL is itself same-host only: "All processes using a database must be on the same host computer; WAL does not work over a network filesystem." Source: https://sqlite.org/wal.html. So the app is already pinned to one host. With multiple processes on that host, they share the file but not the emitter, so a cross-process signal would be needed.
- `react-router-serve` runs `compression()`. Compression middleware generally buffers responses unless the handler flushes, and `text/event-stream` is compressible by default. Not verified against the `compression` docs here; treat as a likely pitfall to test (SSE may appear to hang). Mitigations: flush after each write, or exclude `text/event-stream` from compression (needs a custom server rather than `react-router-serve`).
- Other costs: a long-lived connection per tab; heartbeat comments (`: ping`) for idle proxies; dev server and test setup need extra care; the DevUI user switcher must tear down and reopen the stream.
- Payoff: sub-second delivery. For Cadence's events (Refund Request raised/decided, Purchase) that is rarely needed.

## Fit with the map's Push/SMS concern

Push and SMS push to the person via device/phone subscriptions and can fire from system events with no request in flight. In-app delivery is the opposite (pull on an open page). Treat delivery as a per-Channel concern: In-app = a read query over stored Notifications (transport-agnostic); Push/SMS = a sender fed from the same record. SSE for in-app would not help Push/SMS and adds a stateful server component the other Channels do not need.

## Recommendation

1. v1: Notifications are rows; the layout route loader returns unread count and recent items; navigation/action revalidation covers most cases.
2. Add a small poller (fetcher against an unread-count resource route, or `useRevalidator`) at about 30-60s, paused when hidden, plus revalidate on window focus.
3. Defer SSE. Revisit if product wants instant toasts. Prerequisites: spike a streaming `Response` from a resource route under `react-router-serve`, confirm compression behavior, decide the in-process publish seam.

## Open items / unverified

- Streaming `Response` from a resource route: not documented in the cited page; needs a spike.
- `compression` buffering of `text/event-stream`: not verified against its docs.
- Whether fetcher loads against a resource route avoid re-running other loaders: inferred.
- Ticket says React Router 7; repo has 8.3.0.
