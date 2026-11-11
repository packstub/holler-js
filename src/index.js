/**
 * @packstub/calls — WebRTC calls for the browser, 1-on-1 and small groups, with a
 * pluggable signaling backend and a pluggable topology.
 *
 * Framework-agnostic: no DOM, no Alpine, no Laravel. A CallClient owns the local
 * media and the roster of a call and talks to the other participants through a
 * `signaling` object; how the media travels between them is the job of a
 * `topology`. MeshTopology is the one that ships: a direct RTCPeerConnection to
 * every other participant, right for up to four people and no server in the
 * media path. An SFU or a relay implements the same few methods for bigger rooms.
 * HttpSignaling is the signaling adapter that ships (plain JSON endpoints,
 * polled); a websocket or Firebase one implements the same methods.
 *
 * Signaling interface:
 *   start(callees, tab)               → call     (one user id, or an array of them for a group)
 *   answer(callId, tab)               → call
 *   decline(callId) / hangup(callId)  → call
 *   invite(callId, userId)            → call     (optional; adds someone to a running call)
 *   send(callId, type, payload, to)   → void     (offer | answer | ice | reset | state; `to` a user id, null for every other participant)
 *   poll({ after, call, tab, hold, kind }) → { call, incoming, signals, cursor }   (hold: this window wants my side; kind: only calls of that kind)
 *   leave(callId, tab)                → void     (optional; a beacon as the page unloads)
 *
 * A failed request rejects with an Error carrying `status` (HTTP) and `reason` (`busy`, `not_ringing`,
 * `not_allowed`, `full`, `ended`, `too_large` from the Laravel backend).
 *
 * A `call` is { id, kind, status: ringing|active|ended, end_reason, role: caller|callee, seat, joined,
 * peers: [{ id, name, avatar, seat, status: ringing|joined|left|declined|missed|dropped, held, seen_ago }],
 * held, answered_at }, plus `peer`, `peer_held` and `peer_seen_ago` for the first peer.
 * Those three are all a 1-on-1 backend needs to send: without `peers`, `seat` and
 * `joined` the client derives them (the caller has seat 0, the callee seat 1).
 * `seat` is the order people were invited in; between two participants the lower
 * seat makes the offer. `joined` is whether I am in (false while the call rings me).
 * `held` means another window of mine holds my side of this call (a pop-out); a
 * peer's `held` that it has a live window on the call.
 *
 * A signal is { id, call, type, payload, from }; `from` is the sender's user id (a
 * 1-on-1 backend may leave it out).
 *
 * Every window has a random `tab` id. The server hands a participant's side to one
 * tab at a time; a page that reloads sends `leave`, the new page claims the side
 * again, sends `reset` to each peer and makes a fresh offer, and each peer builds a
 * new connection for it. Signals carry the sender's `session` (one per connection)
 * so leftovers from an old connection are ignored.
 *
 * Events (CallClient extends EventTarget, detail on each):
 *   statechange { state }   idle | calling | ringing | connecting | active | reconnecting | elsewhere
 *   incoming    { call }    someone is ringing you
 *   update      { call }    the call's server state changed (held, status, peers…)
 *   localstream { stream }  your camera/mic (or screen) stream, also after a share switch
 *   remotestream{ stream, peer }  a peer's media (fires again as tracks arrive)
 *   peers       { peers }   the roster changed: someone joined, left, connected, muted…
 *   peerjoined  { peer }    a peer is in the call
 *   peerleft    { peer, reason }  a peer is gone (left | declined | missed | dropped)
 *   peerstate   { peer, muted, cameraOff, sharing }  a peer muted, turned the camera off or shares the screen
 *   datachannel { peer, channel, label }  a data channel to a peer is open (see the `channels` option)
 *   ended       { call, reason }  declined | cancelled | missed | hung_up | failed | dropped | busy
 *   error       { error }
 */

// A data channel's sender waits once this much is queued (see `drain()`).
const CHANNEL_LOW_WATER = 1024 * 1024

// How long a connection may stay `disconnected` before the offering side restarts ICE.
const ICE_RESTART_DELAY = 3000

/**
 * Wait until a data channel has room again (its buffer is down to the low-water
 * mark): call before each large `send()` so a fast sender cannot fill the
 * browser's buffer, which closes the channel. Resolves at once when there is room.
 *
 * @param {RTCDataChannel} channel
 */
