import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient, HttpSignaling } from '../src/index.js'
import { FakeRTCPeerConnection, FakeServer, installBrowserGlobals } from './fakes.js'

const EVENTS = ['statechange', 'incoming', 'ended', 'error', 'localstream']

let server
let devices

beforeEach(() => {
    vi.useFakeTimers()
    devices = installBrowserGlobals()
    server = new FakeServer().name('ion', 'Ion').name('ana', 'Ana').name('mihai', 'Mihai')
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

function client(user, options = {}) {
    const instance = new CallClient({ signaling: server.clientFor(user), poll: { idle: 100, active: 50 }, reconnectTimeout: 1000, ...options })
    instance.log = []
    for (const type of EVENTS) instance.addEventListener(type, (event) => instance.log.push({ type, ...event.detail }))
    instance.events = (type) => instance.log.filter((event) => event.type === type)

    return instance
}

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

describe('a poll in flight', () => {
    it('is not applied after a decline: the call does not ring again', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        await ion.callUser('ana')

        // Ana's poll is sent (the call rings her) and answered only after she declined.
        let release
        const signaling = server.clientFor('ana')
        const poll = signaling.poll
        ana.signaling = { ...signaling, poll: (query) => new Promise((resolve) => { release = () => resolve(poll(query)) }) }
        ana.start()
        await settle(10)
        await ana.handlePoll(await poll({ tab: ana.tab }))
        expect(ana.state).toBe('ringing')

        const pending = ana.inFlight
        await ana.decline()
        release()
        await pending
        await settle(0)

        expect(ana.state).toBe('idle')
        expect(ana.events('incoming')).toHaveLength(1)
    })
})

describe('double clicks', () => {
    it('asks for the camera once and answers once when Accept is clicked twice', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()

        await Promise.all([ana.accept(), ana.accept()])
        await settle()

        expect(devices.getUserMedia).toHaveBeenCalledTimes(2) // Ion's and Ana's
        expect(server.log.filter(([user, action]) => user === 'ana' && action === 'answer')).toHaveLength(1)
        expect(['connecting', 'reconnecting']).toContain(ana.state)
        expect(ana.events('error')).toHaveLength(0)
    })

    it('places one call when the call button is clicked twice', async () => {
        const ion = client('ion')
        ion.start()

        const [first, second] = await Promise.all([ion.callUser('ana'), ion.callUser('ana')])

        expect(first).toBe(second)
        expect(server.log.filter(([user, action]) => user === 'ion' && action === 'start')).toHaveLength(1)
        expect(FakeRTCPeerConnection.instances).toHaveLength(1)
    })

    it('closes the old connections when a window joins another call', async () => {
        const ion = client('ion')
        ion.start()
        await ion.callUser('ana')
        const first = ion.pc

        ion.join({ ...ion.call, id: 99 })

        expect(first.closed).toBe(true)
    })
})

describe('prompts', () => {
    it('keeps holding the side while the camera prompt is open in a pop-out', async () => {
        const ion = client('ion')
        ion.start()
        await ion.callUser('ana')

        let allow
        devices.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve }))
        const popOut = client('ana')
        popOut.resumeCall(ion.call.id, { answer: true })
        await settle(400)

        // Every poll while the prompt is open holds the side, so the main tab never takes the call back.
        const polls = server.log.filter(([user, action]) => user === 'ana' && action === 'poll').slice(1)
        expect(polls.length).toBeGreaterThan(3)
        expect(polls.every(([, , , , hold]) => hold === true)).toBe(true)

        const { FakeMediaStream, FakeTrack } = await import('./fakes.js')
        allow(new FakeMediaStream([new FakeTrack('audio')]))
        await settle()
        expect(['connecting', 'reconnecting']).toContain(popOut.state)
    })

    it('shares nothing when the call ended while the screen picker was open', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()

        let pick
        devices.getDisplayMedia.mockImplementationOnce(() => new Promise((resolve) => { pick = resolve }))
        const sharing = ana.shareScreen()
        await ana.hangUp()

        const { FakeMediaStream, FakeTrack } = await import('./fakes.js')
        const screen = new FakeMediaStream([new FakeTrack('video', 'screen')])
        pick(screen)
        await sharing

        expect(screen.getTracks()[0].readyState).toBe('ended')
        expect(ana.sharing).toBe(false)
    })

    it('ends a call that stopped ringing before the answer landed as missed, not as an error', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()

        // Ion gives up on the server just as Ana answers.
        await server.clientFor('ion').hangup(ion.call.id)
        await ana.accept()

        expect(ana.state).toBe('idle')
        expect(ana.events('ended').at(-1)).toMatchObject({ reason: 'missed' })
        expect(ana.events('error')).toHaveLength(0)
    })
})

