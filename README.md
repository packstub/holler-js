# @packstub/calls

1-on-1 WebRTC calls (audio, video, screen share) for the browser, with a pluggable signaling backend. The engine behind [Calls for Laravel](https://github.com/packstub/calls) and [Filament Calls](https://github.com/packstub/filament-calls); no DOM, no framework, one ES module.

- `CallClient` owns the media streams and the `RTCPeerConnection`: perfect negotiation (the callee is the polite side), ICE candidates applied in order, screen share by track replacement, voice fallback when there is no camera, mute and camera off.
- A call survives a full page load: every window has a random `tab` id, a side of a call belongs to one window at a time, a fresh page claims the side, asks the other side for a new connection (`reset`) and offers again. Signals carry a session id so leftovers from an old connection are ignored.
- `HttpSignaling` is the adapter that ships: plain JSON endpoints, polled. A websocket or any other transport implements the same six methods.

## Install

```bash
npm install @packstub/calls
```

## Use

```js
import { CallClient, HttpSignaling } from '@packstub/calls'

const client = new CallClient({
    signaling: new HttpSignaling({
        routes: {
            poll: '/calls/poll',
            store: '/calls',
            answer: '/calls/__ID__/answer',
            decline: '/calls/__ID__/decline',
            hangup: '/calls/__ID__/hangup',
            signal: '/calls/__ID__/signals',
            leave: '/calls/__ID__/leave',
        },
        headers: { 'X-CSRF-TOKEN': token },
        beaconFields: { _token: token },
    }),
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    video: true,
    poll: { idle: 5000, active: 1000 },
    reconnectTimeout: 15000,
})

client.addEventListener('incoming', ({ detail: { call } }) => showToast(call.peer.name))
client.addEventListener('localstream', ({ detail: { stream } }) => (localVideo.srcObject = stream))
client.addEventListener('remotestream', ({ detail: { stream } }) => (remoteVideo.srcObject = stream))
client.addEventListener('statechange', ({ detail: { state } }) => render(state))
client.addEventListener('ended', ({ detail: { reason } }) => showNotice(reason))

client.start()                      // poll for incoming calls
await client.callUser(userId)       // ring someone
await client.accept()               // or answer the call that is ringing
client.setMuted(true)               // the other side hears about it (peerstate)
await client.shareScreen()
await client.takeOver()             // a tab in `elsewhere` continues a call its pop-out let go of
await client.hangUp()

window.addEventListener('pagehide', () => client.leave())
```

### States

`idle`, `calling`, `ringing`, `connecting`, `active`, `reconnecting`, `elsewhere` (another window of the same person holds the call, for a tab that shows a chip while a pop-out runs the call).

### Events

| Event | Detail | When |
| --- | --- | --- |
| `statechange` | `{ state }` | the state above changed |
| `incoming` | `{ call }` | someone is ringing you |
| `update` | `{ call }` | the call's server state changed (`held`, `peer_held`, `status`) |
| `localstream` | `{ stream }` | your camera and microphone, or the screen while sharing |
| `remotestream` | `{ stream }` | the other side's media (fires again as tracks arrive) |
| `peerstate` | `{ muted, cameraOff, sharing }` | the other side muted, turned the camera off or started sharing the screen (also `client.peerMuted`, `peerCameraOff`, `peerSharing`) |
| `ended` | `{ call, reason }` | `declined`, `cancelled`, `missed`, `hung_up`, `failed`, `dropped`, `busy` |
| `error` | `{ error, media? }` | a request or media failure; `media: true` when the camera or microphone could not be opened |

### Options

| Option | Default | What |
| --- | --- | --- |
| `signaling` | required | an object with the signaling interface below |
| `iceServers` | `[]` | passed to `RTCPeerConnection` as is |
| `video` | `true` | start calls with the camera on (falls back to voice when there is none) |
| `poll` | `{ idle: 5000, active: 1000 }` | milliseconds between polls, idle and during a call |
| `reconnectTimeout` | `15000` | milliseconds the other side may be away before the call ends as `dropped` |
| `resumes` | `true` | take over a call of mine that no window holds; `false` for a tab that leaves calls to a pop-out |
| `getUserMedia` | `navigator.mediaDevices.getUserMedia` | override for tests or custom constraints |

## The signaling interface

```ts
start(userId, tab)               → call
answer(callId, tab)              → call
decline(callId)                  → call
hangup(callId)                   → call
send(callId, type, payload)      → void     // offer | answer | ice | reset | state
poll({ after, call, tab, hold }) → { call, incoming, signals, cursor }
leave(callId, tab)               → void     // optional, a beacon as the page unloads
```

A `call` is `{ id, status: 'ringing' | 'active' | 'ended', end_reason, role: 'caller' | 'callee', peer: { id, name, avatar }, answered_at, held, peer_held, peer_seen_ago }`. `held` means another window of mine holds this side; `peer_held` that the other side has a live window on it.

`poll` is the one request every window repeats: with `hold` set it claims this user's side of the named call for `tab` (and is its heartbeat), and only the window that holds the side receives the signals. The server marks a side whose window stopped polling as free after a few seconds, so a reloaded page can take it.

`HttpSignaling` maps these onto the routes above; `__ID__` in a route is replaced with the call id. [Calls for Laravel](https://github.com/packstub/calls) implements the server side; the README there documents the endpoints for other backends.

## Testing

```bash
npm test
```

The suite runs in Node with fakes for `RTCPeerConnection`, `MediaStream` and the media devices, and an in-memory signaling server that follows the backend's rules, so two clients talk to each other through it in a test.

## License

MIT, see [LICENSE.md](LICENSE.md).
