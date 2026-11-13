/**
 * Test doubles for the engine: the WebRTC and media globals a browser would
 * provide, and an in-memory signaling server that follows the same rules as
 * the HTTP backend (one window holds a participant's side, signals flow only to
 * the holder, a cursor so nothing is missed or repeated, a seat per participant).
 */

import { vi } from 'vitest'

let ids = 0
const nextId = (prefix) => `${prefix}-${++ids}`

export class FakeTrack extends EventTarget {
    constructor(kind, label = kind) {
        super()
        this.id = nextId(kind)
        this.kind = kind
        this.label = label
        this.enabled = true
        this.readyState = 'live'
    }

    stop() {
        this.readyState = 'ended'
    }

    /** The browser's own "Stop sharing" bar, or a camera unplugged. */
    end() {
        this.stop()
        this.dispatchEvent(new Event('ended'))
    }
}

export class FakeMediaStream {
    constructor(tracks = []) {
        this.id = nextId('stream')
        this.tracks = [...tracks]
    }

    getTracks() { return [...this.tracks] }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio') }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video') }
    addTrack(track) { this.tracks.push(track) }
    removeTrack(track) { this.tracks = this.tracks.filter((candidate) => candidate !== track) }
}

export class FakeDataChannel extends EventTarget {
    constructor(label, options = {}) {
        super()
        this.label = label
        this.options = options
        this.readyState = 'connecting'
        this.bufferedAmount = 0
        this.bufferedAmountLowThreshold = 0
        this.sent = []
    }

    send(data) {
        if (this.readyState !== 'open') throw new Error('InvalidStateError')
        this.sent.push(data)
    }

    close() {
        this.readyState = 'closed'
        this.dispatchEvent(new Event('close'))
    }

    // ---- what the network would do ------------------------------------------

    open() {
        this.readyState = 'open'
        this.dispatchEvent(new Event('open'))
    }

    /** The browser sent what was queued down to the threshold. */
    drained() {
        this.bufferedAmount = 0
        this.dispatchEvent(new Event('bufferedamountlow'))
    }
}

export class FakeRTCPeerConnection extends EventTarget {
    static instances = []

    constructor(configuration = {}) {
        super()
        this.id = nextId('pc')
        this.configuration = configuration
        this.senders = []
        this.signalingState = 'stable'
        this.connectionState = 'new'
        this.localDescription = null
        this.remoteDescription = null
        this.candidates = []
        this.closed = false
        this.iceRestarts = 0
        FakeRTCPeerConnection.instances.push(this)
    }

    static get latest() {
        return FakeRTCPeerConnection.instances.at(-1)
    }

    static reset() {
        FakeRTCPeerConnection.instances = []
    }

    addTrack(track, stream) {
        const sender = { track, stream, replaced: [], replaceTrack: async (next) => { sender.replaced.push(next); sender.track = next } }
        this.senders.push(sender)
        // Browsers fire negotiationneeded once the current task ends, once for any number of tracks added in it.
        if (! this.negotiationPending) {
            this.negotiationPending = true
            queueMicrotask(() => {
                this.negotiationPending = false
                if (! this.closed) this.dispatchEvent(new Event('negotiationneeded'))
            })
        }

        return sender
    }

    createDataChannel(label, options) {
        const channel = new FakeDataChannel(label, options)
        this.channels = [...(this.channels ?? []), channel]
        // The first channel on a connection needs a negotiation, like a track.
        if (this.channels.length === 1 && ! this.negotiationPending) {
            this.negotiationPending = true
            queueMicrotask(() => {
                this.negotiationPending = false
                if (! this.closed) this.dispatchEvent(new Event('negotiationneeded'))
            })
        }

        return channel
    }

    /** The other side opened a channel: it arrives here, open. */
    receiveChannel(label) {
        const channel = new FakeDataChannel(label)
        channel.readyState = 'open'
        this.dispatchEvent(Object.assign(new Event('datachannel'), { channel }))

        return channel
    }

    removeTrack(sender) {
        this.senders = this.senders.filter((candidate) => candidate !== sender)
    }

    getSenders() {
        return [...this.senders]
    }

