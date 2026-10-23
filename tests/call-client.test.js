import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient } from '../src/index.js'
import { FakeRTCPeerConnection, FakeServer, FakeTrack, fakeDevices, installBrowserGlobals } from './fakes.js'

const EVENTS = ['statechange', 'incoming', 'update', 'localstream', 'remotestream', 'ended', 'error']

let server
let devices

beforeEach(() => {
    vi.useFakeTimers()
    devices = installBrowserGlobals()
    server = new FakeServer().name('ion', 'Ion').name('ana', 'Ana')
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** A client for a user, polling fast, with every event recorded on `client.log`. */
function client(user, options = {}) {
    const instance = new CallClient({ signaling: server.clientFor(user), poll: { idle: 100, active: 50 }, reconnectTimeout: 1000, ...options })
    instance.log = []
    for (const type of EVENTS) instance.addEventListener(type, (event) => instance.log.push({ type, ...event.detail }))
    instance.events = (type) => instance.log.filter((event) => event.type === type)
    instance.states = () => instance.events('statechange').map((event) => event.state)

    return instance
}

/** Let the polls, the outbox and the timers run. */
const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

/** Ion rings Ana, she accepts, the browsers exchange the offer and the answer and the network comes up. */
async function connect(options = {}) {
    const ion = client('ion', options.ion)
    const ana = client('ana', options.ana)
    ion.start()
    ana.start()

    await ion.callUser('ana')
    await settle()
    await ana.accept()
    await settle()

    ion.pc.setConnectionState('connected')
    ana.pc.setConnectionState('connected')
    await settle()

    return { ion, ana, callId: ion.call.id }
}

describe('ringing', () => {
    it('rings the callee: the caller is calling, the callee hears an incoming call with the caller\'s name', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()

        const call = await ion.callUser('ana')

        expect(call).toMatchObject({ status: 'ringing', role: 'caller', peer: { id: 'ana', name: 'Ana' } })
        expect(ion.state).toBe('calling')
        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true })
        expect(ion.pc).toBeInstanceOf(FakeRTCPeerConnection)
        expect(ion.pc.configuration).toEqual({ iceServers: [] })

        await settle()

        expect(ana.state).toBe('ringing')
        expect(ana.events('incoming')[0].call).toMatchObject({ id: call.id, role: 'callee', peer: { name: 'Ion' } })
        // Nobody asked Ana for a camera yet.
        expect(devices.getUserMedia).toHaveBeenCalledTimes(1)
    })

    it('hands the ICE servers to the peer connection', async () => {
        const iceServers = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'c' }]
        const ion = client('ion', { iceServers })

        await ion.callUser('ana')

        expect(ion.pc.configuration).toEqual({ iceServers })
    })

    it('tells the caller when the other person is busy and gives the camera back', async () => {
        await server.clientFor('mihai').start('ana', 'm-tab')
        const ion = client('ion')
        ion.start()

        await expect(ion.callUser('ana')).rejects.toMatchObject({ status: 409 })

        expect(ion.state).toBe('idle')
        expect(ion.events('error')[0].error.status).toBe(409)
        const stream = await devices.getUserMedia.mock.results[0].value
        expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
    })

    it('reports a media error without ringing anyone', async () => {
        devices.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
        const ion = client('ion')

        await expect(ion.callUser('ana')).rejects.toMatchObject({ name: 'NotAllowedError' })

        expect(ion.events('error')[0]).toMatchObject({ media: true })
        expect(server.calls.size).toBe(0)
    })

    it('lets the caller hang up while ringing: the callee\'s ring stops as cancelled', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()

        await ion.hangUp()
        await settle()

        expect(ion.events('ended')[0].reason).toBe('hung_up')
        expect(server.calls.get(1)).toMatchObject({ status: 'ended', end_reason: 'cancelled' })
        expect(ana.state).toBe('idle')
        expect(ana.events('ended')[0].reason).toBe('cancelled')
    })

    it('lets the callee decline: the caller learns about it on the next poll', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()

        await ana.decline()
        await settle()

        expect(ana.events('ended')[0].reason).toBe('declined')
        expect(ion.state).toBe('idle')
        expect(ion.events('ended')[0].reason).toBe('declined')
        expect(ion.pc).toBeNull()
    })

    it('ends with the reason the server gives when the call is ended elsewhere', async () => {
        const ion = client('ion')
        ion.start()
        await ion.callUser('ana')

        server.end(1, 'missed')
        await settle()

        expect(ion.events('ended')[0]).toMatchObject({ reason: 'missed', call: { id: 1 } })
        expect(ion.state).toBe('idle')
    })
})

