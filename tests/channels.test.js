import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient, drain } from '../src/index.js'
import { FakeDataChannel, FakeRTCPeerConnection, FakeServer, installBrowserGlobals } from './fakes.js'

let server
let devices

beforeEach(() => {
    vi.useFakeTimers()
    devices = installBrowserGlobals()
    server = new FakeServer().name('agent', 'Ana').name('guest:1', 'Visitor')
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

function client(user, options = {}) {
    const instance = new CallClient({ signaling: server.clientFor(user), poll: { idle: 100, active: 50 }, ...options })
    instance.channelsOpened = []
    instance.addEventListener('datachannel', (event) => instance.channelsOpened.push(event.detail))

    return instance
}

/** An assist call made on the server (the way Session Replay does) and answered by the visitor. */
async function assist(options = {}) {
    const agent = client('agent', { media: 'none', channels: ['assist'], ...options })
    const guest = client('guest:1', { media: 'none', channels: ['assist'], ...options })
    const call = await server.clientFor('agent').start('guest:1', agent.tab, 'assist')
    await server.clientFor('guest:1').answer(call.id, guest.tab)
    agent.start()
    guest.start()
    await settle(400)

    return { agent, guest, callId: call.id }
}

describe('a call without media', () => {
    it('connects over a data channel without asking for the camera or the microphone', async () => {
        const { agent, guest } = await assist()

        expect(devices.getUserMedia).not.toHaveBeenCalled()
        // The caller (the lower seat) offers, so it opens the channel; the offer goes out without any track.
        const channel = agent.link.channels.get('assist')
        expect(channel).toBeInstanceOf(FakeDataChannel)
        expect(channel.options).toEqual({ ordered: true })
        expect(agent.pc.senders).toHaveLength(0)
        expect(guest.link.settled).toBe(true)

        channel.open()
        guest.pc.receiveChannel('assist')

        expect(agent.channelsOpened.map((opened) => [opened.label, opened.peer.id])).toEqual([['assist', 'guest:1']])
        expect(guest.channelsOpened.map((opened) => [opened.label, opened.peer.id])).toEqual([['assist', 'agent']])
        expect(agent.channel('assist')).toBe(channel)
        expect(guest.channel('assist', 'agent').label).toBe('assist')
        expect(channel.bufferedAmountLowThreshold).toBe(1024 * 1024)
    })

    it('starts the microphone mid-call and sends it on every connection', async () => {
        const { agent, guest } = await assist()

        await agent.startMedia('audio')

        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
        expect(agent.pc.senders.map((sender) => sender.track.kind)).toEqual(['audio'])
        expect(agent.localStream.getAudioTracks()).toHaveLength(1)

        // Going to video replaces the microphone rather than doubling it.
        await agent.startMedia('video')
        expect(agent.cameraStream.getTracks().map((track) => track.kind)).toEqual(['audio', 'video'])
        expect(agent.pc.senders.map((sender) => sender.track.kind)).toEqual(['audio', 'video'])
        expect(agent.pc.senders.every((sender) => sender.track.readyState === 'live')).toBe(true)

        // Asking again for less changes nothing.
        await agent.startMedia('audio')
        expect(devices.getUserMedia).toHaveBeenCalledTimes(2)
        expect(guest.cameraStream).toBeNull()
    })

    it('opens the channel again on the fresh connection after a reload', async () => {
        const { agent, guest } = await assist()
        const before = agent.link.channels.get('assist')

        guest.destroy()
        server.tick(10)
        const again = client('guest:1', { media: 'none', channels: ['assist'] })
        again.start()
        await settle(400)

        expect(before.readyState).toBe('closed')
        // The fresh page offers now, so it opens the channel.
        expect(again.link.channels.get('assist')).toBeInstanceOf(FakeDataChannel)
        expect(again.link.polite).toBe(false)
    })

    it('passes the transport policy to every connection', async () => {
        const { agent } = await assist({ iceTransportPolicy: 'relay' })

        expect(agent.pc.configuration.iceTransportPolicy).toBe('relay')
    })
})

describe('kinds', () => {
    it('lets a window that polls for calls never hear of an assist call', async () => {
        const widget = new CallClient({ signaling: { ...server.clientFor('guest:1'), poll: (query) => server.clientFor('guest:1').poll({ ...query, kind: 'call' }) }, poll: { idle: 100, active: 50 } })
        const incoming = vi.fn()
        widget.addEventListener('incoming', incoming)
        widget.start()

        await server.clientFor('agent').start('guest:1', 'a-tab', 'assist')
        await settle(300)

        expect(incoming).not.toHaveBeenCalled()
        expect(widget.state).toBe('idle')
    })
})

describe('drain', () => {
    it('waits for the buffer to come down before the next large message', async () => {
        const channel = new FakeDataChannel('assist')
        channel.open()
        channel.bufferedAmountLowThreshold = 10

        await drain(channel)
        channel.bufferedAmount = 50
        let done = false
        drain(channel).then(() => { done = true })
        await Promise.resolve()
        expect(done).toBe(false)

        channel.drained()
        await Promise.resolve()
        expect(done).toBe(true)
    })
})
