# @packstub/calls (repo packstub/calls-js)

The browser engine and widget for WebRTC calls, 1-on-1 and groups up to four: `CallClient` (media, the roster of peers, states, reconnecting after a page load), `MeshTopology` (one `RTCPeerConnection` per peer with perfect negotiation, the lower seat offers; the `topology` option takes an SFU or relay adapter with the same interface for bigger rooms) and `HttpSignaling` (the polling adapter). Framework-agnostic, two ES modules (`src/index.js` the engine, `src/widget.js` + `src/widget.css` the UI), no build step. MIT. Consumed by `packstub/filament-calls` (`plugins/filament-calls`, copied into its `resources/dist/calls-core.js` by `npm run build:js` there); the server side is `packstub/calls` (`plugins/calls`). Moved out of `filament-calls/js/` on 2026-10-23; private repo, unpublished on npm.

## Commands

```bash
npm test                 # Vitest: the engine in Node, tests/widget.test.js under jsdom
npm run test:watch
```

## Layout

- `src/index.js`: the engine (`filament-calls` copies this one file). Keep it free of DOM, Alpine and Laravel; anything UI goes in `src/widget.js` (`CallWidget`: views rendered from `templates` once and patched through `data-calls-*` hooks by `patch()`; `packstub/calls` copies it with `widget.css` into its `resources/dist/`) or in the consumer. `Peer` is the roster entry, `Link` one connection of the mesh; the topology interface is documented above `MeshTopology`.
- `tests/fakes.js`: `FakeRTCPeerConnection` (fires `negotiationneeded` once per task like a browser, `setConnectionState` / `receiveTrack` / `gatherCandidate` for what the network would do), `FakeMediaStream`, `FakeTrack` (`end()` is the browser's "Stop sharing"), `fakeDevices()` for `getUserMedia` / `getDisplayMedia`, `installBrowserGlobals()`, and `FakeServer`: the signaling backend in memory with the same rules as the Laravel one, extended to groups (a participant per person with a `seat`, a side held by one tab, signals only to the holder and addressed with `to`, a cursor, `invite`, a call that ends once fewer than two people are left; `end()` and `tick()` push state around, `participant(callId, userId)` reads a record, `server.log` records every call).
- `tests/call-client.test.js`: two clients talk through a `FakeServer` under `vi.useFakeTimers()`; `connect()` gets a call to `active`, `settle(ms)` advances the timers.
- `tests/widget.test.js`: `CallWidget` under jsdom over a `FakeServer` (`// @vitest-environment jsdom`); several widgets share one document, so all but one get `callSelector: null`.
- `tests/widget.test.js`: `CallWidget` under jsdom over a `FakeServer` (`// @vitest-environment jsdom`); several widgets share one document, so all but one get `callSelector: null`.
- `tests/group-calls.test.js`: three clients in a mesh (`group()`), a recording topology that checks the interface, and a 1-on-1 backend that strips `peers`, `seat`, `joined` and `from`.

## Conventions

- The signaling interface and the `call` shape in the README are shared with `packstub/calls` and `filament-calls`; a change there is a change in all three repos and in `FakeServer`. The group fields (`peers`, `seat`, `joined`, `from`, `to`, `invite`) are optional on the wire: the client must keep working against a backend that sends none of them.
- During ICE (between the answer and `connected`) polls already report `reconnecting`; tests assert the first states and the final one, not the exact sequence.
- Changelog line for every change (`## Unreleased`), the tag is `v<version>` on `main`, the release workflow takes the notes from the tag's section.