describe('connecting', () => {
    it('exchanges the offer and the answer through the server and becomes active once the network is up', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()

        await ion.callUser('ana')
        await settle()

        // The offer waits on the server until the callee joins.
        expect(server.sent('ana').map((signal) => signal.type)).toEqual(['offer'])
        expect(server.sent('ana')[0].payload.session).toBe(ion.session)

        await ana.accept()
        expect(ana.state).toBe('connecting')
        expect(ana.polite).toBe(true)
        await settle()

        expect(ana.pc.remoteDescription).toMatchObject({ type: 'offer' })
        expect(ana.pc.localDescription).toMatchObject({ type: 'answer' })
        expect(server.sent('ion').map((signal) => signal.type)).toEqual(['answer'])
        expect(ion.pc.remoteDescription).toMatchObject({ type: 'answer' })
        // Not active until the network is up; polls meanwhile may already show it as reconnecting.
        expect(['connecting', 'reconnecting']).toContain(ion.state)
        expect(ana.peerSession).toBe(ion.session)

        ion.pc.setConnectionState('connected')
        ana.pc.setConnectionState('connected')
        await settle()

        expect(ion.state).toBe('active')
        expect(ana.state).toBe('active')
        expect(ion.states().slice(0, 2)).toEqual(['calling', 'connecting'])
        expect(ana.states().slice(0, 2)).toEqual(['ringing', 'connecting'])
        expect(ion.states().at(-1)).toBe('active')
        expect(ana.states().at(-1)).toBe('active')
    })

    it('relays ICE candidates as they are gathered and applies the other side\'s', async () => {
        const { ion, ana } = await connect()

        ion.pc.gatherCandidate({ candidate: 'candidate:1 udp', sdpMid: '0' })
        ion.pc.gatherCandidate(null)
        await settle()

        expect(server.sent('ana').at(-1)).toMatchObject({ type: 'ice', payload: { candidate: 'candidate:1 udp', session: ion.session } })
        expect(ana.pc.candidates).toEqual([{ candidate: 'candidate:1 udp', sdpMid: '0', session: ion.session }])
    })

    it('holds candidates that arrive before the offer and applies them with it', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()

        await ana.handleSignal({ type: 'ice', payload: { candidate: 'early' } })
        expect(ana.pc.candidates).toEqual([])
        expect(ana.pendingCandidates).toHaveLength(1)

        await settle()

        expect(ana.pc.remoteDescription.type).toBe('offer')
        expect(ana.pc.candidates).toEqual([{ candidate: 'early' }])
    })

    it('restores the CRLF a backend may have trimmed off a session description', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()

        await ana.handleSignal({ type: 'offer', payload: { sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=last', session: ion.session } })

        expect(ana.pc.remoteDescription.sdp).toBe('v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=last\r\n')
    })

    it('emits the remote stream as tracks arrive', async () => {
        const { ion } = await connect()

        ion.pc.receiveTrack(new FakeTrack('audio'))
        ion.pc.receiveTrack(new FakeTrack('video'))

        expect(ion.events('remotestream')).toHaveLength(2)
        expect(ion.remoteStream.getVideoTracks()).toHaveLength(1)
        expect(ion.events('remotestream')[1].stream).toBe(ion.remoteStream)
    })

    it('ignores an offer that collides with its own on the impolite side, and yields on the polite side', async () => {
        const { ion, ana } = await connect()

        ion.makingOffer = true
        await ion.handleSignal({ type: 'offer', payload: { sdp: 'v=0\r\n', session: ana.session } })
        expect(ion.ignoreOffer).toBe(true)
        expect(ion.pc.remoteDescription.type).toBe('answer')

        ana.makingOffer = true
        await ana.handleSignal({ type: 'offer', payload: { sdp: 'v=0\r\nnew offer\r\n', session: ion.session } })
        expect(ana.ignoreOffer).toBe(false)
        expect(ana.pc.remoteDescription.sdp).toBe('v=0\r\nnew offer\r\n')
        expect(server.sent('ion').filter((signal) => signal.type === 'answer')).toHaveLength(2)
    })

    it('drops signals left over from an older connection of the other side', async () => {
        const { ana } = await connect()

        await ana.handleSignal({ type: 'ice', payload: { candidate: 'stale', session: 'an-older-session' } })

        expect(ana.pc.candidates).toEqual([])
        expect(ana.events('error')).toEqual([])
    })

    it('restarts ICE from the impolite side only when the connection fails', async () => {
        const { ion, ana } = await connect()

        ion.pc.setConnectionState('failed')
        ana.pc.setConnectionState('failed')

        expect(ion.pc.iceRestarts).toBe(1)
        expect(ana.pc.iceRestarts).toBe(0)
        expect(ion.state).toBe('reconnecting')
    })
})

