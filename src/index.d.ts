// Type declarations for @packstub/holler: the public API the README documents.
// Methods the README marks as internal are left out on purpose.

export type UserId = string | number

export type CallState = 'idle' | 'calling' | 'ringing' | 'connecting' | 'active' | 'reconnecting' | 'waiting' | 'elsewhere'

export type EndReason = 'declined' | 'cancelled' | 'missed' | 'hung_up' | 'failed' | 'dropped' | 'busy'

export type ParticipantStatus = 'ringing' | 'joined' | 'on_hold' | 'left' | 'declined' | 'missed' | 'dropped'

export type SignalType = 'offer' | 'answer' | 'ice' | 'reset' | 'state'

export type MediaKind = 'video' | 'audio' | 'none'

export type ConnectionQuality = 'good' | 'fair' | 'poor'

export type DeviceKind = 'microphone' | 'camera' | 'speaker'

/** The chosen devices by id; null is the system default. */
export type SelectedDevices = Record<DeviceKind, string | null>

export interface DeviceOption {
    id: string
    /** Empty until the person has allowed the camera or the microphone. */
    label: string
}

export interface DeviceList {
    microphones: DeviceOption[]
    cameras: DeviceOption[]
    /** Empty where the browser cannot pick a speaker. */
    speakers: DeviceOption[]
    selected: SelectedDevices
}

/** How a connection is doing: the round trip in milliseconds, the share of packets lost since the last look, the jitter in seconds, whether a TURN relay carries it. */
export interface ConnectionStats {
    rtt: number | null
    loss: number
    jitter: number | null
    relayed: boolean
    quality: ConnectionQuality
}

/** Another participant as the server describes them. */
export interface CallPeer {
    id: string
    name: string
    avatar: string | null
    seat: number
    status: ParticipantStatus
    held?: boolean
    seen_ago?: number | null
}

/** Someone the people search found. */
export interface Person {
    id: string
    name: string
    avatar: string | null
}

/** A call as the server returns it from `poll`, `start`, `answer` and the rest. */
export interface Call {
    id: string | number
    kind?: string
    status: 'ringing' | 'active' | 'ended'
    end_reason: string | null
    role: 'caller' | 'callee'
    seat?: number
    joined?: boolean
    /** I put this call on hold: still on it, away until I resume. */
    on_hold?: boolean
    peers?: CallPeer[]
    answered_at: string | null
    held?: boolean
    peer?: CallPeer | null
    peer_held?: boolean
    peer_seen_ago?: number | null
    [key: string]: unknown
}

export interface Signal {
    id: number
    call: string | number
    type: SignalType | string
    payload: Record<string, unknown>
    from?: string
}

export interface PollResult {
    call: Call | null
    incoming: Call | null
    /** The call I put on hold, if any. */
    on_hold?: Call | null
    signals: Signal[]
    cursor: number
}

export interface RtcConfiguration {
    iceServers: RTCIceServer[]
    iceTransportPolicy?: RTCIceTransportPolicy
}

/** A failed signaling request: `status` is the HTTP status, `reason` the server's word for it. */
export interface SignalingError extends Error {
    status?: number
    reason?: 'busy' | 'not_ringing' | 'not_allowed' | 'full' | 'ended' | 'too_large' | 'too_many' | 'invalid_response' | string
}

/** What a signaling backend implements; `HttpSignaling` maps it onto Holler for Laravel's routes. */
export interface Signaling {
    start(callees: UserId | UserId[], tab: string): Promise<Call>
    answer(callId: Call['id'], tab: string): Promise<Call>
    decline(callId: Call['id']): Promise<Call>
    hangup(callId: Call['id']): Promise<Call>
    invite?(callId: Call['id'], userId: UserId): Promise<Call>
    hold?(callId: Call['id']): Promise<Call>
    resume?(callId: Call['id'], tab?: string | null): Promise<Call>
    people?(query?: string, callId?: Call['id'] | null): Promise<{ people: Person[] } | Person[]>
    send(callId: Call['id'], type: SignalType | string, payload: Record<string, unknown>, to?: UserId | null): Promise<unknown>
    poll(options: { after?: number, call?: Call['id'] | null, tab?: string | null, hold?: boolean, kind?: string | null }): Promise<PollResult>
    leave?(callId: Call['id'], tab: string): void
    configuration?(): Promise<RtcConfiguration>
}

export interface HttpSignalingRoutes {
    poll: string
    store: string
    answer: string
    decline: string
    hangup: string
    signal: string
    leave?: string
    invite?: string
    hold?: string
    resume?: string
    people?: string
    ice?: string
}

