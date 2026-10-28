# @packstub/calls

WebRTC calls (audio, video, screen share) for the browser, 1-on-1 and small groups, with a pluggable signaling backend and a pluggable topology. The engine behind [Calls for Laravel](https://github.com/packstub/calls) and [Filament Calls](https://github.com/packstub/filament-calls); no DOM, no framework, one ES module.

- `CallClient` owns the local media and the roster of a call: who is in, who is ringing, who muted, whose media flows. Perfect negotiation per pair (the lower seat offers), ICE candidates applied in order, screen share by track replacement, voice fallback when there is no camera, mute and camera off.
- `MeshTopology` is how media travels by default: a direct `RTCPeerConnection` to every other participant, so no server touches the media. Right for up to four people; the `topology` option takes an SFU or relay adapter for bigger rooms, and the client never knows the difference.
- A call survives a full page load: every window has a random `tab` id, a participant's side belongs to one window at a time, a fresh page claims the side, asks each peer for a new connection (`reset`) and offers again. Signals carry a session id so leftovers from an old connection are ignored.
- `HttpSignaling` is the signaling adapter that ships: plain JSON endpoints, polled. A websocket or any other transport implements the same methods.

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
            invite: '/calls/__ID__/invite',     // optional: adding people to a running call
        },
        headers: { 'X-CSRF-TOKEN': token },
        beaconFields: { _token: token },
    }),
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    video: true,
    poll: { idle: 5000, active: 1000 },
    reconnectTimeout: 15000,
    maxParticipants: 4,
})

client.addEventListener('incoming', ({ detail: { call } }) => showToast(call.peer.name))
client.addEventListener('localstream', ({ detail: { stream } }) => (localVideo.srcObject = stream))
client.addEventListener('remotestream', ({ detail: { stream, peer } }) => (tileFor(peer.id).srcObject = stream))
client.addEventListener('peers', ({ detail: { peers } }) => renderGrid(peers))
client.addEventListener('statechange', ({ detail: { state } }) => render(state))
client.addEventListener('ended', ({ detail: { reason } }) => showNotice(reason))

client.start()                            // poll for incoming calls
await client.callUser(userId)             // ring someone
await client.callUser([anaId, mihaiId])   // or a group
await client.accept()                     // or answer the call that is ringing
await client.invite(danaId)               // add someone to the call, also from a tab whose pop-out runs it (canInvite() says whether one more fits)
client.setMuted(true)                     // everyone else hears about it (peerstate)
await client.shareScreen()
await client.takeOver()                   // a tab in `elsewhere` continues a call its pop-out let go of
await client.hangUp()                     // the others go on without you; the call ends once one person is left

window.addEventListener('pagehide', () => client.leave())
```

### Data channels and calls without media

A call can carry data next to (or instead of) audio and video: name the channels and listen for them. With `media: 'none'` nothing asks for the camera or the microphone; the channel itself starts the connection, and `startMedia('audio')` (or `'video'`) adds media later, renegotiating each connection.

```js
import { CallClient, drain } from '@packstub/calls'

const client = new CallClient({ signaling, media: 'none', channels: ['assist'] })

client.addEventListener('datachannel', ({ detail: { channel, peer } }) => {
    channel.addEventListener('message', ({ data }) => handle(peer, data))
})

