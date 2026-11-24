/**
 * @packstub/holler — WebRTC calls for the browser, 1-on-1 and small groups, with a
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
 *   hold(callId)                      → call     (optional; I step out of a running call without leaving it)
 *   resume(callId, tab)               → call     (optional; back into the call I put on hold, the call I am in going on hold instead)
 *   people(query, callId)             → { people: [{ id, name, avatar }] }   (optional; who can be rung, or added to that call)
 *   send(callId, type, payload, to)   → void     (offer | answer | ice | reset | state; `to` a user id, null for every other participant)
 *   poll({ after, call, tab, claim, kind }) → { call, incoming, on_hold, signals, cursor }   (claim: this window wants my side; kind: only calls of that kind;
 *                                                on_hold: the call I put on hold, if any. The poll parameter `claim` is about windows, not about that.)
 *   leave(callId, tab)                → void     (optional; a beacon as the page unloads)
 *   attach(client) / detach(client)   → void     (optional; the CallClient the adapter was given to, for one that works
 *                                                with the call itself or is pushed to: see `deliver()` and RelaySignaling)
 *
 * A failed request rejects with an Error carrying `status` (HTTP) and `reason` (`busy`, `not_ringing`,
 * `not_allowed`, `full`, `ended`, `too_large` from the Laravel backend).
 *
 * A `call` is { id, kind, status: ringing|active|ended, end_reason, role: caller|callee, seat, joined, on_hold,
 * peers: [{ id, name, avatar, seat, status: ringing|joined|on_hold|left|declined|missed|dropped, claimed, seen_ago }],
 * claimed_elsewhere, answered_at }, plus `peer`, `peer_claimed` and `peer_seen_ago` for the first peer.
 * Those three are all a 1-on-1 backend needs to send: without `peers`, `seat` and
 * `joined` the client derives them (the caller has seat 0, the callee seat 1).
 * `seat` is the order people were invited in; between two participants the lower
 * seat makes the offer. `joined` is whether I am in (false while the call rings me).
 * `claimed_elsewhere` means another window of mine (a pop-out) has claimed my side
 * of this call; a peer's `claimed` that it has a live window on the call. `on_hold`:
 * the person stepped out of the call (`hold()`) and is still on it, with no window
 * and no media until they resume. A call of mine that is on hold is no window's
 * call; every window of mine learns of it from the poll (`heldCall`).
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
 *   statechange { state }   idle | calling | ringing | connecting | active | reconnecting | waiting | elsewhere
 *                           (`waiting`: everyone else in the call put it on hold)
 *   incoming    { call }    someone is ringing you
 *   update      { call }    the call's server state changed (claimed elsewhere, status, peers…)
 *   localstream { stream }  your camera/mic (or screen) stream, also after a share switch
 *   remotestream{ stream, peer }  a peer's media (fires again as tracks arrive)
 *   peers       { peers }   the roster changed: someone joined, left, connected, muted…
 *   peerjoined  { peer }    a peer is in the call
 *   peerleft    { peer, reason }  a peer is gone (left | declined | missed | dropped)
 *   peerheld    { peer, onHold }  a peer put the call on hold, or is back
 *   held        { call }    the call I have on hold changed: put on hold, resumed, or ended meanwhile (null)
 *   peerstate   { peer, muted, cameraOff, sharing }  a peer muted, turned the camera off or shares the screen
 *   quality     { peer, quality, rtt, loss, jitter, relayed }  how the connection to a peer is doing changed: good | fair | poor
 *   devices     { selected }  a microphone, camera or speaker was chosen, or one was plugged in or out (ask `devices()` again)
 *   datachannel { peer, channel, label }  a data channel to a peer is open (see the `channels` option)
 *   ended       { call, reason }  declined | cancelled | missed | hung_up | failed | dropped | busy | signed_out
 *                           (`failed`: the browsers never found a path to each other; `dropped`: they had one and lost it;
 *                           `signed_out`: the server answered a poll with 401 or 419, the session is gone)
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

// A device that is missing, busy or no longer matches: worth another try with less.
const DEVICE_ERRORS = ['NotFoundError', 'NotReadableError', 'OverconstrainedError']

/**
 * A connection in a word, from the round trip in milliseconds and the share of packets
 * lost since the last look: `poor` from 8% lost or 600 ms, `fair` from 3% or 300 ms.
 *
 * @param {{ rtt?: number|null, loss?: number|null }} stats
 * @returns {'good'|'fair'|'poor'}
 */