    async setLocalDescription(description) {
        description ??= this.signalingState === 'have-remote-offer'
            ? { type: 'answer', sdp: `v=0\r\nanswer ${this.id}\r\n` }
            : { type: 'offer', sdp: `v=0\r\noffer ${this.id}\r\n` }

        this.localDescription = description
        this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
    }

    async setRemoteDescription(description) {
        this.remoteDescription = description
        this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
    }

    async addIceCandidate(candidate) {
        this.candidates.push(candidate)
    }

    restartIce() {
        this.iceRestarts++
    }

    /** What `getStats()` answers: a test sets `report` to a list of entries ({ id, type, … }). */
    async getStats() {
        return new Map((this.report ?? []).map((entry) => [entry.id, entry]))
    }

    close() {
        this.closed = true
        this.connectionState = 'closed'
    }

    // ---- what the network would do ------------------------------------------

    setConnectionState(state) {
        this.connectionState = state
        this.dispatchEvent(new Event('connectionstatechange'))
    }

    receiveTrack(track) {
        this.dispatchEvent(Object.assign(new Event('track'), { track }))
    }

    gatherCandidate(candidate) {
        this.dispatchEvent(Object.assign(new Event('icecandidate'), {
            candidate: candidate === null ? null : { toJSON: () => candidate },
        }))
    }
}

/** A camera and a microphone, or whatever `getUserMedia` should answer with. */
export function fakeDevices({ camera = true } = {}) {
    const getUserMedia = vi.fn(async ({ audio, video }) => {
        if (video && ! camera) throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' })

        return new FakeMediaStream([
            ...(audio ? [new FakeTrack('audio', 'mic')] : []),
            ...(video ? [new FakeTrack('video', 'camera')] : []),
        ])
    })

    const getDisplayMedia = vi.fn(async () => new FakeMediaStream([new FakeTrack('video', 'screen')]))

    const enumerateDevices = vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'default', label: 'Default - Built-in microphone' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in microphone' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'Headset' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Built-in camera' },
        { kind: 'videoinput', deviceId: 'cam-2', label: 'External camera' },
        { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers' },
        { kind: 'audiooutput', deviceId: '', label: '' },
    ])

    return { getUserMedia, getDisplayMedia, enumerateDevices }
}

export function installBrowserGlobals(devices = fakeDevices()) {
    FakeRTCPeerConnection.reset()
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection)
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('navigator', { mediaDevices: devices, sendBeacon: vi.fn(() => true) })

    return devices
}

const fail = (message, status, reason = null) => Object.assign(new Error(message), { status, reason })
const LIVE = ['ringing', 'joined']

/**
 * The signaling backend in memory. `clientFor(userId)` hands out an object with
 * the signaling interface for that user, the way HttpSignaling would for a
 * signed-in browser. A call has a participant per person (the caller joined from
 * the start at seat 0, every invitee ringing at the next seat); it ends when
 * fewer than two people are left in it. State is inspectable and can be pushed
 * around by a test (end a call, make a side go quiet).
 */
export class FakeServer {
    constructor({ holdSeconds = 5 } = {}) {
        this.holdSeconds = holdSeconds
        this.calls = new Map()
        this.signals = []
        this.nextCallId = 1
        this.nextSignalId = 1
        this.now = 0
        this.names = {}
        this.log = []
    }

    /** Give a user a display name (ids are used otherwise). */
    name(userId, name) {
        this.names[userId] = name
        return this
    }

    /** A person's record on a call: { user_id, seat, status, tab, seen_at }. */
    participant(callId, userId) {
        return this.calls.get(Number(callId))?.participants.find((p) => p.user_id === userId) ?? null
    }