await drain(channel)            // before each large message: waits while the browser's buffer is full
channel.send(JSON.stringify(message))
await client.startMedia('audio')
```

Both sides make each channel with an id agreed in advance (its place in `channels`, so every participant lists the same labels in the same order), so they pair up whichever side offers; both get `datachannel` once it is open. `media: 'none'` needs at least one channel. After either side reloads, the new connection opens them again. `client.channel(label, peerId)` returns the open one.

A 1-on-1 call needs none of the group pieces: `remoteVideo.srcObject = stream` on `remotestream` and `client.peer` for the one other person still work.

### States

`idle`, `calling`, `ringing`, `connecting`, `active`, `reconnecting`, `elsewhere` (another window of the same person holds the call, for a tab that shows a chip while a pop-out runs the call).

A call is `active` while media flows from at least one peer whose window is alive, and `reconnecting` when it flows from none; it ends as `dropped` after `reconnectTimeout` in that state. In a group a single peer who went quiet shows as not `alive` on the roster while the call stays `active` for everyone else.

### Events

| Event | Detail | When |
| --- | --- | --- |
| `statechange` | `{ state }` | the state above changed |
| `incoming` | `{ call }` | someone is ringing you, also into a call already running |
| `update` | `{ call }` | the call's server state changed (`held`, `status`, `peers`) |
| `localstream` | `{ stream }` | your camera and microphone, or the screen while sharing |
| `remotestream` | `{ stream, peer }` | a peer's media (fires again as tracks arrive) |
| `peers` | `{ peers }` | the roster changed: someone joined, left, connected, went quiet, muted… (also `client.peers`) |
| `peerjoined` | `{ peer }` | a peer is in the call |
| `peerleft` | `{ peer, reason }` | a peer is gone: `left`, `declined`, `missed` (never answered) or `dropped` (away too long) |
| `peerstate` | `{ peer, muted, cameraOff, sharing }` | a peer muted, turned the camera off or started sharing the screen |
| `datachannel` | `{ peer, channel, label }` | a data channel named in `channels` is open to a peer (again after either side reloads) |
| `ended` | `{ call, reason }` | `declined`, `cancelled`, `missed` (also when a call stopped ringing as you answered), `hung_up`, `failed`, `dropped`, `busy` (the person you rang is on another call; `call` is null) |
| `error` | `{ error, media? }` | a request or media failure; `media: true` when the camera or microphone could not be opened |

A `peer` in an event, and each entry of `client.peers`, is `{ id, name, avatar, seat, status, alive, connected, muted, cameraOff, sharing, stream }`: what the server says (`seat`, `status`, `alive`), what the peer told us (`muted`, `cameraOff`, `sharing`) and what the topology gives (`connected`, `stream`). `client.peer`, `peerMuted`, `peerCameraOff`, `peerSharing` and `remoteStream` are the first peer's, for a 1-on-1 UI.

### Options

| Option | Default | What |
| --- | --- | --- |
| `signaling` | required | an object with the signaling interface below |
| `iceServers` | `[]` | passed to `RTCPeerConnection` as is; or a function asked each time a call starts, e.g. `() => signaling.configuration().then((rtc) => rtc.iceServers)` (route `ice` on `HttpSignaling`), so short-lived TURN credentials are fresh per call |
| `video` | `true` | start calls with the camera on (falls back to voice when there is none) |
| `poll` | `{ idle: 5000, active: 1000, hidden: 15000 }` | milliseconds between polls: idle, during a call, and idle in a hidden tab (it polls at once when shown again) |
| `media` | `'video'` (`'audio'` with `video: false`) | what a call starts with; `'none'` asks for no camera or microphone and connects over data channels only, until `startMedia()` |
| `channels` | `[]` | labels of ordered data channels to open to every peer, surfaced by `datachannel` |
| `iceTransportPolicy` | `'all'` | `'relay'` sends everything through your TURN server, so neither side learns the other's addresses |
| `reconnectTimeout` | `15000` | milliseconds every peer may be away before the call ends as `dropped` |
| `resumes` | `true` | take over a call of mine that no window holds; `false` for a tab that leaves calls to a pop-out |
| `maxParticipants` | `4` | people on one call, me included: `callUser()` refuses a longer list and `canInvite()` says when the call is full (the server keeps the hard limit) |
| `topology` | a `MeshTopology` per call | how media travels: a topology instance, a class, or `(call, client) => topology` to pick one per call from its `peers` |
| `getUserMedia` | `navigator.mediaDevices.getUserMedia` | override for tests or custom constraints |

## Topologies

A topology owns the connections; the client owns everything else (media, roster, signaling, states). `MeshTopology` ships: one `RTCPeerConnection` per peer, each participant uploads one copy of its media per peer, which is what makes four the sensible ceiling. For bigger rooms, an SFU or a relay adapter implements the same interface, and it can be chosen per call:

```js
import { CallClient, MeshTopology } from '@packstub/calls'

new CallClient({
    maxParticipants: 20,
    topology: (call) => call.peers.length > 3 ? new MySfuTopology({ url: sfuUrl }) : new MeshTopology(),
})
```

The interface (`connect`, `disconnect`, `signal`, `connected` and `leave` are required, the rest optional):

```ts
attach(client)                        // once per call, before anything else
join(call)                            // I am in the call (open an uplink, say)
connect(peer, { polite, reset })      // start exchanging media with this peer; `polite` says who offers (the lower
                                      // seat does), `reset` after a page load: tell the peer to drop what it had of me
