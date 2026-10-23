/**
 * Test doubles for the engine: the WebRTC and media globals a browser would
 * provide, and an in-memory signaling server that follows the same rules as
 * the HTTP backend (one window holds a side, signals flow only to the holder,
 * a cursor so nothing is missed or repeated).
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

    return { getUserMedia, getDisplayMedia }
}

export function installBrowserGlobals(devices = fakeDevices()) {
    FakeRTCPeerConnection.reset()
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection)
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('navigator', { mediaDevices: devices, sendBeacon: vi.fn(() => true) })

    return devices
}

/**
 * The signaling backend in memory. `clientFor(userId)` hands out an object with
 * the signaling interface for that user, the way HttpSignaling would for a
 * signed-in browser. State is inspectable and can be pushed around by a test
 * (end a call, make a side go quiet).
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

    clientFor(userId) {
        const server = this
        const call = (id) => {
            const found = server.calls.get(Number(id))
            if (! found) throw Object.assign(new Error('Not found'), { status: 404 })
            if (found.caller_id !== userId && found.callee_id !== userId) throw Object.assign(new Error('Forbidden'), { status: 403 })
            return found
        }

        return {
            async start(callee, tab) {
                server.log.push([userId, 'start', callee, tab])
                const busy = [...server.calls.values()].some((c) => c.status !== 'ended' && (c.caller_id === callee || c.callee_id === callee))
                if (callee === userId || ! callee) throw Object.assign(new Error('This person cannot be called.'), { status: 422 })

                for (const open of server.calls.values()) {
                    if (open.status !== 'ended' && (open.caller_id === userId || open.callee_id === userId)) server.end(open.id, 'cancelled')
                }

                if (busy) throw Object.assign(new Error('This person is on another call.'), { status: 409 })

                const created = {
                    id: server.nextCallId++, caller_id: userId, callee_id: callee, status: 'ringing', end_reason: null, answered_at: null,
                    caller_tab: tab ?? null, callee_tab: null, caller_seen_at: tab ? server.now : null, callee_seen_at: null,
                }
                server.calls.set(created.id, created)

                return server.present(created, userId, tab)
            },

            async answer(callId, tab) {
                server.log.push([userId, 'answer', callId, tab])
                const found = call(callId)
                if (found.callee_id !== userId || found.status !== 'ringing') throw Object.assign(new Error('This call is no longer ringing.'), { status: 409 })
                Object.assign(found, { status: 'active', answered_at: new Date(2026, 0, 1).toISOString(), callee_tab: tab ?? null, callee_seen_at: tab ? server.now : null })

                return server.present(found, userId, tab)
            },

            async decline(callId) {
                server.log.push([userId, 'decline', callId])
                const found = call(callId)
                server.end(found.id, found.callee_id === userId ? 'declined' : 'cancelled')

                return server.present(found, userId)
            },

            async hangup(callId) {
                server.log.push([userId, 'hangup', callId])
                const found = call(callId)
                server.end(found.id, found.status === 'ringing' ? (found.caller_id === userId ? 'cancelled' : 'declined') : 'hung_up')

                return server.present(found, userId)
            },

            async send(callId, type, payload) {
                server.log.push([userId, 'send', callId, type])
                const found = call(callId)
                if (found.status === 'ended') throw Object.assign(new Error('This call has ended.'), { status: 410 })
                const signal = { id: server.nextSignalId++, call: found.id, to_user_id: found.caller_id === userId ? found.callee_id : found.caller_id, type, payload }
                server.signals.push(signal)

                return { id: signal.id }
            },

            leave(callId, tab) {
                server.log.push([userId, 'leave', callId, tab])
                const found = server.calls.get(Number(callId))
                if (! found) return
                const side = found.caller_id === userId ? 'caller' : 'callee'
                if (found[`${side}_tab`] === tab) found[`${side}_tab`] = null
            },

            async poll({ after = 0, call: currentId = null, tab = null, hold = false } = {}) {
                server.log.push([userId, 'poll', currentId, tab, hold])
                const mine = [...server.calls.values()].filter((c) => c.status !== 'ended' && (c.caller_id === userId || c.callee_id === userId)).sort((a, b) => b.id - a.id)

                let current = currentId ? server.calls.get(Number(currentId)) ?? null : (mine.find((c) => c.status === 'active' || c.caller_id === userId) ?? null)
                if (current && current.caller_id !== userId && current.callee_id !== userId) current = null

                let held = false
                if (current && currentId && tab && hold && current.status !== 'ended') {
                    const side = current.caller_id === userId ? 'caller' : 'callee'
                    const previous = current[`${side}_tab`]
                    const stale = current[`${side}_seen_at`] !== null && server.now - current[`${side}_seen_at`] > server.holdSeconds
                    if (previous === null || previous === tab || stale) {
                        const reclaimed = current[`${side}_seen_at`] !== null && previous !== tab
                        current[`${side}_tab`] = tab
                        current[`${side}_seen_at`] = server.now
                        held = true
                        if (reclaimed) after = Math.max(after, server.signals.at(-1)?.id ?? 0)
                    }
                }

                const incoming = mine.find((c) => c.status === 'ringing' && c.callee_id === userId && c !== current) ?? null
                const signals = held ? server.signals.filter((s) => s.to_user_id === userId && s.call === current.id && s.id > after) : []

                return {
                    call: current ? server.present(current, userId, tab) : null,
                    incoming: incoming ? server.present(incoming, userId, tab) : null,
                    signals: signals.map(({ id, call: callId, type, payload }) => ({ id, call: callId, type, payload })),
                    cursor: signals.length ? signals.at(-1).id : after,
                }
            },
        }
    }

    present(found, me, tab = null) {
        const side = found.caller_id === me ? 'caller' : 'callee'
        const peerSide = side === 'caller' ? 'callee' : 'caller'
        const peerId = found[`${peerSide}_id`]
        const isHeld = (which) => found[`${which}_tab`] !== null && found[`${which}_seen_at`] !== null && this.now - found[`${which}_seen_at`] <= this.holdSeconds

        return {
            id: found.id,
            status: found.status,
            end_reason: found.end_reason,
            role: side,
            peer: { id: peerId, name: this.names[peerId] ?? peerId, avatar: null },
            answered_at: found.answered_at,
            held: isHeld(side) && found[`${side}_tab`] !== tab,
            peer_held: isHeld(peerSide),
            peer_seen_ago: found[`${peerSide}_seen_at`] === null ? null : this.now - found[`${peerSide}_seen_at`],
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