export interface HttpSignalingOptions {
    routes: HttpSignalingRoutes
    headers?: Record<string, string>
    beaconFields?: Record<string, string>
    kind?: string | null
    timeout?: number
    fetch?: typeof fetch
}

export class HttpSignaling implements Signaling {
    constructor(options: HttpSignalingOptions)
    /** Sent with every request; change it to carry a fresh CSRF token. */
    headers: Record<string, string>
    routes: HttpSignalingRoutes
    kind: string | null
    start(callees: UserId | UserId[], tab: string): Promise<Call>
    answer(callId: Call['id'], tab: string): Promise<Call>
    decline(callId: Call['id']): Promise<Call>
    hangup(callId: Call['id']): Promise<Call>
    invite(callId: Call['id'], userId: UserId): Promise<Call>
    hold(callId: Call['id']): Promise<Call>
    resume(callId: Call['id'], tab?: string | null): Promise<Call>
    people(query?: string, callId?: Call['id'] | null): Promise<{ people: Person[] }>
    send(callId: Call['id'], type: SignalType | string, payload: Record<string, unknown>, to?: UserId | null): Promise<unknown>
    poll(options?: { after?: number, call?: Call['id'] | null, tab?: string | null, hold?: boolean, kind?: string | null }): Promise<PollResult>
    leave(callId: Call['id'], tab: string): void
    configuration(): Promise<RtcConfiguration>
}

/** A participant on the roster: what the server says, what they told us, what the topology gives. */
export interface Peer {
    id: string
    name: string
    avatar: string | null
    seat: number
    status: ParticipantStatus
    alive: boolean
    connected: boolean
    /** Null until the connection is measured, and while it is down. */
    quality: ConnectionQuality | null
    muted: boolean
    cameraOff: boolean
    sharing: boolean
    stream: MediaStream | null
}

/** What a topology may use from the client. */
export interface TopologyHost {
    iceServers: RTCIceServer[]
    iceTransportPolicy: RTCIceTransportPolicy
    channelLabels: string[]
    readonly seat: number
    localSource(): MediaStream | null
    send(type: string, payload: Record<string, unknown>, to?: string | null): void
    remoteStreamFrom(peer: Peer, stream: MediaStream): void
    connectionChanged(peer: Peer, connected: boolean): void
    negotiated(peer: Peer): void
    emit(type: 'error', detail: { error: unknown }): void
}

/** How media travels between participants: `MeshTopology`, or an SFU adapter of your own. */
export interface Topology {
    attach(client: TopologyHost): void
    join?(call: Call): void
    connect(peer: Peer, options: { polite: boolean, reset?: boolean }): void
    disconnect(peer: Peer): void
    reset?(peer: Peer, payload: Record<string, unknown>): void
    stale?(peer: Peer, payload: Record<string, unknown>): boolean
    signal(peer: Peer | null, type: string, payload: Record<string, unknown>, from?: string): void | Promise<void>
    connected(peer: Peer): boolean
    replaceVideo?(track: MediaStreamTrack | null): void | Promise<void>
    addTracks?(stream: MediaStream): void | Promise<void>
    channel?(peer: Peer, label: string): RTCDataChannel | null
    stats?(peer: Peer): Promise<ConnectionStats | null> | ConnectionStats | null
    leave(): void
}

export class MeshTopology implements Topology {
    constructor()
    attach(client: TopologyHost): void
    connect(peer: Peer, options: { polite: boolean, reset?: boolean }): void
    disconnect(peer: Peer): void
    signal(peer: Peer | null, type: string, payload: Record<string, unknown>, from?: string): Promise<void>
    connected(peer: Peer): boolean
    channel(peer: Peer, label: string): RTCDataChannel | null
    stats(peer: Peer): Promise<ConnectionStats | null> | null
    /** The peer rebuilt their side (a `reset` signal): a new connection, answering theirs. */
    reset(peer: Peer): void
    /** Whether a `state` signal comes from an older connection of the peer's. */
    stale(peer: Peer, payload: Record<string, unknown>): boolean
    /** The screen in place of the camera on every connection (null: nothing). */
    replaceVideo(track: MediaStreamTrack | null): Promise<void> | void
    /** Media turned on during the call: sent to every peer. */
    addTracks(source: MediaStream | null): void
    leave(): void
}

