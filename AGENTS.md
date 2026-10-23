# @packstub/calls (repo packstub/calls-js)

The browser engine for 1-on-1 WebRTC calls: `CallClient` (media, `RTCPeerConnection`, perfect negotiation, screen share, reconnecting after a page load) and `HttpSignaling` (the polling adapter). Framework-agnostic, one ES module, no build step. MIT. Consumed by `packstub/filament-calls` (`plugins/filament-calls`, copied into its `resources/dist/calls-core.js` by `npm run build:js` there); the server side is `packstub/calls` (`plugins/calls`). Moved out of `filament-calls/js/` on 2026-10-23; private repo, unpublished on npm.

## Commands

```bash
npm test                 # Vitest, Node only (no browser)
npm run test:watch
```

## Layout

- `src/index.js`: the whole package. Keep it free of DOM, Alpine and Laravel; anything UI goes in the consumer.
- `tests/fakes.js`: `FakeRTCPeerConnection` (fires `negotiationneeded` once per task like a browser, `setConnectionState` / `receiveTrack` / `gatherCandidate` for what the network would do), `FakeMediaStream`, `FakeTrack` (`end()` is the browser's "Stop sharing"), `fakeDevices()` for `getUserMedia` / `getDisplayMedia`, `installBrowserGlobals()`, and `FakeServer`: the signaling backend in memory with the same rules as the Laravel one (a side held by one tab, signals only to the holder, a cursor, `end()` and `tick()` to push state around; `server.log` records every call).
- `tests/call-client.test.js`: two clients talk through a `FakeServer` under `vi.useFakeTimers()`; `connect()` gets a call to `active`, `settle(ms)` advances the timers.

## Conventions

- The signaling interface and the `call` shape in the README are shared with `packstub/calls` and `filament-calls`; a change there is a change in all three repos and in `FakeServer`.
- During ICE (between the answer and `connected`) polls already report `reconnecting`; tests assert the first states and the final one, not the exact sequence.
- Changelog line for every change (`## Unreleased`), the tag is `v<version>` on `main`, the release workflow takes the notes from the tag's section.
