/**
 * Which Folio's room is on screen, for the sidebar's binder. The value is kept here, not only announced, so a binder
 * that mounts later (the sidebar was collapsed while the room stayed open, then reopened) reads it instead of missing the event.
 */
export const ROOM_ON_SCREEN_EVENT = 'writeflex:folio-room-on-screen'

let current: string | null = null

/** The folder of the room now on screen, or null when none is. */
export function roomOnScreen(): string | null { return current }

/** A room appeared (its folder) or left (null). */
export function announceRoom(dir: string | null): void {
  current = dir
  window.dispatchEvent(new CustomEvent<string | null>(ROOM_ON_SCREEN_EVENT, { detail: dir }))
}