disconnect(peer)                      // the peer left
reset(peer, payload)                  // the peer is back on a fresh page and will offer again
stale(peer, payload)                  // a `state` signal from an old connection of theirs, to ignore
signal(peer, type, payload, from)     // offer | answer | ice, and anything the topology itself sends; `peer` is
                                      // null for a sender the roster does not know (an SFU, say)
connected(peer)                       // whether the peer's media flows
replaceVideo(track)                   // the screen in place of the camera (null: the camera is off, or voice only)
addTracks(stream)                     // media started mid-call (`startMedia()`): send these tracks too
channel(peer, label)                  // the open data channel with this label to the peer, or null
leave()                               // hang up: close everything
```

What the client offers a topology: `iceServers`, `iceTransportPolicy`, `channelLabels`, `seat`, `localSource()` (the stream whose tracks go out), `send(type, payload, to)` (a signal to one participant, or to all with `to` null), `remoteStreamFrom(peer, stream)`, `connectionChanged(peer, connected)`, `negotiated(peer)` (the client then tells the peer what I have on) and `emit('error', { error })`. A topology picked by a factory is made per call; an instance is reused and re-attached. Switching topology in the middle of a call is not supported: pick it from the size the call starts with, and let the server cap invites to match.

## The signaling interface

```ts
start(callees, tab)                  → call     // one user id, or an array of them for a group
answer(callId, tab)                  → call
decline(callId)                      → call
hangup(callId)                       → call
invite(callId, userId)               → call     // optional; add someone to a running call
send(callId, type, payload, to)      → void     // offer | answer | ice | reset | state; `to` a user id, or null for every other participant
poll({ after, call, tab, hold, kind }) → { call, incoming, signals, cursor }   // kind: only calls of that kind
leave(callId, tab)                   → void     // optional, a beacon as the page unloads
```

A failed request rejects with an `Error` carrying `status` and, from Calls for Laravel, `reason` (`busy`, `not_ringing`, `not_allowed`, `full`, `ended`, `too_large`): the two 409s (busy, no longer ringing) are told apart by it.

A `call` is `{ id, kind, status: 'ringing' | 'active' | 'ended', end_reason, role: 'caller' | 'callee', seat, joined, peers, answered_at, held }` plus `peer`, `peer_held` and `peer_seen_ago` for the first peer. `peers` lists every other participant as `{ id, name, avatar, seat, status: 'ringing' | 'joined' | 'left' | 'declined' | 'missed' | 'dropped', held, seen_ago }`. `seat` is the order people were invited in (the caller has 0); between two participants the lower seat makes the offer. `joined` is whether I am in (false while the call rings me). `held` means another window of mine holds my side; a peer's `held` that it has a live window on the call.

A signal is `{ id, call, type, payload, from }`, `from` being the sender's user id. An `answer` payload names the `offer` it answers (the offerer's session), so an answer to an offer from before the offerer's page reloaded is ignored.

**A 1-on-1 backend** sends neither `peers`, `seat`, `joined` nor `from`, and ignores `to`: the client derives them (the caller has seat 0, the callee seat 1, the one peer is the sender), so [Calls for Laravel](https://github.com/packstub/calls) works unchanged until it learns groups. `invite` and the route for it are optional; without them `canInvite()` is false.

`poll` is the one request every window repeats: with `hold` set it claims this user's side of the named call for `tab` (and is its heartbeat), and only the window that holds the side receives the signals. The server marks a side whose window stopped polling as free after a few seconds, so a reloaded page can take it. A call ends on the server once fewer than two people are left in it; someone who hangs up on a group leaves it for the others.

`HttpSignaling` maps these onto the routes above; `__ID__` in a route is replaced with the call id. Its `kind` option adds `kind=` to every poll, and `timeout` (10 s) gives up a request that hangs, so one stalled poll or signal cannot stop the rest. `start` posts `{ callee, tab }` for one person and `{ callees, tab }` for a group; `send` adds `to` when set; `invite` posts `{ callee }`. [Calls for Laravel](https://github.com/packstub/calls) implements the server side; the README there documents the endpoints for other backends.

## The widget

`CallWidget` is the UI over `CallClient`, plain DOM, no framework: the incoming-call toast, the call window (a tile per other participant with their video or avatar, your own picture, mute, camera, screen share, hang up), the chip shown while a pop-out window runs the call, and notices. A shared screen takes the stage with the cameras in a strip on top or on the right, wherever it gets more room.

```js
import { CallWidget } from '@packstub/calls/widget'
import '@packstub/calls/widget.css'

