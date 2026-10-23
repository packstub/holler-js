/**
 * @packstub/calls — 1-on-1 WebRTC calls with a pluggable signaling backend.
 *
 * Framework-agnostic: no DOM, no Alpine, no Laravel. A CallClient owns the
 * media streams and the RTCPeerConnection and talks to the other side through
 * a `signaling` object. HttpSignaling is the one that ships (plain JSON
 * endpoints, polled); a websocket or Firebase one implements the same methods.
 *
 * Signaling interface:
 *   start(userId, tab)                → call
 *   answer(callId, tab)               → call
 *   decline(callId) / hangup(callId)  → call
 *   send(callId, type, payload)       → void       (offer | answer | ice | reset | state)
 *   poll({ after, call, tab, hold })  → { call, incoming, signals, cursor }   (hold: this window wants the side)
 *   leave(callId, tab)                → void       (optional; a beacon as the page unloads)
 *
 * A `call` is { id, status: ringing|active|ended, end_reason, role: caller|callee,
 * peer: { id, name, avatar }, held, peer_held, peer_seen_ago, answered_at }.
 * `held` means another window of mine holds this call (a pop-out); `peer_held`
 * that the other side has a live window on it.
 *
 * Every window has a random `tab` id. The server hands a call's side to one
 * tab at a time; a page that reloads sends `leave`, the new page claims the
 * side again, sends `reset` and makes a fresh offer, and the other side builds
 * a new peer connection for it. Signals carry the sender's `session` (one per
 * peer connection) so leftovers from an old connection are ignored.
 *
 * Events (CallClient extends EventTarget, detail on each):
 *   statechange { state }   idle | calling | ringing | connecting | active | reconnecting | elsewhere
 *   incoming    { call }    someone is ringing you
 *   update      { call }    the call's server state changed (held, peer_held, status…)
 *   localstream { stream }  your camera/mic (or screen) stream, also after a share switch
 *   remotestream{ stream }  the other side's media
 *   peerstate   { muted, cameraOff, sharing }  the other side muted, turned the camera off or shares the screen
 *   ended       { call, reason }  declined | cancelled | missed | hung_up | failed | dropped | busy
 *   error       { error }
 */

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

// A backend may trim the description (Laravel's TrimStrings middleware does); the
// parser wants every line, the last one included, to end in CRLF.
const sdp = (text) => text.endsWith('\r\n') ? text : `${text.replace(/\r?\n$/, '')}\r\n`

