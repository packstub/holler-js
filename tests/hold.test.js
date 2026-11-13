import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient, HttpSignaling } from '../src/index.js'
import { FakeServer, installBrowserGlobals } from './fakes.js'

const EVENTS = ['statechange', 'incoming', 'update', 'peers', 'peerjoined', 'peerleft', 'peerheld', 'held', 'ended', 'error']

let server

beforeEach(() => {
    vi.useFakeTimers()
    installBrowserGlobals()
    server = new FakeServer().name('ion', 'Ion').name('ana', 'Ana').name('mihai', 'Mihai').name('dana', 'Dana')
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
    instance.states = () => instance.events('statechange').map((event) => event.state)

    return instance
}

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

const connectAll = (...clients) => {
    for (const instance of clients) for (const link of instance.topology?.links.values() ?? []) link.pc.setConnectionState('connected')
}

/** Two people in a running call, the media flowing. */
async function talking(a, b) {
    await a.callUser(b.signaling === undefined ? b : b.user)
    await settle()
    await b.accept()
    await settle()
    connectAll(a, b)
    await settle()
}

function people(...users) {
    const clients = users.map((user) => Object.assign(client(user), { user }))
    for (const instance of clients) instance.start()

    return clients
}

describe('a call on hold', () => {
    it('steps out of the call without ending it: the camera closes here, the other side waits', async () => {
        const [ion, ana] = people('ion', 'ana')
        await talking(ion, ana)
        const callId = ion.call.id
        const camera = ion.cameraStream.getTracks()

        expect(ion.canHold()).toBe(true)
        const held = await ion.hold()
        await settle()

        expect(held).toMatchObject({ id: callId, on_hold: true, joined: false })
        expect(ion.state).toBe('idle')
        expect(ion.call).toBeNull()
        expect(ion.topology).toBeNull()
        expect(camera.every((track) => track.readyState === 'ended')).toBe(true)
        expect(ion.heldCall).toMatchObject({ id: callId, peer: { name: 'Ana' } })
        expect(ion.events('held').at(-1).call.id).toBe(callId)
        // Not an ending, for either of them.
        expect(ion.events('ended')).toEqual([])
        expect(ana.events('ended')).toEqual([])

        expect(ana.state).toBe('waiting')
        expect(ana.peers[0]).toMatchObject({ id: 'ion', status: 'on_hold', connected: false })
        expect(ana.topology.links.size).toBe(0)
        expect(ana.events('peerheld')).toEqual([expect.objectContaining({ onHold: true })])

        // However long it takes: waiting is not a lost connection.
        await settle(5000)
        expect(ana.state).toBe('waiting')
        expect(ana.events('ended')).toEqual([])
    })

    it('comes back with a fresh connection, like a page after a reload', async () => {
        const [ion, ana] = people('ion', 'ana')
        await talking(ion, ana)
        const callId = ion.call.id
        await ion.hold()
        await settle()

        await ion.resumeHeld()
        await settle()

        expect(ion.heldCall).toBeNull()
        expect(ion.call.id).toBe(callId)
        expect(ion.cameraStream).not.toBeNull()
        expect(server.participant(callId, 'ion')).toMatchObject({ status: 'joined', tab: ion.tab })
        // Ana was told to start over, and has a new connection for the new offer.
        expect(ana.events('peerheld').at(-1)).toMatchObject({ onHold: false })
        expect(ana.topology.links.size).toBe(1)

        connectAll(ion, ana)
        await settle()

        expect(ion.state).toBe('active')
        expect(ana.state).toBe('active')
        expect(ion.events('ended')).toEqual([])
    })

    it('gives someone coming back as long as their camera prompt takes', async () => {
        const [ion, ana] = people('ion', 'ana')
        await talking(ion, ana)
        await ion.hold()
        await settle()

        // The browser asks again after a hold, and the person takes their time (the timeout is 1 s here).
        const camera = ion.getUserMedia
        let allow
        ion.getUserMedia = (constraints) => new Promise((resolve) => { allow = () => resolve(camera(constraints)) })
        const back = ion.resumeHeld()
        await settle(5000)

        expect(ana.peers[0]).toMatchObject({ id: 'ion', status: 'joined', alive: true })
        expect(ana.events('ended')).toEqual([])
        expect(ana.call).not.toBeNull()

        allow()
        await back
        await settle()
        connectAll(ion, ana)
        await settle()

        expect(ion.state).toBe('active')
        expect(ana.state).toBe('active')
        expect(ana.events('ended')).toEqual([])
    })

    it('still drops someone whose window went away during that prompt', async () => {
        const [ion, ana] = people('ion', 'ana')
        await talking(ion, ana)
        await ion.hold()
        await settle()

        ion.getUserMedia = () => new Promise(() => {})
        ion.resumeHeld()
        await settle(500)
        // The tab is closed with the prompt open: its polls stop.
        ion.stop()
        server.tick(10)
        await settle(1500)

        expect(ana.state).toBe('idle')
        expect(ana.events('ended')).toHaveLength(1)
    })

    it('starts the clock once they are back with their media', async () => {
        const [ion, ana] = people('ion', 'ana')
        await talking(ion, ana)
        await ion.hold()
        await settle()

        await ion.resumeHeld()
        await settle()
        // Their reset arrived, but no path between the browsers this time.
        expect(ana.peers[0].connected).toBe(false)
        await settle(1500)

        // Whoever's timer runs out first hangs up: the call ends for both.
        expect(ana.events('ended')).toHaveLength(1)
        expect(ion.events('ended')).toHaveLength(1)
    })

    it('rings someone else meanwhile, and swaps the two calls on resume', async () => {
        const [ion, ana, mihai] = people('ion', 'ana', 'mihai')
        await talking(ion, ana)
        const first = ion.call.id

        await ion.hold()
        await talking(ion, mihai)
        const second = ion.call.id

        expect(second).not.toBe(first)
        expect(ion.state).toBe('active')
        expect(ion.heldCall.id).toBe(first)
        expect(server.calls.get(first).status).toBe('active')
        // One call on hold at a time.
        expect(ion.canHold()).toBe(false)

        await ion.resumeHeld()
        await settle()
        connectAll(ion, ana)
        await settle()

        expect(ion.call.id).toBe(first)
        expect(ion.state).toBe('active')
        expect(ion.heldCall.id).toBe(second)
        expect(mihai.state).toBe('waiting')
        expect(ana.state).toBe('active')
        expect(ion.events('ended')).toEqual([])
    })

    it('learns that the call on hold ended, and can end it without coming back', async () => {
        const [ion, ana] = people('ion', 'ana')
        await talking(ion, ana)
        await ion.hold()
        await settle()

        await ana.hangUp()
        await settle()

        expect(ion.heldCall).toBeNull()
        expect(ion.events('held').at(-1)).toMatchObject({ call: null })
        expect(ion.state).toBe('idle')

        await talking(ion, ana)
        const callId = ion.call.id
        await ion.hold()
        await settle()
        await ion.endHeld()
        await settle()

        expect(ion.heldCall).toBeNull()
        expect(server.calls.get(callId)).toMatchObject({ status: 'ended', end_reason: 'hung_up' })
        expect(ana.state).toBe('idle')
    })

    it('shows every window of mine the call on hold, and lets go of the call in the window that ran it', async () => {
        const popOut = Object.assign(client('ion'), { user: 'ion' })
        const page = client('ion', { resumes: false })
        const ana = Object.assign(client('ana'), { user: 'ana' })
        for (const instance of [popOut, page, ana]) instance.start()
        await talking(popOut, ana)
        await settle()
        const callId = popOut.call.id

        expect(page.state).toBe('elsewhere')

        // From the page that only watches: the window that runs the call lets go of it.
        await page.hold()
        await settle()

        expect(page.state).toBe('idle')
        expect(popOut.state).toBe('idle')
        expect(popOut.cameraStream).toBeNull()
        expect(page.heldCall.id).toBe(callId)
        expect(popOut.heldCall.id).toBe(callId)
        expect(popOut.events('ended')).toEqual([])

        // Resumed from the page: the server has me back in, and a window that runs calls picks it up.
        await page.resumeHeld()
        await settle()

        expect(page.heldCall).toBeNull()
        expect(server.participant(callId, 'ion').status).toBe('joined')
        expect(popOut.call?.id).toBe(callId)
        expect(page.state).toBe('elsewhere')
    })

    it('keeps a group call going around someone on hold', async () => {
        const [ion, ana, mihai] = people('ion', 'ana', 'mihai')
        await ion.callUser(['ana', 'mihai'])
        await settle()
        await ana.accept()
        await mihai.accept()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()

        await ion.hold()
        await settle()

        expect(ana.state).toBe('active')
        expect(mihai.state).toBe('active')
        expect(ana.peers.find((peer) => peer.id === 'ion').status).toBe('on_hold')
        expect(ana.topology.links.has('ion')).toBe(false)
        expect(ana.topology.links.has('mihai')).toBe(true)

        await ion.resumeHeld()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()

        expect(ion.state).toBe('active')
        expect(ion.topology.links.size).toBe(2)
        expect(ana.peers.find((peer) => peer.id === 'ion')).toMatchObject({ status: 'joined', connected: true })
    })

    it('refuses to hold a call that only rings, and says so when the backend cannot hold', async () => {
        const [ion] = people('ion', 'ana')
        await ion.callUser('ana')
        await settle()

        expect(ion.canHold()).toBe(false)
        await expect(ion.hold()).rejects.toThrow('No call to put on hold.')

        const plain = new CallClient({ signaling: new HttpSignaling({ routes: { poll: '/poll', store: '/', answer: '/__ID__/answer', decline: '/__ID__/decline', hangup: '/__ID__/hangup', signal: '/__ID__/signals' } }) })
        expect(plain.signaling.hold).toBeUndefined()
        expect(plain.signaling.people).toBeUndefined()
        expect(plain.canHold()).toBe(false)
        expect(await plain.search('a')).toEqual([])
    })
})

describe('people to add', () => {
    it('finds people by what was typed, without the ones on the call', async () => {
        const [ion, ana] = people('ion', 'ana')

        expect((await ion.search('')).map((person) => person.name)).toEqual(['Ana', 'Dana', 'Mihai'])
        expect(await ion.search('an')).toEqual([{ id: 'ana', name: 'Ana', avatar: null }, { id: 'dana', name: 'Dana', avatar: null }])

        await talking(ion, ana)

        expect((await ion.search('an')).map((person) => person.name)).toEqual(['Dana'])
        expect(server.log.at(-1)).toEqual(['ion', 'people', 'an', ion.call.id])
    })

    it('asks the people route with the words and the call', async () => {
        const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ people: [] }) }))
        const signaling = new HttpSignaling({ fetch, routes: { poll: '/calls/poll', store: '/calls', answer: '/calls/__ID__/answer', decline: '/calls/__ID__/decline', hangup: '/calls/__ID__/hangup', signal: '/calls/__ID__/signals', hold: '/calls/__ID__/hold', resume: '/calls/__ID__/resume', people: '/calls/people' } })

        await signaling.people('ana p', 7)
        await signaling.hold(7)
        await signaling.resume(7, 'tab-1')

        expect(fetch.mock.calls.map(([url, options]) => [options.method, url, options.body])).toEqual([
            ['GET', '/calls/people?q=ana+p&call=7', undefined],
            ['POST', '/calls/7/hold', undefined],
            ['POST', '/calls/7/resume', JSON.stringify({ tab: 'tab-1' })],
        ])
    })
})