export interface CallClientOptions {
    signaling: Signaling
    iceServers?: RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>)
    video?: boolean
    poll?: { idle?: number, active?: number, hidden?: number }
    media?: MediaKind | null
    channels?: string[]
    iceTransportPolicy?: RTCIceTransportPolicy
    reconnectTimeout?: number
    resumes?: boolean
    maxParticipants?: number
    topology?: Topology | (new () => Topology) | ((call: Call, client: CallClient) => Topology) | null
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
    devices?: Partial<SelectedDevices>
    enumerateDevices?: () => Promise<MediaDeviceInfo[]>
    /** Milliseconds between looks at each connection's quality (3000); 0 turns it off. */
    statsInterval?: number
}

export interface CallClientEventMap {
    statechange: CustomEvent<{ state: CallState }>
    incoming: CustomEvent<{ call: Call }>
    update: CustomEvent<{ call: Call }>
    localstream: CustomEvent<{ stream: MediaStream }>
    remotestream: CustomEvent<{ stream: MediaStream, peer: Peer }>
    peers: CustomEvent<{ peers: Peer[] }>
    peerjoined: CustomEvent<{ peer: Peer }>
    peerleft: CustomEvent<{ peer: Peer, reason: 'left' | 'declined' | 'missed' | 'dropped' }>
    peerstate: CustomEvent<{ peer: Peer, muted: boolean, cameraOff: boolean, sharing: boolean }>
    peerheld: CustomEvent<{ peer: Peer, onHold: boolean }>
    held: CustomEvent<{ call: Call | null }>
    datachannel: CustomEvent<{ peer: Peer, channel: RTCDataChannel, label: string }>
    quality: CustomEvent<{ peer: Peer } & ConnectionStats>
    devices: CustomEvent<{ selected: SelectedDevices }>
    ended: CustomEvent<{ call: Call | null, reason: EndReason | string }>
    error: CustomEvent<{ error: SignalingError | Error, media?: boolean }>
}

export class CallClient extends EventTarget {
    constructor(options: CallClientOptions)

    readonly state: CallState
    readonly call: Call | null
    /** The call I put on hold, from any window of mine. */
    readonly heldCall: Call | null
    readonly peers: Peer[]
    readonly peer: Peer | null
    readonly localStream: MediaStream | null
    readonly cameraStream: MediaStream | null
    readonly screenStream: MediaStream | null
    readonly muted: boolean
    readonly cameraOff: boolean
    readonly sharing: boolean
    readonly tab: string
    readonly peerMuted: boolean
    readonly peerCameraOff: boolean
    readonly peerSharing: boolean
    readonly remoteStream: MediaStream | null
    readonly selected: SelectedDevices
    /** The worst connection among the peers; null before anything is measured. */
    readonly quality: ConnectionQuality | null

    start(): void
    stop(): void
    destroy(): void
    callUser(users: UserId | UserId[]): Promise<Call>
    accept(): Promise<void>
    decline(): Promise<void>
    invite(userId: UserId): Promise<Call>
    canInvite(): boolean
    /** Step out of the call without leaving it; `resumeHeld()` comes back. */
    hold(): Promise<Call>
    canHold(): boolean
    resumeHeld(): Promise<Call | null>
    endHeld(): Promise<void>
    /** Who can be added to the call I am in (or rung) for what was typed. */
    search(query?: string): Promise<Person[]>
    hangUp(): Promise<void>
    setMuted(muted: boolean): void
    setCameraOff(off: boolean): void
    shareScreen(): Promise<void>
    stopSharing(): Promise<void>
    startMedia(kind?: 'audio' | 'video'): Promise<MediaStream | null>
    channel(label: string, peerId?: string | null): RTCDataChannel | null
    devices(): Promise<DeviceList>
    setDevice(kind: DeviceKind, id: string | null): Promise<void>
    measure(): Promise<Array<{ peer: Peer } & ConnectionStats>>
    resumeCall(callId?: Call['id'] | null, options?: { answer?: boolean }): void
    handOff(): void
    takeOver(): Promise<boolean>
    leave(): void

    addEventListener<K extends keyof CallClientEventMap>(type: K, listener: (event: CallClientEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
    removeEventListener<K extends keyof CallClientEventMap>(type: K, listener: (event: CallClientEventMap[K]) => void, options?: boolean | EventListenerOptions): void
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void
}

/** Resolves once the channel's send buffer has room again; await it before each large message. */
export function drain(channel: RTCDataChannel): Promise<void>
/** A connection in a word, from its round trip (ms) and the share of packets lost. */
export function rateConnection(stats?: { rtt?: number | null, loss?: number | null }): ConnectionQuality
