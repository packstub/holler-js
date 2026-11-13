import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient, rateConnection } from '../src/index.js'
import { FakeMediaStream, FakeServer, FakeTrack, installBrowserGlobals } from './fakes.js'

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

function client(user, options = {}) {
    const instance = new CallClient({ signaling: server.clientFor(user), poll: { idle: 100, active: 50 }, reconnectTimeout: 1000, statsInterval: 500, ...options })
    instance.log = []
    for (const type of ['statechange', 'ended', 'error', 'quality', 'devices', 'localstream']) {
        instance.addEventListener(type, (event) => instance.log.push({ type, ...event.detail }))
    }
    instance.events = (type) => instance.log.filter((event) => event.type === type)

    return instance
}

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

async function connect(options = {}) {
    const ion = client('ion', options.ion)
    const ana = client('ana', options.ana)
    ion.start()
    ana.start()

    await ion.callUser('ana')
    await settle()
    await ana.accept()
    await settle()

    if (options.network !== false) {
        ion.pc.setConnectionState('connected')
        ana.pc.setConnectionState('connected')
        await settle()
    }

    return { ion, ana }
}

describe('devices', () => {
    it('lists the microphones, cameras and speakers that have an id, with what is chosen', async () => {
        const ion = client('ion', { devices: { microphone: 'mic-2' } })

        expect(await ion.devices()).toEqual({
            microphones: [{ id: 'mic-1', label: 'Built-in microphone' }, { id: 'mic-2', label: 'Headset' }],
            cameras: [{ id: 'cam-1', label: 'Built-in camera' }, { id: 'cam-2', label: 'External camera' }],
            speakers: [{ id: 'out-1', label: 'Speakers' }],
            selected: { microphone: 'mic-2', camera: null, speaker: null },
        })
    })

    it('lists nothing where the browser cannot say', async () => {
        const ion = client('ion', { enumerateDevices: async () => { throw new Error('no') } })

        expect(await ion.devices()).toMatchObject({ microphones: [], cameras: [], speakers: [] })
    })

    it('starts a call with the chosen microphone and camera', async () => {
        const ion = client('ion', { devices: { microphone: 'mic-2', camera: 'cam-2' } })
        ion.start()
        await ion.callUser('ana')

        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-2' } }, video: { deviceId: { exact: 'cam-2' } } })
    })

    it('falls back to the system devices when a chosen one is gone', async () => {
        devices.getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' }) })
        const ion = client('ion', { devices: { camera: 'unplugged' } })
        ion.start()
        await ion.callUser('ana')

        expect(devices.getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: true })
        expect(ion.state).toBe('calling')
        expect(ion.localStream.getVideoTracks()).toHaveLength(1)
    })

    it('remembers a choice made outside a call for the next one, and says so', async () => {
        const ion = client('ion')
        await ion.setDevice('microphone', 'mic-2')
        await ion.setDevice('speaker', 'out-1')

        expect(devices.getUserMedia).not.toHaveBeenCalled()
        expect(ion.selected).toEqual({ microphone: 'mic-2', camera: null, speaker: 'out-1' })
        expect(ion.events('devices').at(-1).selected).toEqual({ microphone: 'mic-2', camera: null, speaker: 'out-1' })
        await expect(ion.setDevice('headphones', 'x')).rejects.toThrow('Unknown device kind')
    })

    it('swaps the microphone during a call without renegotiating, keeping the mute', async () => {
        const { ion } = await connect()
        ion.setMuted(true)
        const sender = ion.pc.getSenders().find((candidate) => candidate.track.kind === 'audio')
        const old = sender.track
        const senders = ion.pc.getSenders().length

        await ion.setDevice('microphone', 'mic-2')
        await settle()

        expect(devices.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-2' } }, video: false })
        expect(old.readyState).toBe('ended')
        expect(sender.track).not.toBe(old)
        expect(sender.track.enabled).toBe(false)
        expect(ion.pc.getSenders()).toHaveLength(senders)
        expect(ion.localStream.getAudioTracks()).toEqual([sender.track])
        expect(ion.cameraStream.getAudioTracks()).toEqual([sender.track])
    })

    it('swaps the camera during a call, and leaves a shared screen on the wire', async () => {
        const { ion } = await connect()
        const sender = ion.pc.getSenders().find((candidate) => candidate.track.kind === 'video')

        await ion.setDevice('camera', 'cam-2')
        const second = ion.cameraStream.getVideoTracks()[0]
        expect(sender.track).toBe(second)

        await ion.shareScreen()
        const screen = sender.track
        expect(screen.label).toBe('screen')

        await ion.setDevice('camera', 'cam-1')
        expect(sender.track).toBe(screen)

        await ion.stopSharing()
        expect(sender.track).toBe(ion.cameraStream.getVideoTracks()[0])
        expect(sender.track).not.toBe(second)
    })

    it('goes back to the device that worked when the new one cannot be opened', async () => {
        const { ion } = await connect({ ion: { devices: { microphone: 'mic-1' } } })
        devices.getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('busy'), { name: 'NotReadableError' }) })

        await expect(ion.setDevice('microphone', 'mic-2')).rejects.toThrow('busy')

        expect(ion.selected.microphone).toBe('mic-1')
        expect(devices.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-1' } }, video: false })
        expect(ion.cameraStream.getAudioTracks()[0].readyState).toBe('live')
        expect(ion.events('error').at(-1).media).toBe(true)
    })

    it('drops a track that arrives after the call ended', async () => {
        const { ion } = await connect()
        const late = new FakeTrack('audio', 'late')
        let release
        devices.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new FakeMediaStream([late])) }))

        const switching = ion.setDevice('microphone', 'mic-2')
        await ion.hangUp()
        release()
        await switching

        expect(late.readyState).toBe('ended')
        expect(ion.cameraStream).toBeNull()
    })
})