describe('both pages reload at once', () => {
    it.each([['together', 0], ['the caller first', 60], ['the callee first', -60]])('connects again whoever claims first (%s)', async (_, gap) => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()

        // Two fresh pages, each resuming the call with a reset and an offer.
        ion.destroy()
        ana.destroy()
        server.tick(10)
        const ion2 = client('ion')
        const ana2 = client('ana')
        const [first, second] = gap < 0 ? [ana2, ion2] : [ion2, ana2]
        first.start()
        if (gap) await settle(Math.abs(gap))
        second.start()
        await settle(400)

        expect(ion2.link.settled).toBe(true)
        expect(ana2.link.settled).toBe(true)
        expect(ion2.pc.signalingState).toBe('stable')
        expect(ana2.pc.signalingState).toBe('stable')
        // One side offers, the other answers: never both polite.
        expect(ion2.link.polite && ana2.link.polite).toBe(false)
    })
})

describe('destroy', () => {
    it('lets go of the call and closes the camera and connections without events', async () => {
        const ion = client('ion')
        ion.start()
        await ion.callUser('ana')
        const pc = ion.pc
        const stream = ion.cameraStream
        const before = ion.log.length

        ion.destroy()

        expect(pc.closed).toBe(true)
        expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
        expect(navigator.sendBeacon).not.toHaveBeenCalled() // the fake signaling leaves directly
        expect(server.log.at(-1)).toEqual(['ion', 'leave', 1, ion.tab])
        expect(ion.log.length).toBe(before)
        expect(ion.polling).toBe(false)
    })
})

describe('hidden tabs', () => {
    it('ask for incoming calls less often while hidden, and at once when shown', async () => {
        const doc = Object.assign(new EventTarget(), { hidden: true })
        vi.stubGlobal('document', doc)
        const ion = client('ion', { poll: { idle: 100, active: 50, hidden: 1000 } })
        ion.start()
        await settle(950)
        const polls = () => server.log.filter(([user, action]) => user === 'ion' && action === 'poll').length
        expect(polls()).toBe(1)

        doc.hidden = false
        doc.dispatchEvent(new Event('visibilitychange'))
        await settle(10)
        expect(polls()).toBe(2)
    })
})

describe('HttpSignaling', () => {
    it('gives up a request after the timeout, carries the reason of a refusal and asks for one kind', async () => {
        const fetch = vi.fn(async (url, init) => ({ ok: false, status: 409, json: async () => ({ message: 'This person is on another call.', reason: 'busy' }), init }))
        const signaling = new HttpSignaling({ routes: { poll: '/poll', store: '/calls' }, fetch, timeout: 5000, kind: 'call' })

        await expect(signaling.start('ana', 't')).rejects.toMatchObject({ status: 409, reason: 'busy' })
        expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)

        fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        await signaling.poll({ after: 3 })
        expect(fetch.mock.calls[1][0]).toBe('/poll?after=3&kind=call')
    })
})

describe('review fixes', () => {
    const prompt = () => {
        let allow
        devices.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve }))
        return async () => {
            const { FakeMediaStream, FakeTrack } = await import('./fakes.js')
            const stream = new FakeMediaStream([new FakeTrack('audio')])
            allow(stream)
            return stream
        }
    }

    it('answers a call that rang while placing one, and rings nobody', async () => {
        const ana = client('ana')
        ana.start()
        const allow = prompt()
        const placing = ana.callUser('mihai').catch((error) => error)
        await settle(10)

        await server.clientFor('ion').start('ana', 'ion-tab')
        await settle(150)
        expect(ana.state).toBe('ringing')

        const answering = ana.accept()
        const stream = await allow()
        await answering
        expect(await placing).toBeInstanceOf(Error)

        expect(server.log.filter(([user, action]) => user === 'ana' && action === 'start')).toHaveLength(0)
        expect(server.log.filter(([user, action]) => user === 'ana' && action === 'answer')).toHaveLength(1)
        expect(stream.getTracks()[0].readyState).toBe('live')
    })

    it('closes the camera and rings nobody when the window is destroyed during the prompt', async () => {
        const ion = client('ion')
        ion.start()
        const allow = prompt()
        const placing = ion.callUser('ana').catch((error) => error)
        await settle(10)

        ion.destroy()
        const stream = await allow()
        expect(await placing).toBeInstanceOf(Error)

        expect(stream.getTracks()[0].readyState).toBe('ended')
        expect(server.log.some(([user, action]) => user === 'ion' && action === 'start')).toBe(false)
    })

    it('polls fast while resuming, even hidden: those polls hold the side', async () => {
        const ion = client('ion')
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()
        ana.destroy()
        server.tick(10)

        vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: true }))
        prompt()
        const again = client('ana', { poll: { idle: 100, active: 50, hidden: 5000 } })
        again.start()
        await settle(400)

        expect(again.joining).toBe(true)
        expect(server.log.filter(([user, action, , , hold]) => user === 'ana' && action === 'poll' && hold).length).toBeGreaterThan(4)
    })

    it('puts the camera on the empty video sender a screen share left behind', async () => {
        const ion = client('ion', { video: false })
        const ana = client('ana', { video: false })
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()

        await ion.shareScreen()
        await ion.stopSharing()
        await ion.startMedia('video')

        expect(ion.pc.senders.filter((sender) => sender.__video)).toHaveLength(1)
        expect(ion.pc.senders.find((sender) => sender.__video).track.kind).toBe('video')
    })
})
