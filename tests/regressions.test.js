import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient } from '../src/index.js'
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

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)
const client = (user, options = {}) => new CallClient({ signaling: server.clientFor(user), poll: { idle: 100, active: 50 }, ...options })

async function voiceCall() {
    const ion = client('ion', { video: false })
    const ana = client('ana', { video: false })
    ion.start()
    ana.start()
    await ion.callUser('ana')
    await settle(300)
    await ana.accept()
    await settle(500)
    for (const instance of [ion, ana]) for (const link of instance.topology?.links.values() ?? []) link.pc.setConnectionState('connected')
    await settle()

    return { ion, ana }
}

describe('a voice call going to video', () => {
    it('keeps the microphone in use reachable while the camera prompt is open: a mute lands on it, a hang-up turns it off', async () => {
        const { ion } = await voiceCall()
        const microphone = ion.cameraStream.getAudioTracks()[0]
        let allow
        devices.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve }))

        const started = ion.startMedia('video')
        await settle(0)

        ion.setMuted(true)
        expect(microphone.enabled).toBe(false)

        await ion.hangUp()
        expect(microphone.readyState).toBe('ended')

        const late = new FakeMediaStream([new FakeTrack('audio'), new FakeTrack('video')])
        allow(late)
        await expect(started).rejects.toThrow()
        expect(late.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
        expect(ion.cameraStream).toBeNull()
    })

    it('replaces the microphone with the new stream once the camera is allowed', async () => {
        const { ion } = await voiceCall()
        const microphone = ion.cameraStream.getAudioTracks()[0]

        const stream = await ion.startMedia('video')

        expect(ion.cameraStream).toBe(stream)
        expect(stream.getVideoTracks()).toHaveLength(1)
        expect(microphone.readyState).toBe('ended')
    })
})

describe('hold and resume pressed twice', () => {
    it('sends one request each, and no refusal over a call that is back', async () => {
        const { ion } = await voiceCall()
        const errors = []
        ion.addEventListener('error', (event) => errors.push(event.detail.error))

        await Promise.all([ion.hold(), ion.hold()])
        await settle(200)
        expect(ion.heldCall).not.toBeNull()

        const [first, second] = await Promise.allSettled([ion.resumeHeld(), ion.resumeHeld()])
        await settle(500)

        expect(first.status).toBe('fulfilled')
        expect(second.status).toBe('fulfilled')
        expect(errors).toEqual([])
        expect(ion.heldCall).toBeNull()
        expect(ion.call).not.toBeNull()
    })
})

describe('signals a backend relays badly', () => {
    it('reads a null payload as an empty one', async () => {
        const { ion } = await voiceCall()

        await expect(ion.handleSignal({ type: 'state', payload: null, from: 'ana' })).resolves.toBeUndefined()
        expect(ion.peer.muted).toBe(false)
    })

    it('answers an offer from someone on the call it has no connection to', async () => {
        const { ion } = await voiceCall()
        const ana = ion.roster.get('ana')
        ion.topology.disconnect(ana)
        expect(ion.topology.links.has('ana')).toBe(false)

        await ion.handleSignal({ type: 'offer', payload: { description: { type: 'offer', sdp: 'v=0\r\n' } }, from: 'ana' })

        expect(ion.topology.links.has('ana')).toBe(true)
    })
})

describe('the people search', () => {
    it('says why through an error when the backend refuses', async () => {
        const { ion } = await voiceCall()
        const errors = []
        ion.addEventListener('error', (event) => errors.push(event.detail.error))
        ion.signaling.people = () => Promise.reject(Object.assign(new Error('Too many requests.'), { status: 429 }))

        await expect(ion.search('a')).rejects.toThrow('Too many requests.')
        expect(errors).toHaveLength(1)
    })
})