describe('in the call', () => {
    it('hangs up: media stopped, connection closed, the other side told', async () => {
        const { ion, ana, callId } = await connect()
        const camera = ion.cameraStream

        await ion.hangUp()
        await settle()

        expect(ion.state).toBe('idle')
        expect(ion.events('ended')[0]).toMatchObject({ reason: 'hung_up', call: { id: callId } })
        expect(camera.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
        expect(ion.pc).toBeNull()
        expect(FakeRTCPeerConnection.instances[0].closed).toBe(true)
        expect(server.calls.get(callId)).toMatchObject({ status: 'ended', end_reason: 'hung_up' })
        expect(ana.state).toBe('idle')
        expect(ana.events('ended')[0].reason).toBe('hung_up')
    })

    it('mutes and turns the camera off by disabling the tracks, also for media acquired later', async () => {
        const ion = client('ion')
        ion.setMuted(true)

        await ion.callUser('ana')
        const [audio] = ion.cameraStream.getAudioTracks()
        const [video] = ion.cameraStream.getVideoTracks()
        expect(audio.enabled).toBe(false)
        expect(video.enabled).toBe(true)

        ion.setMuted(false)
        ion.setCameraOff(true)
        expect(audio.enabled).toBe(true)
        expect(video.enabled).toBe(false)
    })

    it('falls back to a voice call when there is no camera', async () => {
        installBrowserGlobals(fakeDevices({ camera: false }))
        const ion = client('ion')

        await ion.callUser('ana')

        expect(navigator.mediaDevices.getUserMedia.mock.calls).toEqual([[{ audio: true, video: true }], [{ audio: true, video: false }]])
        expect(ion.localStream.getVideoTracks()).toHaveLength(0)
        expect(ion.localStream.getAudioTracks()).toHaveLength(1)
        expect(ion.pc.getSenders()).toHaveLength(1)
    })

    it('starts voice-only when asked and does not fall back on other camera errors', async () => {
        const ion = client('ion', { video: false })
        await ion.callUser('ana')
        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })

        devices.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
        const ana = client('ana')
        ana.start()
        await settle()
        await expect(ana.accept()).rejects.toMatchObject({ name: 'NotAllowedError' })
        expect(devices.getUserMedia).toHaveBeenCalledTimes(2)
        // A callee who cannot join declines.
        expect(server.calls.get(1)).toMatchObject({ status: 'ended', end_reason: 'declined' })
    })

    it('shares the screen in place of the camera and goes back to the camera when the share ends', async () => {
        const { ion } = await connect()
        const [camera] = ion.cameraStream.getVideoTracks()
        const sender = ion.pc.getSenders().find((candidate) => candidate.track.kind === 'video')

        await ion.shareScreen()

        expect(ion.sharing).toBe(true)
        expect(devices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false })
        const screen = ion.screenStream.getVideoTracks()[0]
        expect(sender.track).toBe(screen)
        expect(ion.localStream.getVideoTracks()).toEqual([screen])
        expect(ion.localStream.getAudioTracks()).toHaveLength(1)
        expect(ion.events('localstream').at(-1).stream).toBe(ion.localStream)
        // Still one video sender: no renegotiation for a swap.
        expect(ion.pc.getSenders()).toHaveLength(2)

        screen.end()
        await settle()

        expect(ion.sharing).toBe(false)
        expect(sender.track).toBe(camera)
        expect(ion.localStream.getVideoTracks()).toEqual([camera])
    })

    it('adds a video track when a voice call shares the screen, which sends a new offer', async () => {
        installBrowserGlobals(fakeDevices({ camera: false }))
        const { ion } = await connect()
        expect(ion.pc.getSenders()).toHaveLength(1)
        const offersBefore = server.sent('ana').filter((signal) => signal.type === 'offer').length

        await ion.shareScreen()
        await settle()

        expect(ion.pc.getSenders()).toHaveLength(2)
        expect(server.sent('ana').filter((signal) => signal.type === 'offer')).toHaveLength(offersBefore + 1)

        await ion.stopSharing()
        expect(ion.pc.getSenders().find((sender) => sender.__video).track).toBeNull()
    })

    it('does not surface a 410 for a candidate sent after the call ended', async () => {
        const { ion } = await connect()

        server.end(ion.call.id, 'hung_up')
        ion.pc.gatherCandidate({ candidate: 'late' })
        await settle()

        expect(ion.events('error')).toEqual([])
        expect(ion.state).toBe('idle')
    })
})