    clientFor(userId) {
        const server = this
        const me = (found) => found.participants.find((p) => p.user_id === userId) ?? null
        const call = (id) => {
            const found = server.calls.get(Number(id))
            if (! found) throw fail('Not found', 404)
            if (! me(found)) throw fail('Forbidden', 403)
            return found
        }
        const busy = (user) => [...server.calls.values()].some((c) => c.status !== 'ended' && c.participants.some((p) => p.user_id === user && LIVE.includes(p.status)))
        const liveCallsOf = (user) => [...server.calls.values()].filter((c) => c.status !== 'ended' && c.participants.some((p) => p.user_id === user && LIVE.includes(p.status)))

        return {
            async start(callees, tab, kind = 'call') {
                server.log.push([userId, 'start', callees, tab])
                const list = [].concat(callees ?? [])
                if (! list.length || list.includes(userId)) throw fail('This person cannot be called.', 422, 'not_allowed')
                const mine = liveCallsOf(userId)
                // A call with me on it does not count: I leave it.
                const anyBusy = list.some((user) => liveCallsOf(user).some((c) => ! mine.includes(c)))

                // Refused before I leave anything: my current call stays.
                if (anyBusy) throw fail('This person is on another call.', 409, 'busy')

                for (const open of mine) server.withdraw(open, me(open))

                const created = {
                    id: server.nextCallId++, kind, caller_id: userId, status: 'ringing', end_reason: null, answered_at: null,
                    participants: [
                        { user_id: userId, seat: 0, status: 'joined', tab: tab ?? null, seen_at: tab ? server.now : null },
                        ...list.map((id, index) => ({ user_id: id, seat: index + 1, status: 'ringing', tab: null, seen_at: null })),
                    ],
                }
                server.calls.set(created.id, created)

                return server.present(created, userId, tab)
            },

            async answer(callId, tab) {
                server.log.push([userId, 'answer', callId, tab])
                const found = call(callId)
                const mine = me(found)
                if (found.status === 'ended' || mine.status !== 'ringing') throw fail('This call is no longer ringing.', 409, 'not_ringing')
                if (liveCallsOf(userId).some((c) => c !== found && me(c).status === 'joined')) throw fail('This person is on another call.', 409, 'busy')
                Object.assign(mine, { status: 'joined', tab: tab ?? null, seen_at: tab ? server.now : null })
                if (found.status === 'ringing') Object.assign(found, { status: 'active', answered_at: new Date().toISOString() })

                return server.present(found, userId, tab)
            },

            async decline(callId) {
                server.log.push([userId, 'decline', callId])
                const found = call(callId)
                server.withdraw(found, me(found))

                return server.present(found, userId)
            },

            async hangup(callId) {
                server.log.push([userId, 'hangup', callId])
                const found = call(callId)
                server.withdraw(found, me(found))

                return server.present(found, userId)
            },

            async invite(callId, callee) {
                server.log.push([userId, 'invite', callId, callee])
                const found = call(callId)
                if (found.status === 'ended') throw fail('This call has ended.', 410)
                if (me(found).status !== 'joined') throw fail('Join the call before adding people to it.', 409)
                const existing = found.participants.find((p) => p.user_id === callee)
                if (! callee || callee === userId || (existing && LIVE.includes(existing.status))) throw fail('This person cannot be called.', 422)
                if (busy(callee)) throw fail('This person is on another call.', 409, 'busy')

                const seat = Math.max(...found.participants.map((p) => p.seat)) + 1
                if (existing) Object.assign(existing, { seat, status: 'ringing', tab: null, seen_at: null })
                else found.participants.push({ user_id: callee, seat, status: 'ringing', tab: null, seen_at: null })

                return server.present(found, userId)
            },

            async send(callId, type, payload, to = null) {
                server.log.push([userId, 'send', callId, type, to])
                const found = call(callId)
                if (found.status === 'ended') throw fail('This call has ended.', 410, 'ended')
                if (me(found).status !== 'joined') throw fail('That person is not on this call.', 422, 'not_allowed')
                const recipients = found.participants.filter((p) => p.user_id !== userId && LIVE.includes(p.status) && (to === null || String(p.user_id) === String(to)))
                let last = null
                for (const recipient of recipients) {
                    last = { id: server.nextSignalId++, call: found.id, to_user_id: recipient.user_id, from: userId, type, payload }
                    server.signals.push(last)
                }

                return { id: last?.id ?? null }
            },

            leave(callId, tab) {
                server.log.push([userId, 'leave', callId, tab])
                const found = server.calls.get(Number(callId))
                const mine = found ? me(found) : null
                if (mine && mine.tab === tab) mine.tab = null
            },

            async poll({ after = 0, call: currentId = null, tab = null, hold = false, kind = null } = {}) {
                server.log.push([userId, 'poll', currentId, tab, hold])
                const mine = liveCallsOf(userId).filter((c) => kind === null || c.kind === kind).sort((a, b) => b.id - a.id)

                let current = currentId ? server.calls.get(Number(currentId)) ?? null : (mine.find((c) => me(c).status === 'joined') ?? null)
                // Not mine, or no longer mine (I left a call that goes on), or of another kind; an ended call is still shown, for its reason.
                if (current && (! me(current) || (kind !== null && current.kind !== kind) || (current.status !== 'ended' && ! LIVE.includes(me(current).status)))) current = null

                let held = false
                if (current && currentId && tab && hold && current.status !== 'ended') {
                    const side = me(current)
                    const previous = side.tab
                    const stale = side.seen_at !== null && server.now - side.seen_at > server.holdSeconds
                    if (LIVE.includes(side.status) && (previous === null || previous === tab || stale)) {
                        const reclaimed = side.seen_at !== null && previous !== tab
                        side.tab = tab
                        side.seen_at = server.now
                        held = true
                        if (reclaimed) after = Math.max(after, server.signals.at(-1)?.id ?? 0)
                    }
                }

                const incoming = mine.find((c) => me(c).status === 'ringing' && c !== current) ?? null
                const signals = held ? server.signals.filter((s) => s.to_user_id === userId && s.call === current.id && s.id > after) : []

                return {
                    call: current ? server.present(current, userId, tab) : null,
                    incoming: incoming ? server.present(incoming, userId, tab) : null,
                    signals: signals.map(({ id, call: callId, type, payload, from }) => ({ id, call: callId, type, payload, from })),
                    cursor: signals.length ? signals.at(-1).id : after,
                }
            },
        }
    }