export class HttpSignaling {
    /**
     * @param {object} options
     * @param {{ poll: string, store: string, answer: string, decline: string, hangup: string, signal: string, leave?: string }} options.routes
     *   Per-call routes contain `__ID__` where the call id goes.
     * @param {Record<string, string>} [options.headers] e.g. { 'X-CSRF-TOKEN': token }
     * @param {Record<string, string>} [options.beaconFields] form fields sent with the leave beacon, e.g. { _token: token }
     * @param {typeof fetch} [options.fetch]
     */
    constructor({ routes, headers = {}, beaconFields = {}, fetch: fetchFn } = {}) {
        this.routes = routes
        this.headers = headers
        this.beaconFields = beaconFields
        this.fetch = fetchFn || ((...args) => globalThis.fetch(...args))
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
        })

        const data = await response.json().catch(() => ({}))

        if (! response.ok) {
            const error = new Error(data.message || `${method} ${url} failed (${response.status})`)
            error.status = response.status
            throw error
        }

        return data
    }

    start(userId, tab) { return this.request('POST', this.routes.store, { callee: userId, tab }) }
    answer(callId, tab) { return this.request('POST', this.url('answer', callId), { tab }) }
    decline(callId) { return this.request('POST', this.url('decline', callId)) }
    hangup(callId) { return this.request('POST', this.url('hangup', callId)) }
    send(callId, type, payload) { return this.request('POST', this.url('signal', callId), { type, payload }) }

    poll({ after = 0, call = null, tab = null, hold = false } = {}) {
        const query = new URLSearchParams({ after: String(after) })
        if (call) query.set('call', String(call))
        if (tab) query.set('tab', tab)
        if (hold) query.set('hold', '1')

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

export class CallClient extends EventTarget {
    /**
     * @param {object} options
     * @param {HttpSignaling} options.signaling
     * @param {RTCIceServer[]} [options.iceServers]
     * @param {boolean} [options.video]  start calls with the camera on
     * @param {{ idle: number, active: number }} [options.poll]  milliseconds between polls
     * @param {number} [options.reconnectTimeout]  milliseconds to wait for the other side before giving up
     * @param {boolean} [options.resumes]  take over a call of mine that no window holds (false for a tab that leaves calls to a pop-out)
     * @param {(constraints: MediaStreamConstraints) => Promise<MediaStream>} [options.getUserMedia]
     */
    constructor({ signaling, iceServers = [], video = true, poll = { idle: 5000, active: 1000 }, reconnectTimeout = 15000, resumes = true, getUserMedia } = {}) {
        super()
        this.signaling = signaling
        this.iceServers = iceServers
        this.video = video
        this.pollIntervals = poll
        this.reconnectTimeout = reconnectTimeout
        this.resumes = resumes
        this.getUserMedia = getUserMedia || ((constraints) => navigator.mediaDevices.getUserMedia(constraints))

        this.tab = randomId()
        this.state = 'idle'
        this.call = null
        this.localStream = null
        this.cameraStream = null
        this.screenStream = null
        this.remoteStream = null
        this.pc = null
        this.session = null
        this.peerSession = null
        this.polite = false
        this.cursor = 0
        this.buffered = []
        this.autoAnswer = null
        // Signals go out one after the other: a candidate posted alongside the offer
        // could land first, and the other side applies them by id.
        this.outbox = Promise.resolve()
        // Candidates that arrive before the remote description wait here.
        this.pendingCandidates = []
        // The polite side answers the first offer and only offers itself afterwards
        // (a track added mid-call), never in competition with that first one.
        this.negotiated = false
        this.muted = false
        this.cameraOff = false
        // What the other side told us about itself (a `state` signal).
        this.peerMuted = false
        this.peerCameraOff = false
        this.peerSharing = false
        this.timer = null
        this.dropTimer = null
        this.polling = false
        this.inFlight = null
        this.takingOver = null
        this.makingOffer = false
        this.ignoreOffer = false
    }

    // ---- lifecycle -----------------------------------------------------------

    /** Begin polling for incoming calls. */
    start() {
        if (this.polling) return
        this.polling = true
        this.schedule(0)
    }

    stop() {
        this.polling = false
        clearTimeout(this.timer)
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
        const interval = delay ?? (['idle', 'elsewhere'].includes(this.state) ? this.pollIntervals.idle : this.pollIntervals.active)
        this.timer = setTimeout(() => this.tick(), interval)
    }

    async tick() {
        if (this.inFlight) return
        const call = this.call?.id ?? this.resumeId ?? null
        // Only a window that runs (or is about to run) the connection takes the side;
        // a tab showing the chip for a pop-out just watches.
        const hold = Boolean(this.pc || this.resumeId)
        this.inFlight = this.signaling.poll({ after: this.cursor, call, tab: this.tab, hold })
            .then((data) => this.handlePoll(data))
            .catch((error) => this.emit('error', { error }))
            .finally(() => { this.inFlight = null; this.schedule() })
        await this.inFlight
    }

    async handlePoll({ call, incoming, signals = [], cursor }) {
        if (typeof cursor === 'number' && cursor > this.cursor) this.cursor = cursor

        if (incoming && this.state === 'idle') {
            this.call = incoming
            this.setState('ringing')
            this.emit('incoming', { call: incoming })

            if (this.autoAnswer && String(this.autoAnswer) === String(incoming.id)) {
                this.autoAnswer = null
                await this.accept()
            }
        }

        if (call && this.call && call.id === this.call.id) {
            this.call = { ...this.call, ...call }
            this.emit('update', { call: this.call })

            if (call.status === 'ended') {
                this.finish(call.end_reason || 'hung_up')
                return
            }

            if (! this.pc && call.held) {
                // Another window of mine took it (the pop-out answered).
                this.setState('elsewhere')
            } else if (this.pc && call.status === 'active') {
                this.refreshState()
            }
        } else if (call && ! this.call && call.status !== 'ended') {
            this.resumeId = null

            if (call.status === 'ringing' && call.role === 'callee') {
                // Named by this window (a pop-out opened to answer it): ring here.
                this.call = call
                this.setState('ringing')
                this.emit('incoming', { call })

                if (this.autoAnswer && String(this.autoAnswer) === String(call.id)) {
                    this.autoAnswer = null
                    await this.accept()
                }
            } else if (call.held || ! this.resumes) {
                this.call = call
                this.setState('elsewhere')
            } else {
                await this.resume(call)
            }
        } else if (! call && this.call && this.state !== 'ringing') {
            this.finish('hung_up')
            return
        }

        for (const signal of signals) {
            if (! this.call || signal.call !== this.call.id) continue
            if (this.pc) await this.handleSignal(signal)
            else this.buffered.push(signal)
        }
    }

    // ---- calling -------------------------------------------------------------

    /** Ring a user. Resolves once the call is ringing on the server. */
    async callUser(userId) {
        if (this.state !== 'idle') await this.hangUp()

        try {
            await this.acquireMedia()
        } catch (error) {
            this.emit('error', { error, media: true })
            throw error
        }

        try {
            this.call = await this.signaling.start(userId, this.tab)
        } catch (error) {
            this.releaseMedia()
            this.emit('error', { error })
            throw error
        }

        this.setState('calling')
        this.createPeer(false)
        this.schedule(0)

        return this.call
    }

    /** Accept the call that is ringing. */
    async accept() {
        if (this.state !== 'ringing' || ! this.call) return

        try {
            await this.acquireMedia()
        } catch (error) {
            this.emit('error', { error, media: true })
            await this.decline()
            throw error
        }

        try {
            this.call = await this.signaling.answer(this.call.id, this.tab)
        } catch (error) {
            this.releaseMedia()
            this.emit('error', { error })
            this.reset()
            return
        }

        this.setState('connecting')
        this.createPeer(true)

        const buffered = this.buffered.splice(0)
        for (const signal of buffered) await this.handleSignal(signal)

        this.schedule(0)
    }

    /** This window steps back: another window (a pop-out) answers or continues the call. */
    handOff() {
        if (! this.call) return
        this.buffered = []
        this.setState('elsewhere')
    }

    /**
     * Continue a call the server still has me in, from a fresh page: new peer
     * connection, `reset` to the other side, then a new offer.
     */
    async resume(call) {
        this.call = call

        // Take the side first: the answer to the offer sent below only reaches the
        // window that holds it, and a claim moves the cursor past the old signals.
        try {
            const claim = await this.signaling.poll({ after: this.cursor, call: call.id, tab: this.tab, hold: true })
            if (typeof claim.cursor === 'number' && claim.cursor > this.cursor) this.cursor = claim.cursor
            if (! claim.call || claim.call.status === 'ended') return this.finish(claim.call?.end_reason || 'hung_up')
            if (claim.call.held) {
                this.call = { ...this.call, ...claim.call }
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

        this.setState(call.status === 'ringing' ? 'calling' : 'connecting')
        this.createPeer(false)
        this.send('reset', { session: this.session })
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
        if (this.call && this.pc) this.signaling.leave?.(this.call.id, this.tab)
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
        if (this.state !== 'elsewhere' || ! this.call || this.pc) return false

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
        if (this.call.held) return false

        const call = this.call

        if (call.status === 'ringing' && call.role === 'callee') {
            this.setState('ringing')
            this.emit('incoming', { call })

            return true
        }

        await this.resume(call)

        return this.call !== null && this.state !== 'elsewhere'
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
     * Tell the other side about my mute, camera and screen share, once there is a
     * connection to tell it over. A change is always sent; the announcement after a
     * negotiation only when something is on, since a fresh connection starts with
     * everything off on both sides.
     */
    announceState(changed = true) {
        if (! this.pc || ! this.call) return
        if (! changed && ! this.muted && ! this.cameraOff && ! this.sharing) return

        this.send('state', { muted: this.muted, cameraOff: this.cameraOff, sharing: this.sharing })
    }

    get sharing() {
        return this.screenStream !== null
    }

    async shareScreen() {
        if (! this.pc || this.screenStream) return

        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        const track = screen.getVideoTracks()[0]
        track.addEventListener('ended', () => this.stopSharing())
        this.screenStream = screen

        await this.replaceVideo(track)
        this.publishLocal()
        this.announceState()
    }

    async stopSharing() {
        if (! this.screenStream) return

        this.screenStream.getTracks().forEach((track) => track.stop())
        this.screenStream = null

        await this.replaceVideo(this.cameraStream?.getVideoTracks()[0] ?? null)
        this.publishLocal()
        this.announceState()
    }

    async replaceVideo(track) {
        const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video' || (s.track === null && s.__video))

        if (sender) {
            await sender.replaceTrack(track)
            sender.__video = true
        } else if (track) {
            // A voice call sharing a screen: adding a track renegotiates.
            const sender = this.pc.addTrack(track, this.localStream)
            sender.__video = true
        }
    }

    // ---- internals -----------------------------------------------------------

    async acquireMedia() {
        if (this.cameraStream) return this.cameraStream

        let stream
        try {
            stream = await this.getUserMedia({ audio: true, video: this.video })
        } catch (error) {
            // No camera, or it is busy: fall back to a voice call rather than fail.
            if (! this.video || ! ['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(error.name)) throw error
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
     * A new peer connection with the current media on it. The polite side waits
     * for the other side's offer and answers it (perfect negotiation).
     */
    createPeer(polite) {
        this.closePeer()

        const pc = new RTCPeerConnection({ iceServers: this.iceServers })
        this.pc = pc
        this.session = randomId()
        this.polite = polite
        this.negotiated = ! polite
        this.remoteStream = new MediaStream()
        this.makingOffer = false
        this.ignoreOffer = false
        this.pendingCandidates = []

        const source = this.screenStream ? this.localStream : this.cameraStream
        source.getTracks().forEach((track) => {
            const sender = pc.addTrack(track, source)
            if (track.kind === 'video') sender.__video = true
        })

        pc.addEventListener('track', ({ track }) => {
            this.remoteStream.addTrack(track)
            this.emit('remotestream', { stream: this.remoteStream })
        })

        pc.addEventListener('icecandidate', ({ candidate }) => {
            if (candidate) this.send('ice', candidate.toJSON())
        })

        pc.addEventListener('negotiationneeded', async () => {
            if (pc !== this.pc) return
            if (this.polite && ! this.negotiated) return

            try {
                this.makingOffer = true
                await pc.setLocalDescription()
                this.send('offer', { sdp: pc.localDescription.sdp })
            } catch (error) {
                this.emit('error', { error })
            } finally {
                this.makingOffer = false
            }
        })

        pc.addEventListener('connectionstatechange', () => {
            if (pc !== this.pc) return

            if (pc.connectionState === 'failed' && ! this.polite) pc.restartIce()

            this.refreshState()
        })
    }

    closePeer() {
        if (! this.pc) return
        this.pc.getSenders().forEach((sender) => { try { this.pc.removeTrack(sender) } catch {} })
        this.pc.close()
        this.pc = null
    }

    /** active while the connection is up and the other side's window is alive; reconnecting otherwise. */
    refreshState() {
        if (! this.pc || ! this.call || this.call.status !== 'active') return

        const connected = ['connected', 'completed'].includes(this.pc.connectionState) || this.pc.connectionState === 'connected'
        const peerAlive = this.call.peer_held !== false && (this.call.peer_seen_ago ?? 0) < 6

        if (connected && peerAlive) {
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

    async handleSignal({ type, payload }) {
        const pc = this.pc
        if (! pc) return

        try {
            if (type === 'reset') {
                // The other side is back on a fresh page: a new connection for its new offer,
                // and everything off there until it says otherwise.
                this.peerSession = payload.session
                this.createPeer(true)
                if (this.state === 'active' || this.state === 'reconnecting') this.setState('connecting')
                if (this.peerMuted || this.peerCameraOff || this.peerSharing) {
                    this.peerMuted = this.peerCameraOff = this.peerSharing = false
                    this.emit('peerstate', { muted: false, cameraOff: false, sharing: false })
                }
                return
            }

            if (this.peerSession && payload.session && payload.session !== this.peerSession) return

            if (type === 'state') {
                this.peerMuted = Boolean(payload.muted)
                this.peerCameraOff = Boolean(payload.cameraOff)
                this.peerSharing = Boolean(payload.sharing)
                this.emit('peerstate', { muted: this.peerMuted, cameraOff: this.peerCameraOff, sharing: this.peerSharing })
                return
            }

            if (type === 'offer') {
                const collision = this.makingOffer || pc.signalingState !== 'stable'
                this.ignoreOffer = ! this.polite && collision
                if (this.ignoreOffer) return

                this.peerSession ??= payload.session ?? null
                await pc.setRemoteDescription({ type: 'offer', sdp: sdp(payload.sdp) })
                await this.flushCandidates()
                await pc.setLocalDescription()
                this.negotiated = true
                this.send('answer', { sdp: pc.localDescription.sdp })
                // The other side (new, or back on a fresh page) learns what I have on.
                this.announceState(false)
            } else if (type === 'answer') {
                if (pc.signalingState !== 'have-local-offer') return
                this.peerSession ??= payload.session ?? null
                await pc.setRemoteDescription({ type: 'answer', sdp: sdp(payload.sdp) })
                await this.flushCandidates()
                if (this.state === 'calling') this.setState('connecting')
                this.announceState(false)
            } else if (type === 'ice') {
                if (! pc.remoteDescription) {
                    this.pendingCandidates.push(payload)
                    return
                }
                try {
                    await pc.addIceCandidate(payload)
                } catch (error) {
                    if (! this.ignoreOffer) throw error
                }
            }
        } catch (error) {
            this.emit('error', { error })
        }
    }

    async flushCandidates() {
        const candidates = this.pendingCandidates.splice(0)
        for (const candidate of candidates) {
            await this.pc.addIceCandidate(candidate).catch(() => {})
        }
    }

    /** Queue a signal for the other side, after every signal queued before it. */
    send(type, payload) {
        const call = this.call
        if (! call) return

        this.outbox = this.outbox
            .then(() => this.signaling.send(call.id, type, { ...payload, session: this.session }))
            // 410: the call ended while this was queued (a last candidate after the hang-up).
            .catch((error) => { if (error?.status !== 410) this.emit('error', { error }) })
    }

    finish(reason) {
        const call = this.call
        this.reset()
        this.emit('ended', { call, reason })
    }

    reset() {
        this.closePeer()
        this.releaseMedia()
        clearTimeout(this.dropTimer)
        this.dropTimer = null
        this.remoteStream = null
        this.call = null
        this.session = this.peerSession = null
        this.buffered = []
        this.pendingCandidates = []
        this.resumeId = null
        this.peerMuted = this.peerCameraOff = this.peerSharing = false
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