describe('connection quality', () => {
    const report = ({ rtt = 0.04, lost = 0, received = 1000, relay = false } = {}) => [
        { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
        { id: 'P', type: 'candidate-pair', currentRoundTripTime: rtt, localCandidateId: 'L', remoteCandidateId: 'R' },
        { id: 'L', type: 'local-candidate', candidateType: relay ? 'relay' : 'srflx' },
        { id: 'R', type: 'remote-candidate', candidateType: 'host' },
        { id: 'A', type: 'inbound-rtp', kind: 'audio', packetsLost: lost, packetsReceived: received, jitter: 0.01 },
    ]

    it('puts a connection in a word', () => {
        expect(rateConnection({ rtt: 40, loss: 0 })).toBe('good')
        expect(rateConnection({ rtt: 320, loss: 0 })).toBe('fair')
        expect(rateConnection({ rtt: 40, loss: 0.04 })).toBe('fair')
        expect(rateConnection({ rtt: 700, loss: 0 })).toBe('poor')
        expect(rateConnection({ rtt: null, loss: 0.2 })).toBe('poor')
        expect(rateConnection()).toBe('good')
    })

    it('measures each connection while the call runs and says when its word changes', async () => {
        const { ion } = await connect()
        expect(ion.quality).toBeNull()

        ion.pc.report = report()
        await settle(600)
        expect(ion.quality).toBe('good')
        expect(ion.peer.quality).toBe('good')
        expect(ion.events('quality')).toHaveLength(1)
        expect(ion.events('quality')[0]).toMatchObject({ quality: 'good', rtt: 40, loss: 0, relayed: false, jitter: 0.01 })

        // Nothing new to say while it stays good.
        ion.pc.report = report({ received: 2000 })
        await settle(600)
        expect(ion.events('quality')).toHaveLength(1)

        // 100 lost of the 1000 packets since the last look.
        ion.pc.report = report({ received: 2900, lost: 100, relay: true })
        await settle(600)
        expect(ion.quality).toBe('poor')
        expect(ion.events('quality').at(-1)).toMatchObject({ quality: 'poor', loss: 0.1, relayed: true })
    })

    it('forgets the word while the connection is down, and stops measuring after the call', async () => {
        const { ion } = await connect()
        ion.pc.report = report()
        await settle(600)
        const pc = ion.pc
        const getStats = vi.spyOn(pc, 'getStats')

        pc.setConnectionState('disconnected')
        expect(ion.peer.quality).toBeNull()

        await ion.hangUp()
        getStats.mockClear()
        await settle(2000)
        expect(getStats).not.toHaveBeenCalled()
    })

    it('measures on demand, and not at all with statsInterval 0', async () => {
        const { ion } = await connect({ ion: { statsInterval: 0 } })
        ion.pc.report = report({ rtt: 0.4 })
        await settle(2000)
        expect(ion.quality).toBeNull()

        const results = await ion.measure()
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ quality: 'fair', rtt: 400 })
        expect(results[0].peer.id).toBe('ana')
    })
})