    /**
     * A participant is gone: left (or declined), or `missed` / `dropped` as the Laravel
     * server's expiry marks them; the call ends once fewer than two people are left in it.
     */
    withdraw(found, mine, status = null) {
        if (found.status === 'ended' || ! LIVE.includes(mine.status)) return
        mine.status = status ?? (mine.status === 'joined' ? 'left' : 'declined')
        mine.tab = null

        const live = found.participants.filter((p) => LIVE.includes(p.status))
        const joined = live.filter((p) => p.status === 'joined')

        // The caller gives up before anyone joined: everyone's ring stops.
        if (found.status === 'ringing' && mine.user_id === found.caller_id) return this.end(found.id, 'cancelled')
        if (live.length < 2 || joined.length === 0) {
            this.end(found.id, found.status === 'active' ? (mine.status === 'dropped' ? 'dropped' : 'hung_up') : (mine.status === 'missed' ? 'missed' : 'declined'))
        }
    }

    present(found, me, tab = null) {
        const mine = found.participants.find((p) => p.user_id === me)
        const isHeld = (p) => p.tab !== null && p.seen_at !== null && this.now - p.seen_at <= this.holdSeconds
        const peers = found.participants
            .filter((p) => p.user_id !== me)
            .sort((a, b) => a.seat - b.seat)
            .map((p) => ({
                id: p.user_id, name: this.names[p.user_id] ?? p.user_id, avatar: null, seat: p.seat, status: p.status,
                held: isHeld(p), seen_ago: p.seen_at === null ? null : this.now - p.seen_at,
            }))
        const first = peers.find((p) => LIVE.includes(p.status)) ?? peers[0] ?? null

        return {
            id: found.id,
            kind: found.kind ?? 'call',
            status: found.status,
            end_reason: found.end_reason,
            role: found.caller_id === me ? 'caller' : 'callee',
            seat: mine.seat,
            joined: mine.status === 'joined',
            answered_at: found.answered_at,
            held: isHeld(mine) && mine.tab !== tab,
            peers,
            peer: first ? { id: first.id, name: first.name, avatar: first.avatar } : null,
            peer_held: first?.held ?? false,
            peer_seen_ago: first?.seen_ago ?? null,
        }
    }

    end(callId, reason) {
        const found = this.calls.get(Number(callId))
        if (! found || found.status === 'ended') return
        Object.assign(found, { status: 'ended', end_reason: reason })
        this.signals = this.signals.filter((s) => s.call !== found.id)
    }

    /** Server time moves on; a side that has not polled since is stale. */
    tick(seconds) {
        this.now += seconds
    }

    sent(toUserId, callId = null) {
        return this.signals.filter((s) => s.to_user_id === toUserId && (callId === null || s.call === callId))
    }
}