export function rateConnection({ rtt = null, loss = null } = {}) {
    if ((loss ?? 0) >= 0.08 || (rtt ?? 0) >= 600) return 'poor'
    if ((loss ?? 0) >= 0.03 || (rtt ?? 0) >= 300) return 'fair'

    return 'good'
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

// A backend may trim the description (Laravel's TrimStrings middleware does); the
// parser wants every line, the last one included, to end in CRLF.
const sdp = (text) => text.endsWith('\r\n') ? text : `${text.replace(/\r?\n$/, '')}\r\n`

export class HttpSignaling {
    /**
     * @param {object} options
     * @param {{ poll: string, store: string, answer: string, decline: string, hangup: string, signal: string, leave?: string, invite?: string, hold?: string, resume?: string, people?: string, ice?: string }} options.routes
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
        if (! routes?.hold || ! routes?.resume) this.hold = this.resume = undefined
        if (! routes?.people) this.people = undefined
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
    hold(callId) { return this.request('POST', this.url('hold', callId)) }
    resume(callId, tab = null) { return this.request('POST', this.url('resume', callId), { tab }) }

    /** Who can be rung, or added to a call (`callId`), for what was typed: `{ people: [{ id, name, avatar }] }`. */
    people(query = '', callId = null) {
        const params = new URLSearchParams({ q: String(query) })
        if (callId) params.set('call', String(callId))

        return this.request('GET', `${this.routes.people}${this.routes.people.includes('?') ? '&' : '?'}${params}`)
    }

    send(callId, type, payload, to = null) {
        return this.request('POST', this.url('signal', callId), to === null || to === undefined ? { type, payload } : { type, payload, to })
    }

    poll({ after = 0, call = null, tab = null, claim = false, kind = this.kind, relay = false, present = null } = {}) {
        const query = new URLSearchParams({ after: String(after) })
        if (call) query.set('call', String(call))
        if (tab) query.set('tab', tab)
        if (claim) query.set('claim', '1')
        if (kind) query.set('kind', kind)
        // From RelaySignaling: this window can take signaling over a data channel, and (the hub) who is connected to it.
        if (relay) query.set('relay', '1')
        if (present?.length) query.set('present', present.join(','))

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

// The data channel RelaySignaling talks over, one to every peer.
const RELAY_CHANNEL = 'holler:relay'

/**
 * Signaling over the call's own data channels, so that one browser polls instead of
 * all of them. It wraps another signaling adapter (`HttpSignaling`, say) and has the
 * same interface:
 *
 *   - One participant is the hub: the backend says who (`hub: true` on the call for
 *     me, on a peer for them). The hub keeps polling. With each poll it tells the
 *     backend who is connected to it (`present`), which keeps their side alive there,
 *     and gets back what each of them would have been answered (`relay.views`), which
 *     it passes on over the channel.
 *   - Everyone with an open channel to the hub stops polling (`mode` is `quiet`) and
 *     lives off what the hub passes on.
 *   - A signal goes straight to a peer I have a channel to; through the hub to a peer
 *     the hub has one to (a newcomer I am not connected to yet); and over the backend
 *     otherwise. Signals for a peer that relays too, and is on its way to the hub, wait
 *     up to `patience` for it.
 *   - Without a hub, or when the channel to it closes or goes silent for `hubTimeout`,
 *     this is the wrapped adapter and nothing else: every poll goes to the backend.
 *
 * The hub sees and could change the signals it relays (SDP, ICE candidates), the way
 * the signaling server can; the media stays encrypted between the browsers.
 *
 * What goes over the channel (JSON): `{ t: 'signal', type, payload, to? | from? }`,
 * `{ t: 'undelivered', to, type, payload }`, and from the hub `{ t: 'view', data, reach }`,
 * `{ t: 'ping', reach }` and `{ t: 'poll' }` (signals wait on the backend: ask it once).
 *
 * Events: `modechange { mode }`, mode being `polling`, `quiet` or `hub`.
 */
export class RelaySignaling extends EventTarget {
    /**
     * @param {object} upstream  the signaling adapter that reaches the backend
     * @param {object} [options]
     * @param {string} [options.channel]  the label of the data channel (the same for everyone on the call)
     * @param {number} [options.patience]  milliseconds a signal waits for its peer to reach the hub before it goes over the backend
     * @param {number} [options.hubTimeout]  milliseconds the hub may be silent before this window polls again; more than twice the hub's slowest poll
     * @param {number} [options.maxMessage]  characters a signal may have to go over a channel; a larger one goes over the backend
     */
    constructor(upstream, { channel = RELAY_CHANNEL, patience = 10000, hubTimeout = 10000, maxMessage = 60000 } = {}) {
        super()
        this.upstream = upstream
        this.label = channel
        this.patience = patience
        this.hubTimeout = hubTimeout
        this.maxMessage = maxMessage
        this.client = null
        // Requests to the backend, and what the channels spared: for whoever counts.
        this.stats = { polls: 0, spared: 0, posts: 0, direct: 0, viaHub: 0, relayed: 0 }
        // The open channel to each peer, by user id.
        this.channels = new Map()
        this.mode = 'polling'
        this.forget()

        for (const name of ['invite', 'hold', 'resume', 'people', 'configuration', 'leave']) {
            if (typeof upstream?.[name] !== 'function') this[name] = undefined
        }

        this.onChannel = ({ detail: { peer, channel: opened, label } }) => { if (label === this.label) this.opened(String(peer.id), opened) }
        // The connection to the hub went down before its channel said so.
        this.onPeers = () => { if (this.quiet && ! this.hubConnected()) this.wake() }
    }

    // ---- what CallClient calls -------------------------------------------------

    attach(client) {
        this.client = client
        // The last of the channels, so the ones the app lists keep their place (channels pair up by it).
        if (! client.channelLabels.includes(this.label)) client.channelLabels.push(this.label)
        client.addEventListener('datachannel', this.onChannel)
        client.addEventListener('peers', this.onPeers)
    }

    detach(client) {
        client.removeEventListener('datachannel', this.onChannel)
        client.removeEventListener('peers', this.onPeers)
        this.forget()
        this.channels.clear()
        this.client = null
    }

    start(callees, tab) { return this.upstream.start(callees, tab) }
    answer(callId, tab) { return this.upstream.answer(callId, tab) }
    invite(callId, userId) { return this.upstream.invite(callId, userId) }
    resume(callId, tab = null) { return this.upstream.resume(callId, tab) }
    people(query = '', callId = null) { return this.upstream.people(query, callId) }
    configuration() { return this.upstream.configuration() }
    leave(callId, tab) { return this.upstream.leave(callId, tab) }

    decline(callId) { return this.letGo(callId, () => this.upstream.decline(callId)) }
    hangup(callId) { return this.letGo(callId, () => this.upstream.hangup(callId)) }
    hold(callId) { return this.letGo(callId, () => this.upstream.hold(callId)) }

    /** The backend's answer, or, while the hub passes it on, what the hub last passed on. */
    async poll(params = {}) {
        const callId = params.call ?? null

        if (this.canRest(params)) {
            this.setMode('quiet')
            this.stats.spared++

            return { incoming: null, on_hold: null, ...this.told, signals: [], cursor: params.after ?? 0 }
        }

        if (this.quiet) this.setMode('polling')
        this.owed = false
        const present = this.isHub ? this.present() : []
        this.stats.polls++

        let data
        try {
            data = await this.upstream.poll({ ...params, relay: true, ...(present.length ? { present } : {}) })
        } catch (error) {
            // The backend is away, the hub is not: the others would only fail to reach it too.
            if (this.isHub) this.broadcast({ t: 'ping', reach: this.reachable() })
            throw error
        }

        // Signals came over the backend: more may follow, and the next poll tells it these were read.
        this.owed = (data?.signals?.length ?? 0) > 0
        const wasHub = this.isHub
        this.observe(data?.call ?? null, callId)
        // Whoever reached me over the backend is answered that way, until a channel reaches them.
        for (const signal of data?.signals ?? []) {
            const from = signal.from === undefined || signal.from === null ? null : String(signal.from)
            if (from !== null && this.way(from) === 'wait') this.impatient.add(from)
        }
        this.release()
        // Also the last answer of a call that just ended: the others hear it from the hub.
        if (this.isHub || (wasHub && data?.relay)) this.pass(data?.relay ?? null)
        this.setMode(this.isHub ? 'hub' : 'polling')

        return data
    }

    /** To one participant, or to everyone else on the call (`to` null), each by the shortest way there is. */
    send(callId, type, payload, to = null) {
        if (! this.view || String(this.view.id) !== String(callId)) return this.post(callId, type, payload, to)

        const everyone = to === null || to === undefined
        const targets = everyone
            ? (this.view.peers ?? []).filter((peer) => peer.status === 'joined' || peer.status === 'ringing').map((peer) => String(peer.id))
            : [String(to)]
        // Nobody within reach of a channel: one request to the backend, as without relaying.
        if (everyone && targets.every((target) => this.way(target) === 'backend')) return this.post(callId, type, payload, null)

        return Promise.all(targets.map((target) => this.dispatch({ callId, type, payload, to: target })))
    }

    // ---- state -----------------------------------------------------------------

    get quiet() { return this.mode === 'quiet' }

    setMode(mode) {
        if (this.mode === mode) return
        this.mode = mode
        this.dispatchEvent(new CustomEvent('modechange', { detail: { mode } }))
    }

    /** Nothing of a call is left here: the next one starts from the backend. */
    forget() {
        for (const waiting of this.held?.values() ?? []) clearTimeout(waiting.timer)
        // The call as the backend (or the hub) last described it.
        this.view = null
        this.isHub = false
        this.hubId = null
        // Who the hub has a channel to, as the hub says.
        this.reach = new Set()
        // What the hub last passed on for me, in the shape of a poll's answer; null until it does.
        this.told = null
        this.heard = 0
        // The backend has something for me that the channels do not carry: one poll goes there.
        this.owed = false
        // Signals waiting for their peer to reach the hub, by peer; and the peers no signal waits for any more.
        this.held = new Map()
        this.impatient = new Set()
        if (this.mode !== 'polling') this.setMode('polling')
    }

    letGo(callId, request) {
        if (this.view && String(this.view.id) === String(callId)) this.forget()

        return request()
    }

    /** Take the call as it is now: who the hub is, and whether that is me. */
    observe(call, asked = null) {
        if (! call || call.status === 'ended') {
            if (this.view && (asked === null || String(asked) === String(this.view.id))) this.forget()
            return
        }

        if (this.view && String(this.view.id) !== String(call.id)) this.forget()

        const hub = (call.peers ?? []).find((peer) => peer.hub === true && peer.status === 'joined')
        const hubId = hub ? String(hub.id) : null
        if (hubId !== this.hubId) {
            this.reach = new Set()
            this.told = null
        }
        this.view = call
        this.isHub = call.hub === true
        this.hubId = this.isHub ? null : hubId

        // Signals kept for someone who left go nowhere.
        const live = new Set((call.peers ?? []).filter((peer) => peer.status === 'joined' || peer.status === 'ringing').map((peer) => String(peer.id)))
        for (const [id, waiting] of this.held) {
            if (live.has(id)) continue
            clearTimeout(waiting.timer)
            this.held.delete(id)
        }
        for (const id of this.impatient) if (! live.has(id)) this.impatient.delete(id)
        this.release()
    }

    /** Whether this poll can be answered from what the hub passed on. */
    canRest({ call = null, claim = false } = {}) {
        return ! this.isHub && ! this.owed && claim && this.told !== null && this.view !== null && call !== null
            && String(call) === String(this.view.id) && this.hubId !== null && this.open(this.hubId)
            && Date.now() - this.heard <= this.hubTimeout && this.hubConnected()
    }

    hubConnected() {
        return this.hubId !== null && this.connected(this.hubId)
    }

    connected(id) {
        return this.client?.peers.find((peer) => peer.id === id)?.connected === true
    }

    open(id) {
        return this.channels.get(id)?.readyState === 'open'
    }

    /** Back to the backend, now. */
    wake() {
        this.setMode('polling')
        this.told = null
        this.client?.pollNow()
    }

    // ---- the channels ----------------------------------------------------------

    opened(id, channel) {
        this.channels.set(id, channel)
        channel.addEventListener('message', ({ data }) => this.receive(id, channel, data))
        channel.addEventListener('close', () => {
            if (this.channels.get(id) !== channel) return
            this.channels.delete(id)
            this.closed(id)
        })

        if (id === this.hubId) this.heard = Date.now()
        this.release()

        if (this.isHub) {
            this.broadcast({ t: 'ping', reach: this.reachable() })
            // The next poll names them as present, and brings what to pass on to them.
            this.client?.pollNow()
        }
    }

    closed(id) {
        if (this.isHub) return this.broadcast({ t: 'ping', reach: this.reachable() })
        if (id !== this.hubId) return undefined

        this.reach = new Set()
        if (this.quiet || this.told) this.wake()

        return undefined
    }

    /** Write to a peer's channel; false when there is none, or the message does not fit one. */
    write(id, message) {
        const channel = this.channels.get(id)
        if (channel?.readyState !== 'open') return false

        const text = JSON.stringify(message)
        if (text.length > this.maxMessage) return false

        try {
            channel.send(text)
        } catch {
            return false
        }

        return true
    }

    broadcast(message) {
        for (const id of this.channels.keys()) this.write(id, message)
    }

    reachable() {
        return [...this.channels.keys()].filter((id) => this.open(id))
    }

    /** Who the hub answers for: an open channel, on a connection that is up. */
    present() {
        return this.reachable().filter((id) => this.connected(id))
    }

    /** The hub passes on what the backend said: to each peer its view, and a word to those with signals waiting there. */
    pass(relay) {
        const reach = this.reachable()
        for (const id of reach) this.write(id, { t: 'view', data: relay?.views?.[id] ?? null, reach })
        for (const id of relay?.pending ?? []) this.write(String(id), { t: 'poll' })
    }

    receive(id, channel, raw) {
        if (this.channels.get(id) !== channel || ! this.view) return

        let message
        try {
            message = JSON.parse(raw)
        } catch {
            return
        }
        if (message === null || typeof message !== 'object') return

        const fromHub = id === this.hubId
        if (fromHub) this.heard = Date.now()

        if (message.t === 'signal') {
            const { type, payload } = message
            if (typeof type !== 'string') return

            // For someone else: only the hub passes signals on.
            if (message.to !== undefined && message.to !== null) {
                if (! this.isHub) return
                const to = String(message.to)
                if (this.write(to, { t: 'signal', from: id, type, payload })) this.stats.relayed++
                else this.write(id, { t: 'undelivered', to, type, payload })
                return
            }

            // Only the hub speaks for others; anyone else is who their channel says.
            const from = message.from === undefined || message.from === null ? id : String(message.from)
            if (from !== id && ! fromHub) return
            if (from !== id) this.reach.add(from)

            const call = this.view.id
            this.client?.deliver({ signals: [{ call: this.client.call?.id ?? call, type, payload, from }] }, { call })
            if (from !== id) this.release()
            return
        }

        if (! fromHub) return

        if (message.t === 'undelivered') {
            // The hub lost them meanwhile: the backend has the signal now.
            const to = String(message.to)
            this.reach.delete(to)
            this.impatient.add(to)
            this.post(this.view.id, message.type, message.payload, to).catch((error) => this.failed(error))
        } else if (message.t === 'view' || message.t === 'ping') {
            if (Array.isArray(message.reach)) this.reach = new Set(message.reach.map(String))

            if (message.t === 'view') {
                const told = message.data !== null && typeof message.data === 'object' ? message.data : null
                this.told = told
                if (! told) {
                    // The backend has no answer for me through the hub: I ask it myself.
                    if (this.quiet) this.wake()
                } else {
                    const resting = this.quiet
                    const call = this.view.id
                    if (told.call) this.observe(told.call, call)
                    // Told while resting: applied now, not at the next (local) poll.
                    if (resting) this.client?.deliver({ ...told, signals: [] }, { call })
                }
            }

            this.release()
        } else if (message.t === 'poll') {
            this.owed = true
            this.client?.pollNow()
        }
    }

    // ---- the ways out ----------------------------------------------------------

    /** How a signal reaches a peer now: `direct`, through the `hub`, `wait` for them to reach the hub, or the `backend`. */
    way(id) {
        if (this.open(id)) return 'direct'
        if (this.isHub || this.hubId === null || id === this.hubId) return 'backend'
        if (this.open(this.hubId) && this.reach.has(id)) return 'hub'

        // Someone still ringing has not said yet whether their window relays (`relay` is null): worth the wait.
        const peer = (this.view?.peers ?? []).find((candidate) => String(candidate.id) === id)
        const relays = peer?.relay === true || (peer?.status === 'ringing' && (peer.relay ?? null) === null)

        return relays && ! this.impatient.has(id) ? 'wait' : 'backend'
    }

    async dispatch(signal) {
        const { callId, type, payload, to } = signal
        const way = this.way(to)

        if (way === 'direct' && this.write(to, { t: 'signal', type, payload })) {
            this.stats.direct++
            return undefined
        }

        if (way === 'hub' && this.write(this.hubId, { t: 'signal', to, type, payload })) {
            this.stats.viaHub++
            return undefined
        }

        if (way === 'wait') {
            let waiting = this.held.get(to)
            if (! waiting) {
                // Not for ever: someone whose connection to the hub never comes up still gets it.
                waiting = { signals: [], timer: setTimeout(() => this.giveUp(to), this.patience) }
                this.held.set(to, waiting)
            }
            waiting.signals.push(signal)
            return undefined
        }

        return this.post(callId, type, payload, to)
    }

    post(callId, type, payload, to) {
        this.stats.posts++

        return this.upstream.send(callId, type, payload, to)
    }

    /** Signals that waited for someone go out, in order, once there is a way that is not waiting. */
    release() {
        for (const [id, waiting] of [...this.held]) {
            // Within reach, or no longer worth waiting for (their window does not relay, the hub is gone).
            if (this.way(id) === 'wait') continue
            this.flush(id, waiting)
        }
        for (const id of this.impatient) if (this.open(id) || this.reach.has(id)) this.impatient.delete(id)
    }

    giveUp(id) {
        const waiting = this.held.get(id)
        if (! waiting) return
        this.impatient.add(id)
        this.flush(id, waiting)
    }

    flush(id, waiting) {
        clearTimeout(waiting.timer)
        this.held.delete(id)
        // One after the other: the backend hands them out in the order they arrive.
        waiting.signals.reduce((sent, signal) => sent.then(() => this.dispatch(signal)).catch((error) => this.failed(error)), Promise.resolve())
    }

    failed(error) {
        // 410: the call ended while the signal waited.
        if (error?.status !== 410) this.client?.emit('error', { error })
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
        this.claimed = null
        this.seenAgo = null
        // Back from hold and not heard from yet (their camera prompt may still be open): no drop timer for them meanwhile.
        this.returning = false
        this.muted = false
        this.cameraOff = false
        this.sharing = false
        this.stream = null
        this.connected = false
        // good | fair | poor once the connection is measured; null before, and while it is down.
        this.quality = null
    }

    /** Take the server's view; true when something a UI shows changed. */
    update({ name, avatar, seat, status, claimed, seen_ago }) {
        const before = `${this.name}|${this.avatar}|${this.seat}|${this.status}|${this.alive}`

        if (name !== undefined) this.name = name ?? this.id
        if (avatar !== undefined) this.avatar = avatar ?? null
        if (seat !== undefined && seat !== null) this.seat = seat
        if (status !== undefined) this.status = status
        if (claimed !== undefined) this.claimed = claimed
        if (seen_ago !== undefined) this.seenAgo = seen_ago

        return before !== `${this.name}|${this.avatar}|${this.seat}|${this.status}|${this.alive}`
    }

    /** Their window polls: a side that went quiet is reconnecting, not here. */
    get alive() {
        return this.claimed !== false && (this.seenAgo ?? 0) < 6
    }

    snapshot() {
        const { id, name, avatar, seat, status, alive, connected, quality, muted, cameraOff, sharing, stream } = this

        return { id, name, avatar, seat, status, alive, connected, quality, muted, cameraOff, sharing, stream }
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

        // A STUN or TURN server that refused or never answered: kept to explain a call that fails.
        pc.addEventListener('icecandidateerror', (event) => {
            if (! this.closed) client.iceCandidateError(event)
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

    /**
     * How this connection is doing, from the browser's own statistics: the round trip in
     * milliseconds, the share of packets lost since the last call, the jitter in seconds,
     * whether the media goes through a TURN relay, and all of it in a word (`quality`).
     * Null when the browser has nothing to say yet.
     */
    async stats() {
        if (this.closed || typeof this.pc.getStats !== 'function') return null

        const report = await this.pc.getStats()
        const byId = new Map()
        report.forEach((entry) => byId.set(entry.id, entry))

        let pair = null
        let lost = 0
        let received = 0
        let jitter = null

        byId.forEach((entry) => {
            if (entry.type === 'transport' && entry.selectedCandidatePairId) pair = byId.get(entry.selectedCandidatePairId) ?? pair
            if (entry.type === 'inbound-rtp') {
                lost += entry.packetsLost ?? 0
                received += entry.packetsReceived ?? 0
                if (entry.kind === 'audio' && typeof entry.jitter === 'number') jitter = entry.jitter
            }
        })
        // Firefox reports no transport: the pair it marks as selected.
        if (! pair) byId.forEach((entry) => { if (entry.type === 'candidate-pair' && (entry.selected || (entry.nominated && entry.state === 'succeeded'))) pair ??= entry })
        if (! pair && received === 0) return null

        const before = this.counted ?? { lost: 0, received: 0 }
        this.counted = { lost, received }
        const newlyLost = Math.max(0, lost - before.lost)
        const newlyReceived = Math.max(0, received - before.received)
        const loss = newlyLost + newlyReceived > 0 ? newlyLost / (newlyLost + newlyReceived) : 0
        const rtt = typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null
        const relayed = [pair?.localCandidateId, pair?.remoteCandidateId].some((id) => byId.get(id)?.candidateType === 'relay')

        return { rtt, loss, jitter, relayed, quality: rateConnection({ rtt, loss }) }
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
 *   stats(peer)                           how the connection to a peer is doing: { rtt, loss, jitter, relayed, quality }, or null
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
        if (! peer) return undefined
        // An offer from someone on the call I have no connection to (back from hold, and their
        // `reset` got lost on the way): answer it on a new one rather than drop it.
        if (type === 'offer' && ! this.links.has(peer.id) && peer.status === 'joined') this.connect(peer, { polite: true })

        return this.links.get(peer.id)?.signal(type, payload)
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

    /** How the connection to a peer is doing (see `Link.stats()`), or null. */
    stats(peer) {
        return this.links.get(peer.id)?.stats() ?? null
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
     * @param {{ microphone?: string|null, camera?: string|null, speaker?: string|null }} [options.devices]  the devices to start with, by id (what the person chose last time); see `devices()` and `setDevice()`
     * @param {() => Promise<MediaDeviceInfo[]>} [options.enumerateDevices]
     * @param {number} [options.statsInterval]  milliseconds between looks at each connection's quality (3000); 0 turns it off
     * @param {string[]} [options.channels]  data channels to open to every peer (ordered), surfaced by the `datachannel` event; channels pair by their place in this list, so every participant lists the same labels in the same order
     */
    constructor({ signaling, iceServers = [], video = true, poll = {}, reconnectTimeout = 15000, resumes = true, maxParticipants = 4, topology = null, getUserMedia, iceTransportPolicy = 'all', media = null, channels = [], devices = {}, enumerateDevices, statsInterval = 3000 } = {}) {
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
        this.enumerateDevices = enumerateDevices || (() => globalThis.navigator?.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]))
        // The chosen devices by id; null is whatever the system has as its default.
        this.selected = { microphone: devices.microphone || null, camera: devices.camera || null, speaker: devices.speaker || null }
        this.statsInterval = statsInterval
        this.statsTimer = null
        // Whether the media of this call ever flowed: a call that ends without is `failed`, not `dropped`.
        this.everConnected = false
        // When the wait for a connection began (see `refreshState()`); null while connected.
        this.tryingSince = null
        // What the TURN servers answered with when they refused, by URL (see `explainFailure()`).
        this.iceErrors = new Map()

        this.tab = randomId()
        this.state = 'idle'
        this.call = null
        // The call I put on hold (as the server presents it), from any window of mine; null when there is none.
        this.heldCall = null
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
        // Set while this window is about to run a call (answering, resuming): its polls claim the side.
        this.joining = false
        this.placing = null
        this.answering = null
        this.mediaRequest = null
        this.onVisibility = () => { if (! globalThis.document?.hidden) this.schedule(0) }
        this.onDeviceChange = () => this.emit('devices', { selected: { ...this.selected } })
        // What the server said is applied one answer at a time, polled or delivered (see `deliver()`).
        this.applied = Promise.resolve()
        // A signaling adapter that works with the call itself (RelaySignaling uses its data channels).
        this.signaling?.attach?.(this)
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
        globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange)
        this.schedule(0)
    }

    stop() {
        this.polling = false
        clearTimeout(this.timer)
        globalThis.document?.removeEventListener?.('visibilitychange', this.onVisibility)
        globalThis.navigator?.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange)
    }

    /**
     * Take everything down: stop polling, let go of the call for the next page
     * (the leave beacon) and close the connections and the camera, without events.
     */
    destroy() {
        this.stop()
        this.leave()
        this.signaling?.detach?.(this)
        this.epoch++
        this.topology?.leave()
        this.topology = null
        this.joined = false
        this.releaseMedia()
        clearTimeout(this.dropTimer)
        this.dropTimer = null
        clearTimeout(this.statsTimer)
        this.statsTimer = null
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
        // A window about to run a call (answering, resuming) polls fast: those polls claim its side.
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
        const claim = Boolean(this.joined || this.joining || this.resumeId)
        const epoch = this.epoch
        this.inFlight = this.signaling.poll({ after: this.cursor, call, tab: this.tab, claim })
            // Sent before this window hung up or declined: what it says is about a call that is gone here.
            .then((data) => {
                this.failures = 0
                return this.apply(() => epoch === this.epoch ? this.handlePoll(data, call) : undefined)
            })
            .catch((error) => {
                this.failures++
                // The session is gone (signed out, expired): the call cannot go on from here.
                if ((error?.status === 401 || error?.status === 419) && this.call && epoch === this.epoch) return this.finish('signed_out')
                this.emit('error', { error })
            })
            .finally(() => { this.inFlight = null; this.schedule(this.failures ? this.backoff() : undefined) })
        await this.inFlight
    }

    /** One answer after the other: a poll's and a delivered one never apply at the same time. */
    apply(work) {
        const done = this.applied.then(work)
        this.applied = done.catch(() => {})

        return done
    }

    /** Ask the server now instead of at the next interval: something said there is news. */
    pollNow() {
        this.schedule(0)
    }

    /**
     * Take what a poll would have answered from somewhere else: a signaling adapter that is
     * pushed to (a websocket, a data channel) hands it over as it arrives, instead of the
     * client waiting for its next poll. `data` has the shape of a poll's answer and may be a
     * part of one (only `signals`, say). With `call` set it is dropped unless this window is
     * still on that call.
     *
     * @param {{ call?: object|null, incoming?: object|null, on_hold?: object|null, signals?: object[], cursor?: number }} data
     * @param {{ call?: string|number|null }} [options]
     */
    deliver(data, { call = null } = {}) {
        const epoch = this.epoch

        return this.apply(() => {
            if (epoch !== this.epoch) return undefined
            if (call !== null && String(this.call?.id) !== String(call)) return undefined

            // A part of an answer says nothing about the call on hold: it stays as it is.
            return this.handlePoll({ ...data, on_hold: 'on_hold' in data ? data.on_hold : this.heldCall })
        }).catch((error) => this.emit('error', { error }))
    }

    /** `asked` is the call id the poll named, so a call the server no longer returns is known to be gone. */
    async handlePoll({ call, incoming, on_hold: onHold = null, signals = [], cursor }, asked = null) {
        if (typeof cursor === 'number' && cursor > this.cursor) this.cursor = cursor

        // The call this window has was put on hold (from here, or from another window of mine):
        // this window lets go of it without an ending.
        if (onHold && this.call && String(onHold.id) === String(this.call.id)) {
            this.park(onHold)
            call = null
            asked = null
        } else {
            this.setHeldCall(onHold)
        }

        if (incoming && this.state === 'idle') {
            await this.ring(incoming)
        }

        if (call && this.call && call.id === this.call.id) {
            this.call = { ...this.call, ...call }
            this.emit('update', { call: this.call })

            if (call.status === 'ended') {
                const failed = this.gaveUpConnecting(call.end_reason)
                if (failed) this.explainFailure()
                this.finish(failed ? 'failed' : (call.end_reason || 'hung_up'))
                return
            }

            this.syncPeers(this.call)

            if (! this.joined && call.claimed_elsewhere) {
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
            } else if (call.claimed_elsewhere || ! this.resumes) {
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

    // ---- on hold ---------------------------------------------------------------

    /**
     * Step out of the call I am in without leaving it: the others stay on it and see
     * me on hold, this window closes its connections and the camera and is free for
     * another call. `resumeHeld()` brings me back. Also from a window that only
     * watches the call (a main tab while the pop-out runs it). One call on hold at
     * a time; needs a backend with `hold` and `resume`.
     */
    hold() {
        // Asked twice at once (a double click): one request.
        this.holding ??= this.putOnHold().finally(() => { this.holding = null })

        return this.holding
    }

    async putOnHold() {
        if (! this.signaling.hold) throw new Error('This signaling backend cannot put a call on hold.')
        if (! this.canHold()) throw new Error('No call to put on hold.')

        const id = this.call.id
        let call
        try {
            call = await this.signaling.hold(id)
        } catch (error) {
            this.emit('error', { error })
            throw error
        }

        if (this.call && String(this.call.id) === String(id)) this.park(call)

        return call
    }

    /** Whether the call I am in can be put on hold: running, mine (here or in my pop-out), and none on hold already. */
    canHold() {
        const call = this.call

        return Boolean(call) && Boolean(this.signaling.hold) && ! this.heldCall && call.status === 'active'
            && (call.joined ?? true) && this.state !== 'ringing' && this.state !== 'idle'
    }

    /**
     * Back into the call I put on hold. A call I am in meanwhile goes on hold in its
     * place (a swap), and one I am still ringing someone on is given up. A window
     * that leaves calls to a pop-out (`resumes: false`) only tells the server; the
     * window that then opens for the call connects.
     */
    resumeHeld() {
        // Asked twice at once (a double click): one request, not a second one refused over a call that is back.
        this.resuming ??= this.resumeFromHold().finally(() => { this.resuming = null })

        return this.resuming
    }

    async resumeFromHold() {
        const held = this.heldCall
        if (! held) return null
        if (! this.signaling.resume) throw new Error('This signaling backend cannot put a call on hold.')
        if (this.state === 'ringing') throw new Error('A call is ringing.')

        let call
        try {
            call = await this.signaling.resume(held.id, this.resumes ? this.tab : null)
        } catch (error) {
            this.emit('error', { error })
            // Gone meanwhile (the other side hung up): the next poll says so too.
            if (error?.status === 410) this.setHeldCall(null)
            throw error
        }

        // The call this window had is on hold now, or given up: let go of it without an ending.
        // The next poll names the call that took its place on hold.
        this.heldCall = null
        if (this.call) this.reset()
        else this.epoch++
        this.emit('held', { call: null })

        if (this.resumes) await this.resume(call)
        else this.schedule(0)

        return call
    }

    /** Hang up the call I have on hold, without coming back to it. */
    async endHeld() {
        const held = this.heldCall
        if (! held) return
        this.epoch++
        this.setHeldCall(null)
        await this.signaling.hangup(held.id).catch(() => {})
        this.schedule(0)
    }

    /** My side of this window's call went on hold: everything down, no `ended`, and the call kept as `heldCall`. */
    park(call) {
        this.heldCall = call
        this.reset()
        this.emit('held', { call })
    }

    setHeldCall(call) {
        const signature = (held) => held ? `${held.id}|${(held.peers ?? []).map((peer) => `${peer.id}:${peer.name}:${peer.status}`).join(',')}` : ''
        const changed = signature(call) !== signature(this.heldCall)
        this.heldCall = call ?? null
        if (changed) this.emit('held', { call: this.heldCall })
    }

    // ---- people ----------------------------------------------------------------

    /** Who can be added to the call I am in (or rung, without one) for what was typed: `[{ id, name, avatar }]`. Needs a backend with `people`. */
    async search(query = '') {
        if (! this.signaling.people) return []
        const inCall = this.call && this.call.status !== 'ended' && (this.call.joined ?? true)
        let found
        try {
            found = await this.signaling.people(query, inCall ? this.call.id : null)
        } catch (error) {
            this.emit('error', { error })
            throw error
        }

        return Array.isArray(found) ? found : (found?.people ?? [])
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
        // window that claimed it, and a claim moves the cursor past the old signals.
        try {
            const claim = await this.signaling.poll({ after: this.cursor, call: call.id, tab: this.tab, claim: true })
            if (epoch !== this.epoch) return
            if (typeof claim.cursor === 'number' && claim.cursor > this.cursor) this.cursor = claim.cursor
            if (! claim.call || claim.call.status === 'ended') return this.finish(claim.call?.end_reason || 'hung_up')
            call = { ...call, ...claim.call }
            if (call.claimed_elsewhere) {
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
        if (epoch !== this.epoch || this.call?.id !== call.id || this.call?.claimed_elsewhere) {
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
        if (this.call.claimed_elsewhere) return false

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
            claimed: call.peer_claimed,
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
            const gone = ! ['ringing', 'joined', 'on_hold'].includes(entry.status ?? 'joined')
            const onHold = entry.status === 'on_hold'
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
                // Someone on hold has no window to connect to: they offer when they are back.
                if (this.joined && ! onHold) this.topology.connect(peer, { polite: peer.seat < this.seat })
                if (peer.status === 'joined') this.emit('peerjoined', { peer: peer.snapshot() })
                continue
            }

            const wasJoined = peer.status === 'joined'
            const wasOnHold = peer.status === 'on_hold'
            if (peer.update(entry)) changed = true

            if (gone) {
                this.dropPeer(peer, entry.status)
                changed = true
            } else if (onHold && ! wasOnHold) {
                // They stepped out: their connection is closed on their side, so it goes here too.
                this.topology?.disconnect(peer)
                Object.assign(peer, { connected: false, quality: null, stream: null, muted: false, cameraOff: false, sharing: false })
                this.emit('peerstate', { peer: peer.snapshot(), muted: false, cameraOff: false, sharing: false })
                this.emit('peerheld', { peer: peer.snapshot(), onHold: true })
                if (this.joined) this.refreshState()
            } else if (wasOnHold && peer.status === 'joined') {
                // Back: their `reset` and a fresh offer follow, which build the new connection.
                peer.returning = true
                this.emit('peerheld', { peer: peer.snapshot(), onHold: false })
                if (this.joined) this.refreshState()
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
            if (peer.status === 'on_hold') continue
            this.topology.connect(peer, fresh ? { polite: false, reset: true } : { polite: peer.seat < this.seat })
        }

        this.watchQuality()
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

        let stream
        try {
            // The stream in use stays the call's while the prompt is open, so muting or
            // hanging up meanwhile still reaches the microphone that is on.
            this.mediaRequest ??= this.requestMedia().finally(() => { this.mediaRequest = null })
            stream = await this.mediaRequest
        } catch (error) {
            // Nothing changed: the next startMedia() asks again.
            if (epoch === this.epoch) this.media = previousMedia
            this.emit('error', { error, media: true })
            throw error
        }

        // The call ended (or the window was taken down) while the prompt was open: the
        // camera and microphone go off again instead of staying on with no call.
        if (epoch !== this.epoch) {
            stream?.getTracks().forEach((track) => track.stop())
            previous?.getTracks().forEach((track) => track.stop())
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

    // ---- devices --------------------------------------------------------------

    /**
     * The microphones, cameras and speakers to choose from, and what is chosen. Browsers
     * name the devices only once the person allowed the camera or the microphone, so
     * before a first call the labels are empty; `speakers` is empty where the browser
     * cannot pick one (Safari, Firefox on some systems).
     *
     * @returns {Promise<{ microphones: {id: string, label: string}[], cameras: {id: string, label: string}[], speakers: {id: string, label: string}[], selected: { microphone: string|null, camera: string|null, speaker: string|null } }>}
     */
    async devices() {
        let list = []
        try {
            list = (await this.enumerateDevices()) ?? []
        } catch {
            // No permission to list them, or no devices API: nothing to choose from.
        }
        // Chrome also lists the system's choice as devices of its own (`default`, `communications`): null stands for that here.
        const of = (kind) => list
            .filter((device) => device.kind === kind && device.deviceId && ! ['default', 'communications'].includes(device.deviceId))
            .map((device) => ({ id: device.deviceId, label: device.label || '' }))

        return { microphones: of('audioinput'), cameras: of('videoinput'), speakers: of('audiooutput'), selected: { ...this.selected } }
    }

    /**
     * Choose a microphone, a camera or a speaker by its id (null: the system default). During
     * a call the microphone or the camera changes at once, for everyone, without renegotiating;
     * otherwise the next call starts with it. A speaker is only remembered here: the page plays
     * the sound, so it applies it (`element.setSinkId(id)`), as the widget does.
     *
     * @param {'microphone'|'camera'|'speaker'} kind
     * @param {string|null} id
     */
    async setDevice(kind, id) {
        if (! (kind in this.selected)) throw new Error(`Unknown device kind: ${kind}`)
        id = id || null
        if (this.selected[kind] === id) return

        const previous = this.selected[kind]
        this.selected[kind] = id

        try {
            if (kind !== 'speaker') await this.switchInput(kind, previous)
        } catch (error) {
            this.selected[kind] = previous
            this.emit('error', { error, media: true })
            throw error
        }

        this.emit('devices', { selected: { ...this.selected } })
    }

    /** What `getUserMedia` takes for a device: that one exactly, or any. */
    deviceConstraint(id) {
        return id ? { deviceId: { exact: id } } : true
    }

    /** Swap the running microphone or camera track for one from the chosen device. */
    async switchInput(kind, previous) {
        const audio = kind === 'microphone'
        const stream = this.cameraStream
        const old = stream?.getTracks().find((track) => track.kind === (audio ? 'audio' : 'video'))
        // Nothing of this kind is running (no call, or a voice call): the next call uses the choice.
        if (! stream || ! old) return

        const request = (id) => this.getUserMedia(audio ? { audio: this.deviceConstraint(id), video: false } : { audio: false, video: this.deviceConstraint(id) })
        const epoch = this.epoch
        // Released first: some browsers and most phones open one microphone or camera at a time.
        old.stop()

        let fresh
        let failure = null
        try {
            fresh = await request(this.selected[kind])
        } catch (error) {
            // Back to the device that worked, so the call is not left without a microphone.
            failure = error
            fresh = await request(previous).catch(() => null)
        }

        const track = fresh?.getTracks()[0] ?? null
        if (epoch !== this.epoch || this.cameraStream !== stream) {
            // The call ended while the browser was asking.
            track?.stop()
            return
        }

        if (track) {
            stream.removeTrack(old)
            stream.addTrack(track)
            track.enabled = audio ? ! this.muted : ! this.cameraOff
            this.publishLocal()
            // The sender of the stopped track takes the new one in place.
            if (audio) this.topology?.addTracks?.(this.localSource())
            else if (! this.screenStream) await this.topology?.replaceVideo?.(track)
        }

        if (failure) throw failure
    }

    // ---- connection quality ----------------------------------------------------

    /** The worst connection among the peers: good | fair | poor, or null before anything is measured. */
    get quality() {
        const order = ['good', 'fair', 'poor']
        const measured = [...this.roster.values()].map((peer) => peer.quality).filter(Boolean)

        return measured.length ? order[Math.max(...measured.map((quality) => order.indexOf(quality)))] : null
    }

    /** Look at every connection every `statsInterval` milliseconds while this window runs the call. */
    watchQuality() {
        clearTimeout(this.statsTimer)
        this.statsTimer = null
        if (! this.statsInterval || ! this.topology?.stats) return

        this.statsTimer = setTimeout(async () => {
            await this.measure().catch(() => {})
            if (this.joined) this.watchQuality()
        }, this.statsInterval)
    }

    /**
     * Measure the connection to every connected peer now: resolves to `[{ peer, rtt, loss,
     * jitter, relayed, quality }]`, and says `quality` for each peer whose word changed.
     */
    async measure() {
        const topology = this.topology
        if (! this.joined || ! topology?.stats) return []

        const results = []
        let changed = false

        for (const peer of [...this.roster.values()]) {
            if (! peer.connected) continue
            const stats = await Promise.resolve(topology.stats(peer)).catch(() => null)
            // The call or the peer went away while the browser was counting.
            if (! stats || topology !== this.topology || ! this.roster.has(peer.id) || ! peer.connected) continue

            results.push({ peer: peer.snapshot(), ...stats })
            if (peer.quality === stats.quality) continue
            peer.quality = stats.quality
            changed = true
            this.emit('quality', { peer: peer.snapshot(), ...stats })
        }

        if (changed) this.emit('peers', { peers: this.peers })

        return results
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
        if (connected) this.everConnected = true
        else peer.quality = null
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
        // No camera, or it is busy: a voice call rather than none.
        const withoutCamera = async (audio, camera) => {
            try {
                return await this.getUserMedia({ audio, video: camera })
            } catch (error) {
                if (! camera || ! DEVICE_ERRORS.includes(error.name)) throw error

                return this.getUserMedia({ audio, video: false })
            }
        }

        let stream
        if (this.selected.microphone || (video && this.selected.camera)) {
            try {
                stream = await this.getUserMedia({
                    audio: this.deviceConstraint(this.selected.microphone),
                    video: video ? this.deviceConstraint(this.selected.camera) : false,
                })
            } catch (error) {
                // A chosen device that is gone (unplugged since): the system's own.
                if (! DEVICE_ERRORS.includes(error.name)) throw error
                stream = await withoutCamera(true, video)
            }
        } else {
            stream = await withoutCamera(true, video)
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
     * waiting while everyone else in the call has it on hold; reconnecting
     * otherwise, and dropped after the timeout. A call that rings again (a backend that
     * keeps it open while fewer than two people are in it) is calling, with no clock.
     */
    refreshState() {
        if (! this.joined || ! this.call) return

        if (this.call.status !== 'active') {
            clearTimeout(this.dropTimer)
            this.dropTimer = null
            this.tryingSince = null
            if (this.call.status === 'ringing' && ['active', 'reconnecting', 'connecting', 'waiting'].includes(this.state)) this.setState('calling')
            return
        }

        const peers = [...this.roster.values()]
        const connected = peers.some((peer) => peer.status === 'joined' && peer.alive && this.topology.connected(peer))

        if (connected) {
            clearTimeout(this.dropTimer)
            this.dropTimer = null
            this.tryingSince = null
            this.setState('active')
        } else if (peers.some((peer) => peer.status === 'on_hold') && ! peers.some((peer) => peer.status === 'joined')) {
            // Nobody to be connected to, and nothing wrong: they come back when they resume.
            clearTimeout(this.dropTimer)
            this.dropTimer = null
            this.tryingSince = null
            this.setState('waiting')
        } else if (this.state === 'waiting') {
            // Someone is back (or joins): connecting to them, with the usual patience.
            this.setState('connecting')
            this.refreshState()
        } else if (this.state === 'active' || this.state === 'reconnecting' || this.state === 'connecting') {
            // Still the first attempt until the media has flowed once.
            this.setState(this.everConnected ? 'reconnecting' : 'connecting')
            // Everyone missing is on their way back from hold, their window still polling: they may be
            // answering a camera prompt, however long that takes. The clock starts with their `reset`.
            const joined = peers.filter((peer) => peer.status === 'joined')
            if (joined.length && joined.every((peer) => peer.returning && peer.alive)) {
                clearTimeout(this.dropTimer)
                this.dropTimer = null
                this.tryingSince = null
                return
            }
            this.tryingSince ??= Date.now()
            this.dropTimer ??= setTimeout(() => {
                if (this.state !== 'reconnecting' && this.state !== 'connecting') return
                if (! this.everConnected) this.explainFailure()
                this.hangUp(this.everConnected ? 'dropped' : 'failed')
            }, this.reconnectTimeout)
        }
    }

    /**
     * The other side hung up just as this side was about to give up on a first connection:
     * both waited the same time for a path that never came, and whoever's timer ran out
     * first ended the call. That is `failed` here too, not a plain hang-up.
     */
    gaveUpConnecting(reason) {
        return (reason ?? 'hung_up') === 'hung_up' && this.joined && ! this.everConnected
            && this.tryingSince != null && Date.now() - this.tryingSince >= this.reconnectTimeout * 0.8
    }

    /** The browser's `icecandidateerror`: a TURN server's refusal is kept for `explainFailure()`. */
    iceCandidateError({ url, errorCode, errorText } = {}) {
        if (! /^turns?:/i.test(String(url ?? ''))) return
        // The first word per server is the telling one; later ones repeat it per network interface.
        if (! this.iceErrors.has(url)) this.iceErrors.set(url, { url, code: Number(errorCode) || 0, text: errorText || '' })
    }

    /**
     * The browsers never found a path to each other: the developer gets one line in the
     * console saying why, as far as the browser told. A TURN server that refused the
     * credentials or could not be reached says so; with no TURN server at all, that is the
     * usual reason (a strict NAT, a VPN, a corporate firewall on one side).
     */
    explainFailure() {
        // The other side simply went away (closed the tab mid-ring): nothing to do with the network.
        if (! [...this.roster.values()].some((peer) => peer.status === 'joined' && peer.alive)) return

        const warn = (message) => globalThis.console?.warn?.(`[holler] The call could not connect: ${message}`)
        const errors = [...this.iceErrors.values()]
        const refused = errors.find((error) => error.code === 401 || error.code === 403 || error.code === 437 || error.code === 441)
        if (refused) {
            return warn(`the TURN server ${refused.url} refused the credentials (${refused.code}${refused.text ? ` ${refused.text}` : ''}). Check its shared secret, or the username and password, and that the clocks of the app server and the TURN server agree.`)
        }
        const unreachable = errors.find((error) => error.code === 701)
        if (unreachable) {
            return warn(`the TURN server ${unreachable.url} could not be reached${unreachable.text ? ` (${unreachable.text})` : ''}. Check its address and port, and that a firewall lets them through.`)
        }
        if (errors.length) {
            return warn(`the TURN server ${errors[0].url} answered with an error (${errors[0].code}${errors[0].text ? ` ${errors[0].text}` : ''}).`)
        }

        const urls = this.iceServers.flatMap((server) => [server?.urls ?? server?.url ?? []].flat())
        if (urls.some((url) => /^turns?:/i.test(String(url)))) return

        warn('no TURN server is configured, and some networks (strict NATs, VPNs, corporate firewalls) only connect through one. Add a TURN server to the ICE servers.')
    }

    async handleSignal({ type, payload, from }) {
        if (! this.joined || ! this.topology) return
        // A backend may relay `null`; one bad signal must not take the rest of the batch with it.
        if (payload === null || typeof payload !== 'object') payload = {}

        // A 1-on-1 backend names no sender: the one peer it is.
        const senderId = from ?? this.call?.peer?.id ?? null
        const peer = senderId === null ? null : this.roster.get(String(senderId)) ?? null
        // Back from hold with their media: from here on the usual patience applies.
        if (peer && (type === 'reset' || type === 'offer')) peer.returning = false

        if (type === 'reset') {
            if (! peer) return
            // The peer is back on a fresh page: a new connection for its new offer, and
            // everything off there until it says otherwise.
            this.topology.reset?.(peer, payload)
            peer.connected = false
            // Their old media ended with their old page: no frozen picture until the new one arrives.
            if (peer.stream && peer.stream !== this.topology.link?.(peer.id)?.stream) peer.stream = null
            if (this.roster.size === 1 && (this.state === 'active' || this.state === 'reconnecting' || this.state === 'waiting')) this.setState('connecting')
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
        clearTimeout(this.statsTimer)
        this.statsTimer = null
        this.everConnected = false
        this.tryingSince = null
        this.iceErrors.clear()
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
