# Changelog

All notable changes to `@packstub/calls` are documented in this file.

## Unreleased

First release: the browser side of WebRTC calls, 1-on-1 and in small groups, as plain ES modules with no dependencies and no build step. The engine started inside `packstub/filament-calls` (its `js/` folder) and is shared by Calls for Laravel and Filament Calls.

### The engine (`@packstub/calls`)

- `CallClient`: local media, the roster of a call and its states (`idle`, `calling`, `ringing`, `connecting`, `active`, `reconnecting`, `elsewhere`). Ring one person or a group with `callUser()`, add someone with `invite()` (`canInvite()`, `maxParticipants`, 4 by default), `accept()`, `decline()`, `hangUp()`; someone who hangs up leaves the call for the others.
- Mute, camera off and screen share by track replacement, a voice fallback when there is no camera, and a `state` signal so everyone sees who muted, turned the camera off or shares the screen (`peerstate`). What is on is told again to a peer who joins or reloads.
- A roster of peers (`peers`, `peerjoined`, `peerleft`, `peerstate` and `remotestream` name the peer), each with a seat: between two participants the lower seat makes the offer. A call stays `active` while media flows from at least one peer and ends as `dropped` after `reconnectTimeout` with none. `peer`, `peerMuted`, `remoteStream` and friends cover a 1-on-1 UI.
- `MeshTopology` by default, one `RTCPeerConnection` per peer with perfect negotiation and ICE candidates applied in order. The `topology` option takes an instance, a class or a factory per call with a small interface (`attach`, `connect`, `disconnect`, `signal`, `connected`, `leave`, plus optional `join`, `reset`, `stale`, `replaceVideo`, `addTracks`, `channel`) for an SFU or a relay in bigger rooms.
- Calls survive a page load: each window has a `tab` id and holds its side through the poll, `leave()` frees it on `pagehide`, and a fresh page claims the side, resets each peer and offers again. Signals carry a session, and an `answer` names the offer it answers, so leftovers from an old connection are ignored; both pages reloading at once connect again.
- Pop-out support: `handOff()` and the `elsewhere` state for a tab whose pop-out runs the call, `resumeCall()` for the pop-out, `takeOver()` to continue the call in the tab once the pop-out is gone (a pop-out that is only reloading keeps its side), and `resumes: false` for a tab that leaves calls to a pop-out.
- Data channels and calls without media: `channels` opens ordered, pre-negotiated data channels to every peer (`datachannel` event, `client.channel()`, `drain()` while a buffer is full), `media: 'none'` connects without camera or microphone, and `startMedia('audio' | 'video')` adds them mid-call.
- `iceServers` may be a function asked each time a call starts, so short-lived TURN credentials stay fresh in a long-lived page; `iceTransportPolicy: 'relay'` keeps everyone's addresses behind TURN.
- The camera prompt never stops the heartbeat, a double click asks for the camera and rings or answers once, a call that rings while you place one can still be answered, and a hidden tab with no call polls every `poll.hidden` ms (15 s). `destroy()` takes it all down without events.
- Errors carry the server's `reason`: ringing someone on another call ends as `ended { reason: 'busy' }`, a call that stopped ringing as you answered ends as `missed`, and a window ringing for a call the server gave up on (the invitee was marked missed, or declined on another device) stops ringing and ends as `missed`.

### Signaling

- `HttpSignaling`: the polling adapter over JSON routes (`__ID__` for the call id), with `headers` for CSRF, a `leave` beacon with `beaconFields`, a request `timeout` (10 s), `kind` to poll only for calls of one kind, and `configuration()` for the optional `ice` route.
- The signaling interface (`start`, `answer`, `decline`, `hangup`, `send`, `poll`, and optional `invite`, `leave`, `configuration`) and the call shape are documented for other backends. Signals can be addressed to one participant (`to`) and carry `from`; a backend without groups, which sends no `peers`, `seat`, `joined` or `from`, still works.

### The widget (`@packstub/calls/widget`, `widget.css`)

- `CallWidget`: the call UI for any page without a framework: incoming toast, a call window with a tile per participant and your own picture, mute, camera, screen share (a shared screen takes the stage, the cameras in a strip), hang up, the chip while a pop-out runs the call, notices and ring tones.
- The pop-out flow (`windowUrl`, `inPopOut`): the opening page leaves a one-time token in `localStorage`, so a pop-out link alone never rings anyone or answers a call, and an open pop-out is found by name instead of reopened.
- `data-calls-call` elements and a `calls:call` event ring people; every client event is dispatched on the page as `calls:<type>`, plus `calls:sharing`. Signed out (401, 419) it stops polling quietly.
- Make it yours with `--calls-*` custom properties, `labels`, `icons` and the five view `templates` kept current through `data-calls-*` hooks, or subclass it.
- A Vitest suite with fake WebRTC globals and an in-memory signaling server with the backend's rules; the widget is tested under jsdom.
