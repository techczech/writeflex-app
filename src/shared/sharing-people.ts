/** Owner-only People projection; credentials stay in main until Copy link is requested. */
export type SharePerson = { id: string; name: string; email: string; status: 'on' | 'off'; createdAt: number; openedAt: number | null; openCount: number; commentCount: number }
export type PeopleState = { people: SharePerson[]; plainLink: boolean }
export type PeopleChange = { name: string; email: string } | { id: string; status: 'on' | 'off' } | { id: string; remove: true } | { id: string; reissue: true } | { plainLink: boolean }
export type PeopleResult = { ok: true; state: PeopleState } | { ok: false; problem: string }
