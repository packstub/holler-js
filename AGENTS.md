# @packstub/holler (repo packstub/holler-js)

The browser engine and widget for WebRTC calls, 1-on-1 and groups up to four: `CallClient` (media, the roster of peers, states, reconnecting after a page load), `MeshTopology` (one `RTCPeerConnection` per peer with perfect negotiation, the lower seat offers; the `topology` option takes an SFU or relay adapter with the same interface for bigger rooms) and `HttpSignaling` (the polling adapter). Framework-agnostic, two ES modules (`src/index.js` the engine, `src/widget.js` + `src/widget.css` the UI), no dependencies. `npm run build` (esbuild, `scripts/build.mjs`) minifies them into `dist/` (gitignored, built on `prepare`, so an install from GitHub and the npm tarball both have it): a bundler takes `src/` through the package exports, a page that loads the files from a server takes `dist/`. MIT. Consumed by `packstub/holler` (`plugins/holler`, the server side, which copies all three `dist` files into its `resources/dist/`) and `packstub/filament-holler` (`plugins/filament-holler`, `dist/index.js` as its `resources/dist/holler-core.js`); after a change here run `npm run build:js:local` in both and their suites. Moved out of `filament-holler/js/` on 2026-10-23; private repo, unpublished on npm.

## Commands

```bash
npm test                 # Vitest: the engine in Node, tests/widget.test.js under jsdom
npm run build            # dist/index.js, dist/widget.js, dist/widget.css, minified
npm run test:dist        # builds, then the same suite against dist/ (CI runs it): what the PHP packages ship
npm run test:types       # the .d.ts files against tests/types/usage.ts
npm run test:watch
```

## Layout

- `src/index.js`: the engine (`filament-holler` ships its minified build alone). Keep it free of DOM, Alpine and Laravel; anything UI goes in `src/widget.js` (`CallWidget`: views rendered from `templates` once and patched through `data-holler-*` hooks by `patch()`; `packstub/holler` copies it with `widget.css` into its `resources/dist/`) or in the consumer. `Peer` is the roster entry, `Link` one connection of the mesh; the topology interface is documented above `MeshTopology`.
- `tests/fakes.js`: `FakeRTCPeerConnection` (fires `negotiationneeded` once per task like a browser, `setConnectionState` / `receiveTrack` / `gatherCandidate` for what the network would do), `FakeMediaStream`, `FakeTrack` (`end()` is the browser's "Stop sharing"), `fakeDevices()` for `getUserMedia` / `getDisplayMedia`, `installBrowserGlobals()`, and `FakeServer`: the signaling backend in memory with the same rules as the Laravel one, extended to groups (a participant per person with a `seat`, a side held by one tab, signals only to the holder and addressed with `to`, a cursor, `invite`, `hold` / `resume` (the `on_hold` status, `on_hold` in the poll), `people` over `server.directory`, a call that ends once fewer than two people are left; `end()` and `tick()` push state around, `participant(callId, userId)` reads a record, `server.log` records every call).
- `tests/call-client.test.js`: two clients talk through a `FakeServer` under `vi.useFakeTimers()`; `connect()` gets a call to `active`, `settle(ms)` advances the timers.
- `tests/hold.test.js`: a call on hold (step out, resume with a fresh connection, swap, every window of mine, a group around someone on hold) and the people search.
- `tests/widget.test.js`: `CallWidget` under jsdom over a `FakeServer` (`// @vitest-environment jsdom`); several widgets share one document, so all but one get `callSelector: null`.
- `tests/devices-quality.test.js`: `devices()` / `setDevice()` (the fake `enumerateDevices`, a track swapped on the sender in place), `measure()` and the `quality` event (`pc.report` is what the fake `getStats()` answers), and a call that never connects (`failed` on both sides, the TURN hint in the console).
- `tests/relay.test.js`: `RelaySignaling` over `FakeServer({ relay: true })` (the caller is the hub; `relay` and `present` in the poll, `hub` and `relay` on the call, `relay: { views, pending }` in the hub's answer). `up(a, b)` brings up a connection and its data channels (`joinChannels()` in the fakes wires the two ends, so what one sends the other receives); the requests each client made are read from `server.log`.
- `tests/group-calls.test.js`: three clients in a mesh (`group()`), a recording topology that checks the interface, and a 1-on-1 backend that strips `peers`, `seat`, `joined` and `from`.

## Conventions

- The signaling interface and the `call` shape in the README are shared with `packstub/holler` and `filament-holler`; a change there is a change in all three repos and in `FakeServer`. `hold`, `resume` and `people` are optional like `invite` (no route, no method, no button). The group fields (`peers`, `seat`, `joined`, `from`, `to`, `invite`) are optional on the wire: the client must keep working against a backend that sends none of them.
- `RelaySignaling` (in `src/index.js`, after `HttpSignaling`) wraps a signaling adapter and is off unless used: the engine only gives it `signaling.attach(client)`, `client.deliver()` and `client.pollNow()`. The poll fields it relies on (`relay`, `present`, `hub`, `relay: { views, pending }`) are optional on the wire like the group fields, documented in the README ("What a backend adds") and implemented by `FakeServer` and by `icaliman/meet-holler`; Holler for Laravel does not send them.
- Until the media has flowed once a call stays `connecting` (`everConnected`); `reconnecting` only after. The widget's labels (`labels` in `src/widget.js`) are mirrored in `packstub/holler` (`resources/lang/*/ui.php`): a new label is a change there too.
- `exports` in `package.json` (`.`, `./widget`, `./widget.css`) must cover every import path the README shows; `sideEffects` keeps the CSS; check with `npm pack --dry-run`.
- Changelog line for every change (`## Unreleased`), the tag is `v<version>` on `main`, the release workflow takes the notes from the tag's section. Keep the section short and human, since the workflow appends GitHub's list of merged pull requests under it: an optional lead sentence, then at most about six one-line bullets saying what a user gets, in plain words (class or method names only when a user needs the name, never lists of them). Always keep breaking changes with an `**Upgrading:**` line, security or privacy fixes, new minimum versions and migrations to run; CI, tests and refactors stay out.

## Release checklist

1.0.0 goes out first, before `packstub/holler` and `packstub/filament-holler`: make the repo public, set `"version": "1.0.0"`, rename `## Unreleased` to `## 1.0.0 — <date>`, `npm pack --dry-run`, `npm publish`, tag `v1.0.0`. The full order across the three repos is in `plugins/filament-holler/AGENTS.md`, section Release checklist. Agents never tag, publish or change visibility.