describe('a call that never connects', () => {
    it('reads a quick hang-up before the media flowed as a hang-up', async () => {
        const { ion, ana } = await connect({ network: false })
        await ana.hangUp()
        await settle()

        expect(ion.events('ended').at(-1).reason).toBe('hung_up')
    })

    it('stays connecting, ends as failed and points the developer at TURN', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { ion, ana } = await connect({ network: false, ion: { iceServers: [{ urls: 'stun:stun.example.com' }] }, ana: { iceServers: [{ urls: 'stun:stun.example.com' }] } })

        await settle(500)
        expect(ion.state).toBe('connecting')

        await settle(1000)
        expect(ion.state).toBe('idle')
        // Whoever's timer ran out first hung up; the other side reads that as the same failure.
        expect(ion.events('ended').at(-1).reason).toBe('failed')
        expect(ana.events('ended').at(-1).reason).toBe('failed')
        // Once in each browser's console: the side that gave up, and the side told so by the server.
        expect(warn).toHaveBeenCalledTimes(2)
        expect(warn.mock.calls[0][0]).toContain('no TURN server is configured')
    })

    const turn = { iceServers: [{ urls: ['stun:s.example.com', 'turn:t.example.com:3478'], username: 'u', credential: 'c' }] }
    const iceError = (client, detail) => client.pc.dispatchEvent(Object.assign(new Event('icecandidateerror'), detail))

    it('says the TURN server refused the credentials when it did', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { ion } = await connect({ network: false, ion: turn, ana: turn })
        // A STUN server's error says nothing about the relay, and the first word per server is kept.
        iceError(ion, { url: 'stun:s.example.com', errorCode: 701, errorText: 'STUN host lookup received error.' })
        iceError(ion, { url: 'turn:t.example.com:3478', errorCode: 401, errorText: 'Unauthorized' })
        iceError(ion, { url: 'turn:t.example.com:3478', errorCode: 701, errorText: 'TURN allocate request timed out.' })

        await settle(1500)
        expect(ion.events('ended').at(-1).reason).toBe('failed')
        const lines = warn.mock.calls.map((call) => call[0])
        expect(lines.filter((line) => line.includes('refused the credentials'))).toHaveLength(1)
        expect(lines.find((line) => line.includes('refused'))).toContain('turn:t.example.com:3478 refused the credentials (401 Unauthorized)')
    })

    it('says the TURN server could not be reached when it never answered', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { ion } = await connect({ network: false, ion: turn, ana: turn })
        iceError(ion, { url: 'turn:t.example.com:3478', errorCode: 701, errorText: 'TURN allocate request timed out.' })

        await settle(1500)
        expect(warn.mock.calls.map((call) => call[0])).toContainEqual(expect.stringContaining('turn:t.example.com:3478 could not be reached (TURN allocate request timed out.)'))
    })

    it('forgets the errors of a call that connected anyway', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { ion, ana } = await connect({ ion: turn, ana: turn })
        iceError(ion, { url: 'turn:t.example.com:3478', errorCode: 401, errorText: 'Unauthorized' })
        await ion.hangUp()
        await settle()

        expect(ion.iceErrors.size).toBe(0)
        expect(ana.events('ended').at(-1).reason).toBe('hung_up')
        expect(warn).not.toHaveBeenCalled()
    })

    it('says nothing about TURN when one is configured', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const turn = { iceServers: [{ urls: ['stun:s.example.com', 'turns:t.example.com:443?transport=tcp'], username: 'u', credential: 'c' }] }
        const { ion } = await connect({ network: false, ion: turn, ana: turn })

        await settle(1500)
        expect(ion.events('ended').at(-1).reason).toBe('failed')
        expect(warn).not.toHaveBeenCalled()
    })

    it('still ends as dropped once the media has flowed', async () => {
        const { ion, ana } = await connect()
        ion.pc.setConnectionState('failed')
        ana.pc.setConnectionState('failed')
        await settle(100)
        expect(ion.state).toBe('reconnecting')

        await settle(1500)
        expect(ion.events('ended').at(-1).reason).toBe('dropped')
    })
})