export function drain(channel) {
    if (channel.readyState !== 'open' || channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve()

    return new Promise((resolve) => {
        const done = () => {
            channel.removeEventListener('bufferedamountlow', done)
            channel.removeEventListener('close', done)
            resolve()
        }
        channel.addEventListener('bufferedamountlow', done)
        channel.addEventListener('close', done)
    })
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

// A backend may trim the description (Laravel's TrimStrings middleware does); the
// parser wants every line, the last one included, to end in CRLF.
const sdp = (text) => text.endsWith('\r\n') ? text : `${text.replace(/\r?\n$/, '')}\r\n`

export class HttpSignaling {
    /**
     * @param {object} options
     * @param {{ poll: string, store: string, answer: string, decline: string, hangup: string, signal: string, leave?: string, invite?: string }} options.routes
     *   Per-call routes contain `__ID__` where the call id goes.
     * @param {Record<string, string>} [options.headers] e.g. { 'X-CSRF-TOKEN': token }
     * @param {Record<string, string>} [options.beaconFields] form fields sent with the leave beacon, e.g. { _token: token }
     * @param {typeof fetch} [options.fetch]
     * @param {number} [options.timeout]  milliseconds before a request is given up (a stalled poll would stop polling, a stalled signal every signal behind it)
     * @param {string} [options.kind]  poll only for calls of this kind (`call` for the widgets)
     */
    constructor({ routes, headers = {}, beaconFields = {}, fetch: fetchFn, timeout = 10000, kind = null } = {}) {
        this.routes = routes
        this.headers = headers
        this.beaconFields = beaconFields
        this.timeout = timeout
        this.kind = kind
        this.fetch = fetchFn || ((...args) => globalThis.fetch(...args))

        // Only a backend with the route can add people to a call, or hand out ICE servers per call.
        if (! routes?.invite) this.invite = undefined
        if (! routes?.ice) this.configuration = undefined
    }

    url(name, callId) {
        return this.routes[name].replace('__ID__', encodeURIComponent(callId))
    }

    async request(method, url, body) {
        const response = await this.fetch(url, {
            method,
            credentials: 'same-origin',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...this.headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: this.timeout && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(this.timeout) : undefined,
        })

        let data = {}
        let parsed = true
        try {
            if (typeof response.text === 'function') {
                const text = await response.text()
                if (text.trim() !== '') data = JSON.parse(text) ?? {}
            } else {
                data = (await response.json()) ?? {}
            }
        } catch {
            parsed = false
        }

        if (! response.ok) {
            const error = new Error(data.message || `${method} ${url} failed (${response.status})`)
            error.status = response.status
            error.reason = data.reason ?? null
            throw error
        }

        // A page instead of JSON (a login form behind a redirect, a proxy's error page): read as
        // "no call", it would end the call this window is on.
        if (! parsed) {
            throw Object.assign(new Error(`${method} ${url} did not answer with JSON (${response.status})`), { status: response.status, reason: 'invalid_response' })
        }

        return data
    }

    /** One user id rings that person (`callee`); an array rings a group (`callees`). */
    start(callees, tab) {
        return this.request('POST', this.routes.store, Array.isArray(callees) ? { callees, tab } : { callee: callees, tab })
    }

    /** What the browsers connect through, asked when a call starts (route `ice`): `{ iceServers, iceTransportPolicy }`. */
    configuration() { return this.request('GET', this.routes.ice) }

    answer(callId, tab) { return this.request('POST', this.url('answer', callId), { tab }) }
    decline(callId) { return this.request('POST', this.url('decline', callId)) }
    hangup(callId) { return this.request('POST', this.url('hangup', callId)) }
    invite(callId, userId) { return this.request('POST', this.url('invite', callId), { callee: userId }) }

    send(callId, type, payload, to = null) {
        return this.request('POST', this.url('signal', callId), to === null || to === undefined ? { type, payload } : { type, payload, to })
    }

    poll({ after = 0, call = null, tab = null, hold = false, kind = this.kind } = {}) {
        const query = new URLSearchParams({ after: String(after) })
        if (call) query.set('call', String(call))
        if (tab) query.set('tab', tab)
        if (hold) query.set('hold', '1')
        if (kind) query.set('kind', kind)

        return this.request('GET', `${this.routes.poll}?${query}`)
    }

    /** Fire and forget as the page unloads: a beacon, with the fields a CSRF check wants. */
    leave(callId, tab) {
        if (! this.routes.leave) return

        const body = new FormData()
        body.append('tab', tab)
        for (const [key, value] of Object.entries(this.beaconFields)) body.append(key, value)

        const url = this.url('leave', callId)
        if (navigator.sendBeacon?.(url, body)) return

        this.fetch(url, { method: 'POST', credentials: 'same-origin', body, keepalive: true }).catch(() => {})
    }
}

/**
 * Another participant of the call, as the client knows them: what the server says
 * (name, seat, status, heartbeat), what they told us (mute, camera, screen share)
 * and what the topology gives us (their media, whether we are connected).
 */
class Peer {
    constructor(id) {
        this.id = String(id)
        this.name = this.id
        this.avatar = null
        this.seat = null
        this.status = 'ringing'
        this.held = null
        this.seenAgo = null
        this.muted = false
        this.cameraOff = false
        this.sharing = false
        this.stream = null
        this.connected = false
    }

    /** Take the server's view; true when something a UI shows changed. */
    update({ name, avatar, seat, status, held, seen_ago }) {
        const before = `${this.name}|${this.avatar}|${this.seat}|${this.status}|${this.alive}`

        if (name !== undefined) this.name = name ?? this.id
        if (avatar !== undefined) this.avatar = avatar ?? null
        if (seat !== undefined && seat !== null) this.seat = seat
        if (status !== undefined) this.status = status
        if (held !== undefined) this.held = held
        if (seen_ago !== undefined) this.seenAgo = seen_ago

        return before !== `${this.name}|${this.avatar}|${this.seat}|${this.status}|${this.alive}`
    }

    /** Their window polls: a side that went quiet is reconnecting, not here. */
    get alive() {
        return this.held !== false && (this.seenAgo ?? 0) < 6
    }

    snapshot() {
        const { id, name, avatar, seat, status, alive, connected, muted, cameraOff, sharing, stream } = this

        return { id, name, avatar, seat, status, alive, connected, muted, cameraOff, sharing, stream }
    }
}

/**
 * One RTCPeerConnection to one peer, with perfect negotiation: the polite side
 * waits for the other side's first offer and answers it.
 */
class Link {
    constructor(mesh, peer, polite, fresh = false) {
        this.mesh = mesh
        this.peer = peer
        this.polite = polite
        // Made after a page load (it sent `reset`); settled once an offer and an answer went through.
        this.fresh = fresh
        this.settled = false
        this.session = randomId()
        this.peerSession = null
        this.negotiated = ! polite
        this.makingOffer = false
        this.ignoreOffer = false
        this.closed = false
        // Candidates that arrive before the remote description wait here.
        this.pending = []
        this.stream = new MediaStream()

        const client = mesh.client
        const pc = new RTCPeerConnection({ iceServers: client.iceServers, iceTransportPolicy: client.iceTransportPolicy })
        this.pc = pc
        this.channels = new Map()

        this.addTracks(client.localSource())

        // The data channels, made on both sides with an id agreed in advance (the order of
        // `channels`), so they pair up whichever side offers, also after both pages reloaded.
        // On a call without media the offering side's channels start the negotiation.
        client.channelLabels.forEach((label, id) => {
            this.adopt(pc.createDataChannel(label, { ordered: true, negotiated: true, id }))
        })

        pc.addEventListener('track', ({ track }) => {
            if (this.closed) return
            this.stream.addTrack(track)
            client.remoteStreamFrom(peer, this.stream)
        })

        pc.addEventListener('icecandidate', ({ candidate }) => {
            if (candidate && ! this.closed) this.send('ice', candidate.toJSON())
        })

        pc.addEventListener('negotiationneeded', async () => {
            if (this.closed) return
            if (this.polite && ! this.negotiated) return

            try {
                this.makingOffer = true
                await pc.setLocalDescription()
                this.send('offer', { sdp: pc.localDescription.sdp })
            } catch (error) {
                client.emit('error', { error })
            } finally {
                this.makingOffer = false
            }
        })

        pc.addEventListener('connectionstatechange', () => {
            if (this.closed) return
            clearTimeout(this.restartTimer)
            this.restartTimer = null
            if (pc.connectionState === 'failed' && ! this.polite) pc.restartIce()
            // A network change (Wi-Fi to mobile data) leaves the connection `disconnected`; browsers
            // call it `failed` only after about 30 seconds, past the reconnect timeout. Restart sooner.
            if (pc.connectionState === 'disconnected') {
                this.restartTimer = setTimeout(() => {
                    this.restartTimer = null
                    if (! this.closed && ! this.polite && pc.connectionState === 'disconnected') pc.restartIce()
                }, ICE_RESTART_DELAY)
            }
            client.connectionChanged(peer, this.connected)
        })
    }

    get connected() {
        return this.pc.connectionState === 'connected'
    }

    /**
     * Send these tracks to the peer (the ones not sent yet): a sender whose track was
     * stopped (the microphone asked for again with the camera) takes the new one in
     * place, anything else is added, which renegotiates.
     */
    addTracks(source) {
        const senders = this.pc.getSenders()
        const sent = new Set(senders.map((sender) => sender.track).filter(Boolean))

        source?.getTracks().forEach((track) => {
            if (sent.has(track)) return
            // A sender whose track was stopped, or the empty video sender a screen share left behind.
            const spent = senders.find((sender) => (sender.track?.kind === track.kind && sender.track.readyState === 'ended')
                || (track.kind === 'video' && sender.track === null && sender.__video))
            if (spent) {
                sent.add(track)
                spent.replaceTrack(track).catch((error) => this.mesh.client.emit('error', { error }))
                return
            }
            const sender = this.pc.addTrack(track, source)
            if (track.kind === 'video') sender.__video = true
        })
    }

    adopt(channel) {
        channel.bufferedAmountLowThreshold = CHANNEL_LOW_WATER
        this.channels.set(channel.label, channel)

        const open = () => {
            if (! this.closed) this.mesh.client.emit('datachannel', { peer: this.peer.snapshot(), channel, label: channel.label })
        }

        if (channel.readyState === 'open') open()
        else channel.addEventListener('open', open, { once: true })
    }

    send(type, payload) {
        this.mesh.client.send(type, { ...payload, session: this.session }, this.peer.id)
    }

    /** A signal from an older connection of theirs, to ignore. */
    stale(payload) {
        return Boolean(this.peerSession && payload.session && payload.session !== this.peerSession)
    }

    async signal(type, payload) {
        const pc = this.pc
        const client = this.mesh.client

        try {
            if (this.stale(payload)) return

            if (type === 'offer') {
                const collision = this.makingOffer || pc.signalingState !== 'stable'
                // Two fresh pages offering to each other: the higher seat gives way.
                const yields = this.polite || (this.fresh && ! this.settled && client.seat > (this.peer.seat ?? -1))
                this.ignoreOffer = ! yields && collision
                if (this.ignoreOffer) return
                if (collision) this.polite = true

                this.peerSession ??= payload.session ?? null
                await pc.setRemoteDescription({ type: 'offer', sdp: sdp(payload.sdp) })
                await this.flushCandidates()
                await pc.setLocalDescription()
                this.negotiated = true
                this.settled = true
                // Which offer this answers: the offerer may have reloaded meanwhile and offered again.
                this.send('answer', { sdp: pc.localDescription.sdp, offer: payload.session ?? null })
                client.negotiated(this.peer)
            } else if (type === 'answer') {
                if (pc.signalingState !== 'have-local-offer') return
                if (payload.offer && payload.offer !== this.session) return
                this.peerSession ??= payload.session ?? null
                await pc.setRemoteDescription({ type: 'answer', sdp: sdp(payload.sdp) })
                this.settled = true
                await this.flushCandidates()
                client.negotiated(this.peer)
            } else if (type === 'ice') {
                if (! pc.remoteDescription) {
                    this.pending.push(payload)
                    return
                }
                try {
                    await pc.addIceCandidate(payload)
                } catch (error) {
                    if (! this.ignoreOffer) throw error
                }
            }
        } catch (error) {
            client.emit('error', { error })
        }
    }

    async flushCandidates() {
        const candidates = this.pending.splice(0)
        for (const candidate of candidates) {
            await this.pc.addIceCandidate(candidate).catch(() => {})
        }
    }

    async replaceVideo(track) {
        const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video' || (s.track === null && s.__video))

        if (sender) {
            await sender.replaceTrack(track)
            sender.__video = true
        } else if (track) {
            // A voice call sharing a screen: adding a track renegotiates.
            const added = this.pc.addTrack(track, this.mesh.client.localSource())
            added.__video = true
        }
    }

    close() {
        if (this.closed) return
        this.closed = true
        clearTimeout(this.restartTimer)
        for (const channel of this.channels.values()) { try { channel.close() } catch {} }
        this.channels.clear()
        this.pc.getSenders().forEach((sender) => { try { this.pc.removeTrack(sender) } catch {} })
        this.pc.close()
    }
}

/**
 * Full mesh: a direct connection to every other participant. No server touches the
 * media, and each participant uploads one copy per peer, which is fine up to about
 * four people. The default topology.
 *
 * The topology interface, for an SFU or a relay (every method but `attach`, `connect`,
 * `disconnect`, `signal`, `connected` and `leave` is optional):
 *   attach(client)                        once per call, before anything else
 *   join(call)                            I am in the call (open an uplink, say)
 *   connect(peer, { polite, reset })      start receiving from and sending to this peer; `polite` says who
 *                                         offers (the lower seat does); `reset` after a page load: tell the peer
 *                                         to drop what it had of me
 *   disconnect(peer)                      the peer left
 *   reset(peer, payload)                  the peer is back on a fresh page and will offer again
 *   stale(peer, payload)                  a `state` signal from an old connection of theirs, to ignore
 *   signal(peer, type, payload, from)     offer | answer | ice (and anything the topology itself sends)
 *   connected(peer)                       whether the peer's media flows
 *   replaceVideo(track)                   the screen in place of the camera (null: nothing)
 *   addTracks(stream)                     media started mid-call (`startMedia()`): send these tracks too
 *   channel(peer, label)                  the open data channel with this label to a peer, or null
 *   leave()                               hang up: close everything
 * The client offers: `iceServers`, `iceTransportPolicy`, `channelLabels`, `seat`, `localSource()`, `send(type, payload, to)`, `emit(type, detail)`,
 * `remoteStreamFrom(peer, stream)`, `connectionChanged(peer, connected)`, `negotiated(peer)`.
 */
export class MeshTopology {
    constructor() {
        this.client = null
        this.links = new Map()
    }

    attach(client) {
        this.client = client
    }

    connect(peer, { polite = false, reset = false } = {}) {
        this.links.get(peer.id)?.close()
        const link = new Link(this, peer, polite, reset)
        this.links.set(peer.id, link)
        // Before the offer that follows the tracks: the peer rebuilds its side first.
        if (reset) link.send('reset', {})

        return link
    }

    disconnect(peer) {
        this.links.get(peer.id)?.close()
        this.links.delete(peer.id)
    }

    reset(peer) {
        // Both pages loaded at about the same time: each sent `reset` and an offer. The
        // lower seat keeps its fresh connection and offer, the higher seat answers it;
        // both going polite would leave nobody offering.
        const link = this.links.get(peer.id)
        if (link?.fresh && ! link.settled && this.client.seat < (peer.seat ?? Infinity)) {
            // Their page may have missed my offer (it claimed after I sent it): once more.
            if (link.pc.localDescription?.type === 'offer') link.send('offer', { sdp: link.pc.localDescription.sdp })
            return
        }

        this.connect(peer, { polite: true })
    }

    stale(peer, payload) {
        return this.links.get(peer.id)?.stale(payload) ?? false
    }

    signal(peer, type, payload) {
        return peer ? this.links.get(peer.id)?.signal(type, payload) : undefined
    }

    connected(peer) {
        return this.links.get(peer.id)?.connected ?? false
    }

    async replaceVideo(track) {
        for (const link of this.links.values()) await link.replaceVideo(track)
    }

    /** Media started on a call that had none (or more of it): every connection sends it too. */
    addTracks(source) {
        for (const link of this.links.values()) link.addTracks(source)
    }

    /** The open data channel with this label to a peer, or null. */
    channel(peer, label) {
        const channel = this.links.get(peer.id)?.channels.get(label)

        return channel?.readyState === 'open' ? channel : null
    }

    leave() {
        for (const link of this.links.values()) link.close()
        this.links.clear()
    }

    /** The connection to a peer, for tests and diagnostics. */
    link(peerId) {
        return this.links.get(String(peerId)) ?? null
    }
}

export class CallClient extends EventTarget {
    /**
     * @param {object} options
     * @param {HttpSignaling} options.signaling
     * @param {RTCIceServer[]|(() => Promise<RTCIceServer[]>|RTCIceServer[])} [options.iceServers]  or a function asked each time a call starts (short-lived TURN credentials), e.g. `() => signaling.configuration().then((c) => c.iceServers)`
     * @param {boolean} [options.video]  start calls with the camera on
     * @param {{ idle: number, active: number }} [options.poll]  milliseconds between polls
     * @param {number} [options.reconnectTimeout]  milliseconds to wait for the other side before giving up
     * @param {boolean} [options.resumes]  take over a call of mine that no window holds (false for a tab that leaves calls to a pop-out)
     * @param {number} [options.maxParticipants]  people on one call, me included; `callUser()` and `canInvite()` respect it (the server keeps the hard limit)
     * @param {object|((call: object, client: CallClient) => object)} [options.topology]  how media travels: a topology, or a function picking one per call from its `peers` (default: a MeshTopology)
     * @param {(constraints: MediaStreamConstraints) => Promise<MediaStream>} [options.getUserMedia]
     * @param {'all'|'relay'} [options.iceTransportPolicy]  `relay`: everything through TURN, nobody learns the other's addresses
     * @param {'video'|'audio'|'none'} [options.media]  what a call starts with (default: `video` per the `video` option); `none` connects without asking for the camera or the microphone, for a call that only needs data channels until `startMedia()`
     * @param {string[]} [options.channels]  data channels to open to every peer (ordered), surfaced by the `datachannel` event; channels pair by their place in this list, so every participant lists the same labels in the same order
     */
    constructor({ signaling, iceServers = [], video = true, poll = {}, reconnectTimeout = 15000, resumes = true, maxParticipants = 4, topology = null, getUserMedia, iceTransportPolicy = 'all', media = null, channels = [] } = {}) {
        super()
        this.signaling = signaling
        this.iceServersOption = iceServers
        this.iceServers = Array.isArray(iceServers) ? iceServers : []
        this.iceTransportPolicy = iceTransportPolicy === 'relay' ? 'relay' : 'all'
        this.video = video
        this.media = media ?? (video ? 'video' : 'audio')
        // What every call starts with; `startMedia()` raises `media` for the call it runs in.
        this.startingMedia = this.media
        this.channelLabels = [...channels]
        // Without a track or a channel nothing would ever start the connection.
        if (this.media === 'none' && ! this.channelLabels.length) throw new Error("media: 'none' needs at least one data channel in `channels`.")
        // `hidden`: how often a hidden tab with no call asks for incoming calls.
        this.pollIntervals = { idle: 5000, active: 1000, hidden: 15000, ...poll }
        this.reconnectTimeout = reconnectTimeout
        this.resumes = resumes
        this.maxParticipants = maxParticipants
        this.topologyOption = topology ?? (() => new MeshTopology())
        this.getUserMedia = getUserMedia || ((constraints) => navigator.mediaDevices.getUserMedia(constraints))

        this.tab = randomId()
        this.state = 'idle'
        this.call = null
        this.localStream = null
        this.cameraStream = null
        this.screenStream = null
        // The other participants, by user id; `peers` has them as plain objects.
        this.roster = new Map()
        // The topology of the current call, from `join()` until the call ends.
        this.topology = null
        // Whether this window runs the call (owns media and connections); a tab that only
        // shows a chip for a pop-out does not.
        this.joined = false
        this.cursor = 0
        this.buffered = []
        this.autoAnswer = null
        // Signals go out one after the other: a candidate posted alongside the offer
        // could land first, and the other side applies them by id.
        this.outbox = Promise.resolve()
        this.muted = false
        this.cameraOff = false
        this.timer = null
        this.dropTimer = null
        this.polling = false
        // Polls failed in a row; the next one waits longer (see `backoff()`).
        this.failures = 0
        this.inFlight = null
        this.takingOver = null
        // Bumped whenever this window lets go of a call: a poll sent before is not applied after.
        this.epoch = 0
        // Set while this window is about to run a call (answering, resuming): its polls hold the side.
        this.joining = false
        this.placing = null
        this.answering = null
        this.mediaRequest = null
        this.onVisibility = () => { if (! globalThis.document?.hidden) this.schedule(0) }
    }

    // ---- 1-on-1 conveniences ---------------------------------------------------

    /** The other participants, lowest seat first, as plain objects (see `peers` event). */
    get peers() {
        return [...this.roster.values()].sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)).map((peer) => peer.snapshot())
    }

    /** The one peer of a 1-on-1 call (the first one of a group). */
    get peer() {
        return this.roster.size ? this.peers[0] : null
    }

    get peerMuted() { return this.peer?.muted ?? false }
    get peerCameraOff() { return this.peer?.cameraOff ?? false }
    get peerSharing() { return this.peer?.sharing ?? false }
    get remoteStream() { return this.link?.stream ?? this.peer?.stream ?? null }

    /** The mesh connection of a 1-on-1 call (the first one of a group); null with another topology. */
    get link() {
        const links = this.topology?.links
        if (! links) return null
        const first = this.peer
        return (first && links.get(first.id)) ?? links.values().next().value ?? null
    }

    get pc() { return this.link?.pc ?? null }
    get session() { return this.link?.session ?? null }
    get peerSession() { return this.link?.peerSession ?? null }
    get polite() { return this.link?.polite ?? false }

    /** My seat: the caller has 0, everyone else the order they were invited in. */
    get seat() {
        return this.call?.seat ?? (this.call?.role === 'caller' ? 0 : 1)
    }

    // ---- lifecycle -----------------------------------------------------------

    /** Begin polling for incoming calls. */
    start() {
        if (this.polling) return
        this.polling = true
        globalThis.document?.addEventListener?.('visibilitychange', this.onVisibility)
        this.schedule(0)
    }

    stop() {
        this.polling = false
        clearTimeout(this.timer)
        globalThis.document?.removeEventListener?.('visibilitychange', this.onVisibility)
    }

    /**
     * Take everything down: stop polling, let go of the call for the next page
     * (the leave beacon) and close the connections and the camera, without events.
     */
    destroy() {
        this.stop()
        this.leave()
        this.epoch++
        this.topology?.leave()
        this.topology = null
        this.joined = false
        this.releaseMedia()
        clearTimeout(this.dropTimer)
        this.dropTimer = null
        this.call = null
        this.roster.clear()
        this.state = 'idle'
    }

    /**
     * Pick up a call of mine on this page: the one named (a pop-out opened for it,
     * answering it when `answer` is set), or whatever the server still has me in.
     */
    resumeCall(callId = null, { answer = false } = {}) {
        this.resumeId = callId
        if (answer) this.autoAnswer = callId
        this.start()
        this.schedule(0)
    }

    schedule(delay) {
        clearTimeout(this.timer)
        if (! this.polling) return
        this.timer = setTimeout(() => this.tick(), delay ?? this.interval())
    }

    /** Milliseconds to the next poll: fast while a call needs this window, slow in a hidden idle tab. */
    interval() {
        // A window about to run a call (answering, resuming) polls fast: those polls hold its side.
        const busy = this.isBusy()
        const hidden = ! busy && this.state === 'idle' && ! this.call && globalThis.document?.hidden === true

        return hidden ? this.pollIntervals.hidden : busy ? this.pollIntervals.active : this.pollIntervals.idle
    }

    isBusy() {
        return Boolean(this.joining || this.joined || (this.call && this.state !== 'elsewhere'))
    }

    /**
     * After failed polls (the server down, the network gone) the next one waits longer, doubling
     * each time: up to 5 seconds during a call (the polls are its heartbeat), a minute otherwise.
     */
    backoff() {
        const cap = this.isBusy() ? Math.max(5000, this.pollIntervals.active) : Math.max(60000, this.pollIntervals.idle)

        return Math.min(cap, this.interval() * 2 ** Math.min(this.failures, 10))
    }

    async tick() {
        if (this.inFlight) return
        const call = this.call?.id ?? this.resumeId ?? null
        // Only a window that runs (or is about to run) the call takes the side;
        // a tab showing the chip for a pop-out just watches.
        const hold = Boolean(this.joined || this.joining || this.resumeId)
        const epoch = this.epoch
        this.inFlight = this.signaling.poll({ after: this.cursor, call, tab: this.tab, hold })
            // Sent before this window hung up or declined: what it says is about a call that is gone here.
            .then((data) => {
                this.failures = 0
                return epoch === this.epoch ? this.handlePoll(data, call) : undefined
            })
            .catch((error) => {
                this.failures++
                this.emit('error', { error })
            })
            .finally(() => { this.inFlight = null; this.schedule(this.failures ? this.backoff() : undefined) })
        await this.inFlight
    }

    /** `asked` is the call id the poll named, so a call the server no longer returns is known to be gone. */
    async handlePoll({ call, incoming, signals = [], cursor }, asked = null) {
        if (typeof cursor === 'number' && cursor > this.cursor) this.cursor = cursor

        if (incoming && this.state === 'idle') {
            await this.ring(incoming)
        }

        if (call && this.call && call.id === this.call.id) {
            this.call = { ...this.call, ...call }
            this.emit('update', { call: this.call })

            if (call.status === 'ended') {
                this.finish(call.end_reason || 'hung_up')
                return
            }

            this.syncPeers(this.call)

            if (! this.joined && call.held) {
                // Another window of mine took it (the pop-out answered).
                this.setState('elsewhere')
            } else if (this.joined) {
                this.refreshState()
            }
        } else if (call && ! this.call && call.status !== 'ended') {
            this.resumeId = null

            if (this.ringsMe(call)) {
                // Named by this window (a pop-out opened to answer it): ring here.
                await this.ring(call)
            } else if (call.held || ! this.resumes) {
                this.call = call
                this.syncPeers(call)
                this.setState('elsewhere')
            } else {
                // Not awaited: the camera prompt may stay open for a while, and the polls
                // (this window's heartbeat) must go on meanwhile.
                this.resume(call)
            }
        } else if (! call && this.call && asked !== null && String(asked) === String(this.call.id)) {
            // The server no longer has me on it: hung up elsewhere, or, while it rang here,
            // missed (or declined on another device) while the call goes on for the others.
            this.finish(this.state === 'ringing' ? 'missed' : 'hung_up')
            return
        }

        for (const signal of signals) {
            if (! this.call || signal.call !== this.call.id) continue
            if (this.joined) await this.handleSignal(signal)
            else this.buffered.push(signal)
        }
    }

    /** A call I have not joined yet: it rings me (also one I am invited to mid-way). */
    ringsMe(call) {
        return call.status !== 'ended' && ! (call.joined ?? (call.role === 'caller' || call.status === 'active'))
    }

    async ring(call) {
        this.call = call
        this.syncPeers(call)
        this.setState('ringing')
        this.emit('incoming', { call })

        if (this.autoAnswer && String(this.autoAnswer) === String(call.id)) {
            this.autoAnswer = null
            // Not awaited, so the polls keep holding the side while the camera prompt is open.
            this.accept().catch(() => {})
        }
    }

    // ---- calling -------------------------------------------------------------

    /** Ring a user, or a group of them (an array). Resolves once the call is ringing on the server. */
    callUser(users) {
        // A second click while the first call is being set up gets the same call.
        this.placing ??= this.placeCall(users).finally(() => { this.placing = null })

        return this.placing
    }

    async placeCall(users) {
        const callees = Array.isArray(users) ? users : [users]
        if (callees.length + 1 > this.maxParticipants) {
            throw Object.assign(new Error(`A call takes up to ${this.maxParticipants} people.`), { full: true })
        }

        if (this.state !== 'idle') await this.hangUp()
        const epoch = this.epoch

        try {
            await this.acquireMedia()
        } catch (error) {
            this.emit('error', { error, media: true })
            throw error
        }

        await this.loadIceServers()

        // While the prompt was open, a call rang here (and may be being answered), or the window
        // let go of everything: ring nobody, and close the camera unless the answer uses it.
        if (epoch !== this.epoch || this.state !== 'idle') {
            if (! this.joined && ! this.answering) this.releaseMedia()
            throw new Error('The call was given up.')
        }

        let call
        try {
            call = await this.signaling.start(users, this.tab)
        } catch (error) {
            this.releaseMedia()
            // Someone on another call: the call ends before it rang, as `busy`.
            if (error?.reason === 'busy') this.emit('ended', { call: null, reason: 'busy', error })
            else this.emit('error', { error })
            throw error
        }

        if (epoch !== this.epoch || this.state !== 'idle') {
            // Something else took this window meanwhile (an incoming call is ringing or was answered): give the new call up.
            this.signaling.hangup(call.id).catch(() => {})
            if (! this.joined && ! this.answering) this.releaseMedia()
            throw new Error('The call was given up.')
        }

        this.setState('calling')
        this.join(call)
        this.schedule(0)

        return this.call
    }

    /** Accept the call that is ringing. */
    accept() {
        // A double click on Accept answers once.
        this.answering ??= this.answerCall().finally(() => { this.answering = null })

        return this.answering
    }

    async answerCall() {
        if (this.state !== 'ringing' || ! this.call) return
        const epoch = this.epoch
        const callId = this.call.id
        this.joining = true

        try {
            await this.acquireMedia()
        } catch (error) {
            this.joining = false
            this.emit('error', { error, media: true })
            await this.decline()
            throw error
        }

        await this.loadIceServers()

        // The caller gave up (or the call was declined elsewhere) while the prompt was open.
        if (epoch !== this.epoch || this.call?.id !== callId) {
            this.joining = false
            // The camera stays when a call placed meanwhile is about to use it.
            if (! this.call && ! this.placing) this.releaseMedia()
            return
        }

        let call
        try {
            call = await this.signaling.answer(callId, this.tab)
        } catch (error) {
            this.joining = false
            if (epoch !== this.epoch) return
            this.releaseMedia()
            const call = this.call
            this.reset()
            // No longer ringing (cancelled, or answered on another device): an ending, not an error.
            if (error?.reason === 'not_ringing') this.emit('ended', { call, reason: 'missed' })
            else this.emit('error', { error })
            return
        }

        this.joining = false
        if (epoch !== this.epoch) return

        this.setState('connecting')
        this.join(call)

        const buffered = this.buffered.splice(0)
        for (const signal of buffered) await this.handleSignal(signal)

        this.schedule(0)
    }

    /**
     * Add someone to my call. Resolves to the call once they are ringing. Needs a
     * backend with `invite`, and room under `maxParticipants`. Also from a window
     * that only watches the call (a main tab while the pop-out runs it): the
     * window that holds the call connects to the newcomer on its next poll.
     */
    async invite(userId) {
        if (! this.call || ! (this.call.joined ?? true) || this.state === 'ringing') throw new Error('Not in a call.')
        if (! this.signaling.invite) throw new Error('This signaling backend cannot add people to a call.')
        if (! this.canInvite()) throw Object.assign(new Error(`A call takes up to ${this.maxParticipants} people.`), { full: true })

        let call
        try {
            call = await this.signaling.invite(this.call.id, userId)
        } catch (error) {
            this.emit('error', { error })
            throw error
        }

        if (! this.call || this.call.id !== call.id) return call

        this.call = { ...this.call, ...call }
        this.emit('update', { call: this.call })
        this.syncPeers(this.call)
        this.schedule(0)

        return this.call
    }

    /** Whether one more person fits: in a call (here or in my pop-out), with a backend that invites, under `maxParticipants`. */
    canInvite() {
        const inCall = Boolean(this.call) && (this.call.joined ?? true) && this.state !== 'ringing' && this.call.status !== 'ended'

        return inCall && Boolean(this.signaling.invite) && this.roster.size + 1 < this.maxParticipants
    }

    /** This window steps back: another window (a pop-out) answers or continues the call. */
    handOff() {
        if (! this.call) return
        this.buffered = []
        this.setState('elsewhere')
    }

    /**
     * Continue a call the server still has me in, from a fresh page: new
     * connections, `reset` to every peer, then new offers.
     */
    async resume(call) {
        this.call = call
        const epoch = this.epoch
        this.joining = true

        try {
            await this.resumeCallOn(call, epoch)
        } finally {
            this.joining = false
        }
    }

    async resumeCallOn(call, epoch) {
        // Take the side first: the answers to the offers sent below only reach the
        // window that holds it, and a claim moves the cursor past the old signals.
        try {
            const claim = await this.signaling.poll({ after: this.cursor, call: call.id, tab: this.tab, hold: true })
            if (epoch !== this.epoch) return
            if (typeof claim.cursor === 'number' && claim.cursor > this.cursor) this.cursor = claim.cursor
            if (! claim.call || claim.call.status === 'ended') return this.finish(claim.call?.end_reason || 'hung_up')
            call = { ...call, ...claim.call }
            if (call.held) {
                this.call = call
                this.syncPeers(call)
                this.setState('elsewhere')
                return
            }
        } catch (error) {
            this.emit('error', { error })
            this.call = null
            return
        }

        try {
            await this.acquireMedia()
        } catch (error) {
            this.emit('error', { error, media: true })
            await this.hangUp('failed')
            return
        }

        await this.loadIceServers()
        // The call ended, or another window of mine took it, while the prompt was open.
        if (epoch !== this.epoch || this.call?.id !== call.id || this.call?.held) {
            if (! this.joined) this.releaseMedia()
            return
        }

        this.setState(call.status === 'ringing' ? 'calling' : 'connecting')
        this.join(call, { fresh: true })
        this.schedule(0)
    }

    async decline() {
        if (! this.call) return
        const call = this.call
        this.reset()
        await this.signaling.decline(call.id).catch(() => {})
        this.emit('ended', { call, reason: 'declined' })
    }

    async hangUp(reason = 'hung_up') {
        if (! this.call) return
        const call = this.call
        this.reset()
        await this.signaling.hangup(call.id).catch(() => {})
        this.emit('ended', { call, reason })
    }

    /** The page is going away: let go of the call so the next page can pick it up. */
    leave() {
        if (this.call && this.joined) this.signaling.leave?.(this.call.id, this.tab)
    }

    /**
     * This window continues a call of mine that no window holds any more (the
     * pop-out closed): a call still ringing me rings here again, a running one is
     * resumed here. Resolves to whether this window has the call now; false while
     * another window still holds it (the claim on the server decides, so a pop-out
     * that is merely reloading keeps its side).
     */
    takeOver() {
        // Asked again while the first take-over runs (its own updates can ask): the same answer.
        this.takingOver ??= this.doTakeOver().finally(() => { this.takingOver = null })

        return this.takingOver
    }

    async doTakeOver() {
        if (this.state !== 'elsewhere' || ! this.call || this.joined) return false

        // What this window knows may be seconds old (a pop-out answers and claims the call
        // right after it opens): a look at the server first, without claiming anything.
        let fresh
        try {
            fresh = await this.signaling.poll({ after: this.cursor, call: this.call.id, tab: this.tab })
        } catch (error) {
            this.emit('error', { error })
            return false
        }

        if (! this.call || this.state !== 'elsewhere') return false

        if (! fresh.call || fresh.call.status === 'ended') {
            this.finish(fresh.call?.end_reason || 'hung_up')
            return false
        }

        this.call = { ...this.call, ...fresh.call }
        this.emit('update', { call: this.call })
        this.syncPeers(this.call)
        if (this.call.held) return false

        const call = this.call

        if (this.ringsMe(call)) {
            this.setState('ringing')
            this.emit('incoming', { call })

            return true
        }

        await this.resume(call)

        return this.call !== null && this.state !== 'elsewhere'
    }

    // ---- the roster ----------------------------------------------------------

    /** The peers as the server lists them; a 1-on-1 backend only names the one. */
    peersOf(call) {
        if (Array.isArray(call.peers)) {
            return call.peers.map((entry, index) => ({ ...entry, seat: entry.seat ?? (call.role === 'caller' ? index + 1 : index) }))
        }

        if (! call.peer) return []

        return [{
            ...call.peer,
            seat: call.role === 'caller' ? 1 : 0,
            status: call.role === 'callee' || call.status === 'active' ? 'joined' : 'ringing',
            held: call.peer_held,
            seen_ago: call.peer_seen_ago,
        }]
    }

    /**
     * Bring the roster in line with the call: new peers get a connection (once I am
     * in), peers who left or declined lose theirs.
     */
    syncPeers(call) {
        const listed = this.peersOf(call)
        const seen = new Set()
        let changed = false

        for (const entry of listed) {
            const id = String(entry.id)
            seen.add(id)
            const gone = ! ['ringing', 'joined'].includes(entry.status ?? 'joined')
            let peer = this.roster.get(id)

            // Invited again at a new seat (they left and this window did not see it in between):
            // their old connection is dead, and the new seat decides anew who offers.
            if (peer && ! gone && entry.seat != null && peer.seat !== null && entry.seat !== peer.seat) {
                this.dropPeer(peer, 'left')
                peer = undefined
            }

            if (! peer) {
                if (gone) continue
                peer = new Peer(id)
                peer.update(entry)
                this.roster.set(id, peer)
                changed = true
                if (this.joined) this.topology.connect(peer, { polite: peer.seat < this.seat })
                if (peer.status === 'joined') this.emit('peerjoined', { peer: peer.snapshot() })
                continue
            }

            const wasJoined = peer.status === 'joined'
            if (peer.update(entry)) changed = true

            if (gone) {
                this.dropPeer(peer, entry.status)
                changed = true
            } else if (! wasJoined && peer.status === 'joined') {
                this.emit('peerjoined', { peer: peer.snapshot() })
            }
        }

        for (const peer of this.roster.values()) {
            if (seen.has(peer.id)) continue
            this.dropPeer(peer, 'left')
            changed = true
        }

        if (changed) this.emit('peers', { peers: this.peers })
    }

    dropPeer(peer, reason) {
        this.topology?.disconnect(peer)
        this.roster.delete(peer.id)
        this.emit('peerleft', { peer: peer.snapshot(), reason })
    }

    /**
     * I am in the call: pick the topology and connect to everyone on the roster.
     * `fresh` after a page load: I offer to everyone and tell them to start over.
     */
    join(call, { fresh = false } = {}) {
        this.call = call
        this.topology?.leave()
        // Connected once, below: syncPeers() would connect the new peers too while `joined` still says the old call.
        this.joined = false
        this.topology = this.topologyFor(call)
        this.topology.attach(this)
        this.topology.join?.(call)
        this.syncPeers(call)
        this.joined = true

        for (const peer of this.roster.values()) {
            this.topology.connect(peer, fresh ? { polite: false, reset: true } : { polite: peer.seat < this.seat })
        }
    }

    topologyFor(call) {
        const option = this.topologyOption
        if (typeof option !== 'function') return option
        // A class was passed rather than an instance or a factory.
        if (typeof option.prototype?.connect === 'function') return new option()

        return option(call, this)
    }

    // ---- media controls ------------------------------------------------------

    setMuted(muted) {
        this.muted = muted
        this.cameraStream?.getAudioTracks().forEach((track) => { track.enabled = ! muted })
        this.announceState()
    }

    setCameraOff(off) {
        this.cameraOff = off
        this.cameraStream?.getVideoTracks().forEach((track) => { track.enabled = ! off })
        this.announceState()
    }

    /**
     * Tell the others about my mute, camera and screen share, once there is a
     * connection to tell it over. A change goes to everyone; the announcement
     * after a negotiation only to that peer, and only when something is on, since
     * a fresh connection starts with everything off on both sides.
     */
    announceState(changed = true, peer = null) {
        if (! this.joined || ! this.call) return
        if (! changed && ! this.muted && ! this.cameraOff && ! this.sharing) return

        this.send('state', { muted: this.muted, cameraOff: this.cameraOff, sharing: this.sharing }, peer?.id ?? null)
    }

    get sharing() {
        return this.screenStream !== null
    }

    async shareScreen() {
        if (! this.joined || this.screenStream) return

        const callId = this.call?.id
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })

        // The call ended (or another began) while the picker was open: share nothing.
        if (! this.joined || this.call?.id !== callId || this.screenStream) {
            screen.getTracks().forEach((track) => track.stop())
            return
        }

        const track = screen.getVideoTracks()[0]
        track.addEventListener('ended', () => this.stopSharing())
        this.screenStream = screen

        this.publishLocal()
        await this.topology.replaceVideo?.(track)
        this.announceState()
    }

    async stopSharing() {
        if (! this.screenStream) return

        this.screenStream.getTracks().forEach((track) => track.stop())
        this.screenStream = null

        this.publishLocal()
        await this.topology?.replaceVideo?.(this.cameraStream?.getVideoTracks()[0] ?? null)
        this.announceState()
    }

    /**
     * Turn on media during a call that started with less (`media: 'none'`, or a voice
     * call going to video): asks for the microphone (and the camera for `video`) and
     * sends the tracks to every peer, which renegotiates each connection.
     *
     * @param {'audio'|'video'} kind
     */
    async startMedia(kind = 'audio') {
        const order = ['none', 'audio', 'video']
        if (order.indexOf(kind) <= order.indexOf(this.media) && this.cameraStream) return this.cameraStream

        const previous = this.cameraStream
        const previousMedia = this.media
        const epoch = this.epoch
        this.media = kind
        this.cameraStream = null

        let stream
        try {
            stream = await this.acquireMedia()
        } catch (error) {
            // Nothing changed: the next startMedia() asks again.
            if (epoch === this.epoch) {
                this.cameraStream = previous
                this.media = previousMedia
            }
            this.emit('error', { error, media: true })
            throw error
        }

        // The call ended (or the window was taken down) while the prompt was open: the
        // camera and microphone go off again instead of staying on with no call.
        if (epoch !== this.epoch) {
            stream?.getTracks().forEach((track) => track.stop())
            if (this.cameraStream === stream) this.cameraStream = null
            if (! this.joined) this.releaseMedia()
            throw new Error('The call was given up.')
        }

        // The tracks asked for before (a microphone going to video) are replaced, not doubled.
        previous?.getTracks().forEach((track) => track.stop())
        if (this.joined) this.topology?.addTracks?.(this.localSource())

        return stream
    }

    /** The open data channel with this label to a peer (the first peer by default), or null. */
    channel(label, peerId = null) {
        const peer = peerId === null ? this.peer : this.roster.get(String(peerId))

        return peer ? this.topology?.channel?.(peer, label) ?? null : null
    }

    // ---- what a topology uses --------------------------------------------------

    /** The stream whose tracks go to the peers: the camera, or the screen in place of its video. */
    localSource() {
        return this.screenStream ? this.localStream : this.cameraStream
    }

    /** Queue a signal, after every signal queued before it: to one participant, or to all (`to` null). */
    send(type, payload, to = null) {
        const call = this.call
        if (! call) return

        this.outbox = this.outbox
            .then(() => this.signaling.send(call.id, type, payload, to))
            // 410: the call ended while this was queued (a last candidate after the hang-up).
            .catch((error) => { if (error?.status !== 410) this.emit('error', { error }) })
    }

    remoteStreamFrom(peer, stream) {
        peer.stream = stream
        this.emit('remotestream', { stream, peer: peer.snapshot() })
        this.emit('peers', { peers: this.peers })
    }

    connectionChanged(peer, connected) {
        peer.connected = connected
        this.refreshState()
        this.emit('peers', { peers: this.peers })
    }

    /** A connection to a peer is negotiated: a group is connecting, and the peer learns what I have on. */
    negotiated(peer) {
        if (this.state === 'calling') this.setState('connecting')
        this.announceState(false, peer)
    }

    // ---- internals -----------------------------------------------------------

    /** The ICE servers for the call about to start, when they come from a function; the last ones stay on failure. */
    async loadIceServers() {
        const option = this.iceServersOption
        if (Array.isArray(option) || ! option) return

        try {
            const servers = typeof option === 'function' ? await option() : null
            if (Array.isArray(servers)) this.iceServers = servers
        } catch (error) {
            this.emit('error', { error })
        }
    }

    acquireMedia() {
        if (this.cameraStream || this.media === 'none') return Promise.resolve(this.cameraStream)

        // Asked twice at once (a double click): one prompt, one stream.
        this.mediaRequest ??= this.requestMedia().finally(() => { this.mediaRequest = null })

        return this.mediaRequest
    }

    async requestMedia() {
        const video = this.media === 'video'
        let stream
        try {
            stream = await this.getUserMedia({ audio: true, video })
        } catch (error) {
            // No camera, or it is busy: fall back to a voice call rather than fail.
            if (! video || ! ['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(error.name)) throw error
            stream = await this.getUserMedia({ audio: true, video: false })
        }

        this.cameraStream = stream
        this.setMuted(this.muted)
        this.setCameraOff(this.cameraOff)
        this.publishLocal()

        return stream
    }

    /** The stream shown as "you": the camera, with the screen in place of the video while sharing. */
    publishLocal() {
        const tracks = [
            ...(this.cameraStream?.getAudioTracks() ?? []),
            ...(this.screenStream ? this.screenStream.getVideoTracks() : (this.cameraStream?.getVideoTracks() ?? [])),
        ]
        this.localStream = new MediaStream(tracks)
        this.emit('localstream', { stream: this.localStream })
    }

    releaseMedia() {
        this.cameraStream?.getTracks().forEach((track) => track.stop())
        this.screenStream?.getTracks().forEach((track) => track.stop())
        this.cameraStream = this.screenStream = this.localStream = null
    }

    /**
     * active while at least one peer's media flows and their window is alive;
     * reconnecting otherwise, and dropped after the timeout.
     */
    refreshState() {
        if (! this.joined || ! this.call || this.call.status !== 'active') return

        const connected = [...this.roster.values()].some((peer) => peer.status === 'joined' && peer.alive && this.topology.connected(peer))

        if (connected) {
            clearTimeout(this.dropTimer)
            this.dropTimer = null
            this.setState('active')
        } else if (this.state === 'active' || this.state === 'reconnecting' || this.state === 'connecting') {
            this.setState('reconnecting')
            this.dropTimer ??= setTimeout(() => {
                if (this.state === 'reconnecting') this.hangUp('dropped')
            }, this.reconnectTimeout)
        }
    }

    async handleSignal({ type, payload = {}, from }) {
        if (! this.joined || ! this.topology) return

        // A 1-on-1 backend names no sender: the one peer it is.
        const senderId = from ?? this.call?.peer?.id ?? null
        const peer = senderId === null ? null : this.roster.get(String(senderId)) ?? null

        if (type === 'reset') {
            if (! peer) return
            // The peer is back on a fresh page: a new connection for its new offer, and
            // everything off there until it says otherwise.
            this.topology.reset?.(peer, payload)
            peer.connected = false
            // Their old media ended with their old page: no frozen picture until the new one arrives.
            if (peer.stream && peer.stream !== this.topology.link?.(peer.id)?.stream) peer.stream = null
            if (this.roster.size === 1 && (this.state === 'active' || this.state === 'reconnecting')) this.setState('connecting')
            if (peer.muted || peer.cameraOff || peer.sharing) {
                peer.muted = peer.cameraOff = peer.sharing = false
                this.emit('peerstate', { peer: peer.snapshot(), muted: false, cameraOff: false, sharing: false })
            }
            this.refreshState()
            this.emit('peers', { peers: this.peers })
            return
        }

        if (type === 'state') {
            if (! peer || this.topology.stale?.(peer, payload)) return
            peer.muted = Boolean(payload.muted)
            peer.cameraOff = Boolean(payload.cameraOff)
            peer.sharing = Boolean(payload.sharing)
            this.emit('peerstate', { peer: peer.snapshot(), muted: peer.muted, cameraOff: peer.cameraOff, sharing: peer.sharing })
            this.emit('peers', { peers: this.peers })
            return
        }

        await this.topology.signal(peer, type, payload, from)
    }

    finish(reason) {
        const call = this.call
        this.reset()
        this.emit('ended', { call, reason })
    }

    reset() {
        this.epoch++
        this.topology?.leave()
        this.topology = null
        this.joined = false
        this.releaseMedia()
        clearTimeout(this.dropTimer)
        this.dropTimer = null
        this.call = null
        this.roster.clear()
        this.buffered = []
        this.resumeId = null
        this.media = this.startingMedia
        this.setState('idle')
    }

    setState(state) {
        if (this.state === state) return
        this.state = state
        this.emit('statechange', { state })
        this.schedule(0)
    }

    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }))
    }
}
