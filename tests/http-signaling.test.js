import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpSignaling } from '../src/index.js'

const routes = {
    poll: '/calls/poll',
    store: '/calls',
    answer: '/calls/__ID__/answer',
    decline: '/calls/__ID__/decline',
    hangup: '/calls/__ID__/hangup',
    signal: '/calls/__ID__/signals',
    leave: '/calls/__ID__/leave',
}

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

describe('HttpSignaling', () => {
    let fetchFn
    let signaling

    beforeEach(() => {
        fetchFn = vi.fn(async () => ok({}))
        signaling = new HttpSignaling({ routes, headers: { 'X-CSRF-TOKEN': 'csrf' }, beaconFields: { _token: 'csrf' }, fetch: fetchFn })
    })

    afterEach(() => vi.unstubAllGlobals())

    it('posts JSON with the extra headers and same-origin credentials', async () => {
        fetchFn.mockResolvedValueOnce(ok({ id: 7, status: 'ringing' }, 201))

        await expect(signaling.start('42', 'tab-a')).resolves.toEqual({ id: 7, status: 'ringing' })

        const [url, init] = fetchFn.mock.calls[0]
        expect(url).toBe('/calls')
        expect(init.method).toBe('POST')
        expect(init.credentials).toBe('same-origin')
        expect(init.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': 'csrf' })
        expect(JSON.parse(init.body)).toEqual({ callee: '42', tab: 'tab-a' })
    })

    it('puts the call id into per-call routes, URL-encoded', async () => {
        await signaling.answer('a/b', 'tab')
        await signaling.decline(3)
        await signaling.hangup(4)
        await signaling.send(5, 'ice', { candidate: 'c' })

        expect(fetchFn.mock.calls.map(([url]) => url)).toEqual(['/calls/a%2Fb/answer', '/calls/3/decline', '/calls/4/hangup', '/calls/5/signals'])
        expect(JSON.parse(fetchFn.mock.calls[3][1].body)).toEqual({ type: 'ice', payload: { candidate: 'c' } })
    })

    it('polls with the cursor and only the query fields that are set', async () => {
        await signaling.poll()
        await signaling.poll({ after: 12, call: 3, tab: 'win', hold: true })

        expect(fetchFn.mock.calls[0][0]).toBe('/calls/poll?after=0')
        expect(fetchFn.mock.calls[0][1].method).toBe('GET')
        expect(fetchFn.mock.calls[0][1].body).toBeUndefined()
        expect(fetchFn.mock.calls[1][0]).toBe('/calls/poll?after=12&call=3&tab=win&hold=1')
    })

    it('throws the server message with the HTTP status on a failed request', async () => {
        fetchFn.mockResolvedValueOnce(ok({ message: 'This person is on another call.' }, 409))

        await expect(signaling.start('42', 'tab')).rejects.toMatchObject({ message: 'This person is on another call.', status: 409 })
    })

    it('falls back to a generic message when the error body is not JSON', async () => {
        fetchFn.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new SyntaxError('bad json') } })

        await expect(signaling.poll()).rejects.toMatchObject({ message: 'GET /calls/poll?after=0 failed (500)', status: 500 })
    })

    it('leaves with a beacon carrying the tab and the extra form fields', () => {
        const sendBeacon = vi.fn(() => true)
        vi.stubGlobal('navigator', { sendBeacon })

        signaling.leave(9, 'tab-z')

        expect(sendBeacon).toHaveBeenCalledTimes(1)
        const [url, body] = sendBeacon.mock.calls[0]
        expect(url).toBe('/calls/9/leave')
        expect(body).toBeInstanceOf(FormData)
        expect(body.get('tab')).toBe('tab-z')
        expect(body.get('_token')).toBe('csrf')
        expect(fetchFn).not.toHaveBeenCalled()
    })

    it('falls back to a keepalive fetch when the beacon is refused', () => {
        vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) })

        signaling.leave(9, 'tab-z')

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const [url, init] = fetchFn.mock.calls[0]
        expect(url).toBe('/calls/9/leave')
        expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' })
        expect(init.body.get('tab')).toBe('tab-z')
    })

    it('does nothing on leave when the backend has no leave route', () => {
        const sendBeacon = vi.fn(() => true)
        vi.stubGlobal('navigator', { sendBeacon })
        const { leave, ...withoutLeave } = routes

        new HttpSignaling({ routes: withoutLeave, fetch: fetchFn }).leave(9, 'tab')

        expect(sendBeacon).not.toHaveBeenCalled()
        expect(fetchFn).not.toHaveBeenCalled()
    })

    it('uses the global fetch when none is given', async () => {
        const globalFetch = vi.fn(async () => ok({ cursor: 0 }))
        vi.stubGlobal('fetch', globalFetch)

        await expect(new HttpSignaling({ routes }).poll()).resolves.toEqual({ cursor: 0 })
        expect(globalFetch).toHaveBeenCalledTimes(1)
    })
})

describe('HttpSignaling for groups', () => {
    let fetchFn

    beforeEach(() => {
        fetchFn = vi.fn(async () => ok({}))
    })

    it('rings a group with `callees` and one person with `callee`', async () => {
        const signaling = new HttpSignaling({ routes, fetch: fetchFn })

        await signaling.start('42', 'tab-a')
        await signaling.start(['42', '43'], 'tab-a')

        expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ callee: '42', tab: 'tab-a' })
        expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ callees: ['42', '43'], tab: 'tab-a' })
    })

    it('addresses a signal to one participant when told to, and to everyone otherwise', async () => {
        const signaling = new HttpSignaling({ routes, fetch: fetchFn })

        await signaling.send(5, 'state', { muted: true })
        await signaling.send(5, 'offer', { sdp: 'v=0' }, '43')

        expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ type: 'state', payload: { muted: true } })
        expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ type: 'offer', payload: { sdp: 'v=0' }, to: '43' })
    })

    it('invites through the route when there is one, and has no invite otherwise', async () => {
        const without = new HttpSignaling({ routes, fetch: fetchFn })
        expect(without.invite).toBeUndefined()

        const signaling = new HttpSignaling({ routes: { ...routes, invite: '/calls/__ID__/invite' }, fetch: fetchFn })
        await signaling.invite(7, '43')

        expect(fetchFn.mock.calls[0][0]).toBe('/calls/7/invite')
        expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ callee: '43' })
    })
})