describe('windows and reconnecting', () => {
    it('sees the other side go quiet as reconnecting and ends the call as dropped after the timeout', async () => {
        const { ion, ana, callId } = await connect()

        // Ana's window is gone: no more polls from her side.
        ana.stop()
        server.calls.get(callId).callee_tab = null
        server.tick(10)
        await settle()

        expect(ion.state).toBe('reconnecting')
        expect(ion.call.peer_held).toBe(false)

        await settle(1100)

        expect(ion.state).toBe('idle')
        expect(ion.events('ended')[0].reason).toBe('dropped')
    })

    it('resumes a call from a fresh page: claims the side first, then resets the other side and offers again', async () => {
        const { ion, ana, callId } = await connect()
        const firstSession = ion.session
        ana.log.length = 0

        // The page unloads.
        ion.leave()
        ion.stop()
        expect(server.calls.get(callId).caller_tab).toBeNull()

        const reloaded = client('ion')
        reloaded.start()
        await settle()

        const toAna = server.sent('ana').filter((signal) => signal.payload.session !== firstSession)
        expect(toAna.map((signal) => signal.type)).toEqual(['reset', 'offer'])
        expect(toAna[0].payload.session).toBe(reloaded.session)
        expect(server.calls.get(callId).caller_tab).toBe(reloaded.tab)
        // The claim (a poll that holds) came before any signal from the new page.
        const sinceLeave = server.log.slice(server.log.findIndex(([, action]) => action === 'leave') + 1).filter(([user]) => user === 'ion')
        const firstClaim = sinceLeave.findIndex(([, action, , , hold]) => action === 'poll' && hold)
        const firstSend = sinceLeave.findIndex(([, action]) => action === 'send')
        expect(firstClaim).toBeGreaterThanOrEqual(0)
        expect(firstClaim).toBeLessThan(firstSend)

        // Ana rebuilt her connection for the new offer and answered it.
        expect(ana.pc).not.toBe(FakeRTCPeerConnection.instances[1])
        expect(ana.polite).toBe(true)
        expect(ana.peerSession).toBe(reloaded.session)
        expect(ana.pc.remoteDescription.type).toBe('offer')
        expect(reloaded.pc.remoteDescription.type).toBe('answer')
        expect(ana.states()[0]).toBe('connecting')

        reloaded.pc.setConnectionState('connected')
        ana.pc.setConnectionState('connected')
        await settle()

        expect(reloaded.state).toBe('active')
        expect(ana.state).toBe('active')
    })

    it('sends the leave beacon only from a window that runs the connection', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()

        ana.leave()
        ion.leave()

        expect(server.log.filter(([, action]) => action === 'leave')).toEqual([['ion', 'leave', 1, ion.tab]])
    })

    it('shows a second window of the same person the call as held elsewhere', async () => {
        const { ana, callId } = await connect()

        const other = client('ana')
        other.start()
        await settle()

        expect(other.state).toBe('elsewhere')
        expect(other.call).toMatchObject({ id: callId, held: true })
        expect(other.pc).toBeNull()
        expect(ana.state).toBe('active')
    })

    it('leaves an unheld call alone when told not to resume, as a tab that hands calls to a pop-out', async () => {
        const { ion, callId } = await connect()
        ion.leave()
        ion.stop()

        const main = client('ion', { resumes: false })
        main.start()
        await settle()

        expect(main.state).toBe('elsewhere')
        expect(main.pc).toBeNull()
        expect(server.calls.get(callId).caller_tab).toBeNull()
    })

    it('rings in the pop-out opened to answer and accepts there, while the main tab hands off', async () => {
        const ion = client('ion')
        const main = client('ana', { resumes: false })
        ion.start()
        main.start()
        await ion.callUser('ana')
        await settle()
        expect(main.state).toBe('ringing')

        const popOut = client('ana')
        popOut.resumeCall(main.call.id, { answer: true })
        main.handOff()
        await settle()

        expect(main.state).toBe('elsewhere')
        // Polls while ICE is still running show as reconnecting until the connection is up.
        expect(popOut.states().slice(0, 2)).toEqual(['ringing', 'connecting'])
        expect(server.calls.get(1)).toMatchObject({ status: 'active', callee_tab: popOut.tab })
        expect(popOut.pc.remoteDescription.type).toBe('offer')
        expect(main.call.held).toBe(true)
    })

    it('ends the pop-out\'s call when the main tab hangs up from the chip', async () => {
        const { ion, callId } = await connect()
        const chip = client('ion', { resumes: false })
        chip.start()
        await settle()
        expect(chip.state).toBe('elsewhere')

        await chip.hangUp()
        await settle()

        expect(server.calls.get(callId).status).toBe('ended')
        expect(ion.state).toBe('idle')
        expect(ion.events('ended')[0].reason).toBe('hung_up')
    })

    it('stops polling when stopped', async () => {
        const ion = client('ion')
        ion.start()
        await settle()
        const polls = server.log.length

        ion.stop()
        await settle(500)

        expect(server.log.length).toBe(polls)
    })
})
