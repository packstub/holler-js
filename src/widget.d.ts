// Type declarations for @packstub/holler/widget: the public API the README documents.

import type { CallClient, CallState, DeviceKind, HttpSignalingRoutes, Peer, Signaling, UserId } from './index.js'

/** A view: a function from the view model to an HTML string, kept current through the data-holler-* hooks. */
export type Template<M = WidgetModel> = (model: M) => string

export interface WidgetTemplates {
    incoming: Template
    chip: Template
    window: Template
    tile: Template<TileModel>
    notice: Template
}

export type WidgetLabels = Record<string, string>

export type WidgetIcons = Record<string, string>

export interface WidgetModel {
    labels: WidgetLabels
    icons: WidgetIcons
    state: CallState
    inCall: boolean
    names: string
    status: string
    elapsed: string
    notice: string | null
    peerName: string
    incomingLabel: string
    peerAvatar: string | null
    hasAvatar: boolean
    initials: string
    others: number
    hasOthers: boolean
    othersLabel: string
    muted: boolean
    cameraOff: boolean
    sharing: boolean
    canShare: boolean
    mirror: boolean
    hideLocal: boolean
    localStream: MediaStream | null
    count: number
    spotlight: Peer | null
    strip: 'top' | 'right' | 'none' | null
    muteTitle: string
    cameraTitle: string
    shareTitle: string
    canSettings: boolean
    settingsOpen: boolean
    hasMicrophones: boolean
    hasCameras: boolean
    hasSpeakers: boolean
    canNotify: boolean
    [key: string]: unknown
}

export interface TileModel extends Peer {
    hasVideo: boolean
    initials: string
    hasAvatar: boolean
    ringing: boolean
    connecting: boolean
    showVideo: boolean
    showName: boolean
    cameraOffBadge: boolean
    /** Connected, with a weak connection. */
    poor: boolean
    role: string
    labels: WidgetLabels
    icons: WidgetIcons
    [key: string]: unknown
}

export interface CallWidgetOptions {
    routes?: HttpSignalingRoutes
    csrf?: string
    signaling?: Signaling
    client?: CallClient
    iceServers?: RTCIceServer[]
    video?: boolean
    poll?: { idle?: number, active?: number, hidden?: number }
    reconnectTimeout?: number
    maxParticipants?: number
    iceTransportPolicy?: RTCIceTransportPolicy
    kind?: string
    root?: Element
    windowUrl?: string | null
    popOut?: boolean
    inPopOut?: boolean
    openedFor?: { call?: string | number, callee?: string } | null
    windowFeatures?: string
    callSelector?: string | null
    labels?: Partial<WidgetLabels>
    templates?: Partial<WidgetTemplates>
    icons?: Partial<WidgetIcons>
    startPolling?: boolean
    /** The settings button in the call window: microphone, camera, speaker (true). */
    devices?: boolean
    /** A call ringing in a background tab shows in the tab's title, and as a system notification once allowed (true). */
    notifications?: boolean
    /** Where the chosen devices are remembered in localStorage (`holler:devices`); null: not remembered. */
    storageKey?: string | null
}

export class CallWidget extends EventTarget {
    constructor(options?: CallWidgetOptions)

    readonly client: CallClient
    labels: WidgetLabels
    templates: WidgetTemplates
    icons: WidgetIcons
    readonly state: CallState
    readonly peers: Peer[]
    readonly muted: boolean
    readonly cameraOff: boolean
    readonly sharing: boolean

    start(): void
    destroy(): void
    callUser(user: UserId): Promise<void> | void
    accept(): Promise<void> | void
    decline(): Promise<void>
    hangUp(): Promise<void>
    add(user: UserId): Promise<void>
    toggleMute(): void
    toggleCamera(): void
    toggleShare(): Promise<void>
    toggleSettings(): void
    setDevice(kind: DeviceKind, id: string | null): Promise<void>
    refreshDevices(): Promise<void>
    /** Whether the person can still be asked to allow system notifications. */
    readonly canNotify: boolean
    /** Ask for system notifications; call it from a click. */
    enableNotifications(): Promise<NotificationPermission>
    show(text: string): void
    announce(text: string): void

    model(): WidgetModel
    tileModel(peer: Peer, spotlight?: Peer | null): TileModel
    render(): void
    renderTiles(spotlight?: Peer | null): void
    placeStrip(width: number, height: number): void
}

export const labels: WidgetLabels
export const templates: WidgetTemplates
export const icons: WidgetIcons

/** Applies the data-holler-* hooks of a piece of markup to the model. */
export function patch(root: Element, model: Record<string, unknown>): void
/** Puts a stream on a video element, playing it muted until the page has had a click when the browser asks for one. */
export function attachStream(video: HTMLVideoElement, stream: MediaStream | null): void
/** Fills in `:name` placeholders in a label. */
export function fill(label: string, values: Record<string, string | number>): string
/** Escapes text for HTML you write in a template of your own. */
export function escape(text: unknown): string
/** The URL when it is safe for an `<img src>` (http(s), relative, blob:, data:image/), else null. */
export function safeUrl(value: unknown, options?: { svg?: boolean }): string | null