const widget = new CallWidget({
    routes, csrf,                       // an HttpSignaling is made from these (or pass `signaling`, or a `client` of your own)
    iceServers, video, maxParticipants,
    windowUrl: '/calls/window?call=__ID__&callee=__USER__',  // set it and calls open in a window of their own
    labels: { incoming: 'te sună' },     // any of the texts
})
```

Any element with `data-calls-call="<user id>"` rings that person (or adds them to the call you are on); `widget.callUser(id)`, `accept()`, `decline()`, `hangUp()`, `add(id)`, `toggleMute()`, `toggleCamera()`, `toggleShare()` and `show(text)` do the same from a script. Every client event is dispatched again on the widget's element as `calls:<type>` (bubbling), plus `calls:sharing` `{ peer, sharing, spotlight }`. On the pop-out page itself, `inPopOut: true` makes the widget fill the window and do what the page that opened it asked: that page leaves a one-time token in `localStorage` and adds it to the URL (`&open=`), so a link alone never rings anyone or answers a call; it shows the call, with Accept. `destroy()` takes it all down: it stops polling, lets go of the call for the next page and closes the camera and the connections of the client it made. Signed out (401, 419) it stops polling quietly. `kind` (`call`) keeps other packages' calls away from the widget; `iceTransportPolicy` is passed on.

Three ways to make it yours:

- **CSS.** Every class is `calls-*`; the colours and sizes are custom properties on `.calls` (`--calls-bg`, `--calls-fg`, `--calls-dim`, `--calls-accent`, `--calls-danger`, `--calls-success`, `--calls-stage`, `--calls-radius`, `--calls-width`, `--calls-z`, `--calls-font`). Skip `widget.css` and write your own against the class names when that is not enough.
- **Templates.** `templates.incoming`, `chip`, `window`, `tile` and `notice` are functions from a view model to an HTML string, rendered once each time the view appears and then kept current through hooks: `data-calls-text="key"`, `data-calls-show="key"` (or `"!key"`), `data-calls-class="name:key …"`, `data-calls-attr="name:key …"`, `data-calls-src="key"`, `data-calls-video="key"` (a MediaStream) and `data-calls-action="accept|decline|hangUp|toggleMute|toggleCamera|toggleShare|focusWindow"`. The root of a template carries `data-calls-scope`; the window's needs `data-calls-ref="grid"` for the tiles and `data-calls-ref="stage"` for the strip. Pass `templates`, `labels` and `icons` to the constructor, or set them on the widget before `start()` (with `startPolling: false`). The model is what `model()` returns (`names`, `status`, `peerName`, `peerAvatar`, `hasAvatar`, `initials`, `others`, `hasOthers`, `othersLabel`, `muted`, `cameraOff`, `sharing`, `canShare`, `localStream`, `count`, `spotlight`, `strip`, `notice`, the titles, plus `labels` and `icons`) and, for a tile, `tileModel(peer)` (the peer's `id`, `name`, `avatar`, `status`, `connected`, `muted`, `cameraOff`, `sharing`, `stream`, `hasVideo`, plus `initials`, `hasAvatar`, `ringing`, `connecting`, `showVideo`, `showName`, `cameraOffBadge`, `role`).
- **Subclass.** `model()`, `tileModel()`, `render()`, `renderTiles()`, `placeStrip()` and the actions are methods on `CallWidget`.

`CallClient` methods not documented here (`tick`, `handlePoll`, `join`, `resume`, `ring`, `placeCall`, `answerCall`, `doTakeOver`…) are internal: they may change in any release.

## Testing

```bash
npm test
```

The suite runs in Node with fakes for `RTCPeerConnection`, `MediaStream` and the media devices, and an in-memory signaling server that follows the backend's rules (participants with seats, a side held by one window, addressed signals), so two or three clients talk to each other through it in a test.

## License

MIT, see [LICENSE.md](LICENSE.md).
