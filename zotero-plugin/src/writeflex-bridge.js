/*
 * WriteFlex for Zotero: the logic behind the three endpoints.
 *
 * WriteFlex (a separate desktop app) keeps the highlights made in its Reading Room in a local queue and
 * sends each one here, to Zotero's own local HTTP server, one change at a time. This file decides what
 * happens to each change and saves it through Zotero's own item code, inside one Zotero database
 * transaction:
 *
 *   any     the PDF is open in a Zotero reader tab, or Zotero is syncing -> retry later (nothing written)
 *   create  key free                         -> create the annotation under that key
 *           resend, that key holds this mark on this document, unchanged -> confirmed
 *           resend, that key holds this mark on this document, changed   -> conflict
 *           key held by anything else        -> conflict `key-in-use`: WriteFlex picks a new key
 *   update  stored row (type included) == baseline -> write only the fields that changed
 *           stored row != baseline           -> conflict: Zotero changed it since WriteFlex showed it
 *           resend and Zotero already shows the change -> confirmed
 *   delete  stored row (type included) == baseline, and its tags and `clientDateModified` are the
 *           ones the reader was shown (when WriteFlex knows them) -> erase it
 *           anything else                    -> conflict
 *           resend and the annotation is gone -> confirmed
 *
 * The key WriteFlex proposes is the mark's identity: a create never moves to another key here, so a
 * resend can only ever adopt the annotation at that exact key.
 *
 * Never re-parents an annotation, never writes tags, writes only to the personal library, never saves
 * an item another part of Zotero is in the middle of changing (`hasChanged()` -> retry), and never lets
 * its own save or erase swallow an edit made in Zotero while it ran (`saveKeepingEdits`, `erase`).
 *
 * The third endpoint reads one attachment's annotations, so WriteFlex can show what Zotero holds now.
 *
 * Every request is signed by WriteFlex and every answer is signed here, with the key both hold
 * (HMAC-SHA256); the key itself never travels. Requests other than the ping also carry this run's
 * session id under the signature, so a request captured before Zotero restarted is refused after it.
 * See `authenticate` and `signedAnswer`.
 *
 * Plain script, no Node APIs: the build bundles it into the plugin's `bootstrap.js`, and the WriteFlex
 * unit tests load it with `require` against a fake Zotero object.
 */
/* global module */
var WriteFlexZotero = (function () {
  'use strict';

  const PROTOCOL = 3;
  const PING_PATH = '/writeflex/ping';
  const ANNOTATIONS_PATH = '/writeflex/annotations';
  const READ_PATH = '/writeflex/annotations/read';
  /** Request headers (Zotero's server lower-cases names). */
  const TIMESTAMP_HEADER = 'x-writeflex-timestamp';
  const NONCE_HEADER = 'x-writeflex-nonce';
  const SIGNATURE_HEADER = 'x-writeflex-signature';
  const SESSION_HEADER = 'x-writeflex-session';
  /** The answer's signature header. */
  const RESPONSE_SIGNATURE_HEADER = 'X-WriteFlex-Signature';
  /** A request is accepted only this close to the plugin's clock, and its nonce only once. */
  const SIGNATURE_WINDOW_MS = 60000;
  const MAX_REMEMBERED_NONCES = 10000;
  const NONCE_PATTERN = /^[0-9a-f]{32}$/;
  const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
  const TIMESTAMP_PATTERN = /^\d{1,16}$/;
  const SESSION_PATTERN = /^[0-9a-f]{32}$/;
  /** Zotero's object-key alphabet and length (`Zotero.DataObjectUtilities`). */
  const KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
  const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
  /** `Zotero.Annotations.DEFAULT_COLOR`. */
  const DEFAULT_COLOUR = '#ffd400';
  /** `Zotero.Annotations.ANNOTATION_TYPE_*`. */
  const TYPE_NAMES = { 1: 'highlight', 2: 'note', 3: 'image', 4: 'ink', 5: 'underline', 6: 'text' };
  const TYPES = ['highlight', 'note', 'image', 'ink', 'underline', 'text'];
  /** Types whose `text` comes from the reader (`Zotero.Annotations.saveFromJSON`). */
  const TEXT_TYPES = ['highlight', 'underline'];
  /** The PDF sort-index shape the `annotationSortIndex` setter accepts for a PDF parent. */
  const PDF_SORT_INDEX = /^\d{5}\|\d{6}\|\d{5}$/;
  const FIELDS = ['text', 'comment', 'color', 'pageLabel', 'sortIndex', 'position'];
  const AREA_QUOTATION_FORM = /^Quoted in ".+" — \d{1,2} [A-Za-z]+ \d{4}$/;
  const MAX_AREA_QUOTATION_BYTES = 4096;
  const MAX_AREA_COMMENT_BYTES = 2048;

  const REASONS = {
    protocol: 'This version of the WriteFlex plugin does not match this version of WriteFlex. Update both and try again.',
    malformed: 'This change was not in a form the WriteFlex plugin accepts, so nothing was written.',
    library: 'That Zotero library is not on this computer, so nothing was written.',
    readOnly: 'That Zotero library is read-only, so nothing was written.',
    group: 'Highlights are only written to your own library, not to a shared group library. This highlight is kept in WriteFlex.',
    parentMissing: 'The document this highlight belongs to is no longer in Zotero, so nothing was written.',
    parentNotPdf: 'In Zotero the document this highlight belongs to is not a PDF, so nothing was written.',
    gone: 'This highlight is no longer in your Zotero library, so the change was not written.',
    notAnnotation: 'In Zotero that key belongs to something that is not a highlight, so the change was not written.',
    otherDocument: 'In Zotero this highlight belongs to a different document, so the change was not written.',
    external: 'This mark is stored inside the PDF file rather than in Zotero, so it is not changed from here.',
    otherType: 'In Zotero this mark is a different kind of annotation, so the change was not written.',
    changedSinceEdit: 'This highlight was changed in Zotero after you last saw it here, so your change was not written over it. Your version is kept here.',
    changedSinceDelete: 'This highlight was changed in Zotero after you last saw it here, so it was not deleted. Your deletion is kept here.',
    unverifiedDelete: 'WriteFlex could not tell whether this highlight was changed in Zotero since you last saw it here, so it was not deleted. Your deletion is kept here.',
    imagePosition: 'Moving or resizing a marked region is not written to Zotero yet, so this change is kept here.',
    inkColour: 'Recolouring a drawing is not written to Zotero yet, so this change is kept here.',
    imageDelete: 'Deleting a marked region or a drawing is not written to Zotero yet. Delete it in Zotero itself.',
    saving: 'Zotero is saving this highlight; trying again shortly.',
    busy: 'Zotero is busy; trying again shortly.',
    keyInUse: 'Zotero already uses this highlight\'s key for something else, so nothing was written under it.',
    changedSinceSend: 'An earlier attempt to send this highlight was cut off, and Zotero now holds a different version of it, so it was not written again. Your version is kept here.',
    openInZotero: 'Open in Zotero; sent when the PDF is closed there.',
    syncing: 'Zotero is syncing; sent when it has finished.',
    changedWhileDeleting: 'This highlight was changed in Zotero while WriteFlex was deleting it, so it was not deleted. Your deletion is kept here.',
    changedWhileSaving: 'This highlight was changed in Zotero while WriteFlex was saving it, and Zotero\'s newer version is kept. Your version is kept here.',
    areaForm: 'The Area quotation record was not in the accepted form.',
    areaTooLong: 'The Area quotation record was too long.',
    areaMissing: 'The matching Zotero Area annotation could not be found, so its quotation was not recorded.',
    areaNoRoom: 'The existing Zotero comment leaves no safe room for this quotation record.',
  };

  /**
   * The one database read the decisions rest on. Read inside the transaction, from the database and not
   * from Zotero's in-memory item cache: a reader save waiting behind this transaction may already have
   * changed the cached item's fields.
   */
  const ITEM_ROW_SQL =
    'SELECT I.itemID AS itemID, IA.itemID AS annotationID, P.key AS parentKey, IA.type AS type, '
    + 'IA.text AS text, IA.comment AS comment, IA.color AS color, IA.pageLabel AS pageLabel, '
    + 'IA.sortIndex AS sortIndex, IA.position AS position, IA.isExternal AS isExternal, '
    + 'I.clientDateModified AS modified '
    + 'FROM items I LEFT JOIN itemAnnotations IA ON IA.itemID = I.itemID '
    + 'LEFT JOIN items P ON P.itemID = IA.parentItemID '
    + 'WHERE I.libraryID = ? AND I.key = ?';

  /** One item's tags, for the deletion check (a tag change is a saved change the field compare cannot see). */
  const ITEM_TAGS_SQL =
    'SELECT tag.name AS name FROM itemTags AS itemTag JOIN tags AS tag ON tag.tagID = itemTag.tagID '
    + 'WHERE itemTag.itemID = ? ORDER BY tag.name';

  // -------------------------------------------------------------------------------------------------
  // Requests: headers, token, shape
  // -------------------------------------------------------------------------------------------------

  /** Strict string equality whose running time does not depend on where the strings differ. */
  function constantTimeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    let difference = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
  }

  function header(headers, name) {
    if (!headers) return undefined;
    const value = headers[name];
    return value === undefined || value === null ? undefined : String(value);
  }

  /**
   * True for anything a web page could send. Zotero's server already drops requests with an `Origin`
   * header or a browser user agent unless they carry a connector header, and pages on zotero.org may
   * send `Zotero-Allowed-Request`; this endpoint refuses all of them, connector header or not.
   */
  function fromBrowser(headers) {
    if (!headers) return false;
    if (header(headers, 'origin') !== undefined) return true;
    if (header(headers, 'zotero-allowed-request') !== undefined) return true;
    if (header(headers, 'x-zotero-connector-api-version') !== undefined) return true;
    const agent = header(headers, 'user-agent');
    return agent !== undefined && agent.startsWith('Mozilla/');
  }

  function json(status, body) {
    return [status, 'application/json', JSON.stringify(body)];
  }

  // -------------------------------------------------------------------------------------------------
  // Signatures: HMAC-SHA256 with the shared key, through Web Crypto (`crypto.subtle`)
  // -------------------------------------------------------------------------------------------------

  function hex(buffer) {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function bytesOfHex(text) {
    const bytes = new Uint8Array(text.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(text.substr(index * 2, 2), 16);
    return bytes;
  }

  async function sha256Hex(subtle, text) {
    return hex(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  }

  async function hmacHex(subtle, token, message) {
    const key = await subtle.importKey('raw', bytesOfHex(token), { hash: 'SHA-256', name: 'HMAC' }, false, ['sign']);
    return hex(await subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  }

  /** What a request's signature covers. WriteFlex builds the same string. `session` is '' when absent. */
  function requestMessage(method, path, timestamp, nonce, session, bodyHash) {
    return ['WriteFlex-Request-3', method, path, timestamp, nonce, session, bodyHash].join('\n');
  }

  /** What an answer's signature covers: its status, the request's nonce, and the body's hash. */
  function responseMessage(status, nonce, bodyHash) {
    return ['WriteFlex-Response-3', String(status), nonce, bodyHash].join('\n');
  }

  function subtleOf(context) {
    return (context.crypto || crypto).subtle;
  }

  function nowOf(context) {
    return context.now ? context.now() : Date.now();
  }

  /** A refusal: never signed, so it can never be taken for an answer. */
  function refused(message) {
    return [403, 'application/json', JSON.stringify({ error: message })];
  }

  /**
   * Check a request: not from a browser, signed with the key over its method, path, timestamp, nonce,
   * session id and body, within the time window, and not seen before. Returns `{ nonce }`, `{ refusal }`,
   * or `{ nonce, stale: true }` when it is signed but names another session than this run's (only when
   * `requireSession`): that answer is signed, so WriteFlex can trust it and re-ping. The nonce is
   * remembered only once the signature checks out, so nobody without the key can fill the memory.
   */
  async function authenticate(request, context, path, body, requireSession) {
    if (fromBrowser(request.headers)) return { refusal: refused('Requests from web pages are not accepted.') };
    const token = context.token;
    const timestamp = header(request.headers, TIMESTAMP_HEADER);
    const nonce = header(request.headers, NONCE_HEADER);
    const signature = header(request.headers, SIGNATURE_HEADER);
    const session = header(request.headers, SESSION_HEADER);
    if (!TOKEN_PATTERN.test(token || '') || !TIMESTAMP_PATTERN.test(timestamp || '')
      || !NONCE_PATTERN.test(nonce || '') || !SIGNATURE_PATTERN.test(signature || '')
      || (session !== undefined && !SESSION_PATTERN.test(session))) {
      return { refusal: refused('This request was not signed with the WriteFlex key.') };
    }
    const now = nowOf(context);
    if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS) {
      return { refusal: refused('This request was signed too long ago, or the clocks disagree.') };
    }
    const subtle = subtleOf(context);
    const message = requestMessage(request.method, path, timestamp, nonce, session || '', await sha256Hex(subtle, body));
    const expected = await hmacHex(subtle, token, message);
    if (!constantTimeEqual(expected, signature)) {
      return { refusal: refused('This request was not signed with the WriteFlex key.') };
    }
    const nonces = context.nonces || (context.nonces = new Map());
    for (const [seen, expiry] of nonces) if (expiry < now) nonces.delete(seen);
    if (nonces.has(nonce)) return { refusal: refused('This request was already received once.') };
    if (nonces.size >= MAX_REMEMBERED_NONCES) return { refusal: refused('Too many requests; try again shortly.') };
    nonces.set(nonce, now + 2 * SIGNATURE_WINDOW_MS);
    if (requireSession && !(SESSION_PATTERN.test(context.sessionId || '') && constantTimeEqual(session || '', context.sessionId))) {
      return { nonce, stale: true };
    }
    return { nonce };
  }

  /** The signed answer to a request from another run of the plugin: WriteFlex re-pings and resends. */
  function staleSession(context, nonce) {
    return signedAnswer(context, nonce, 401, { error: 'stale-session', sessionId: context.sessionId });
  }

  /** An answer signed for the request it answers: `[status, headers, body]` for Zotero's server. */
  async function signedAnswer(context, nonce, status, value) {
    const body = JSON.stringify(value);
    const subtle = subtleOf(context);
    const signature = await hmacHex(subtle, context.token, responseMessage(status, nonce, await sha256Hex(subtle, body)));
    return [status, { 'Content-Type': 'application/json', [RESPONSE_SIGNATURE_HEADER]: signature }, body];
  }

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function optionalString(value) {
    return value === null || value === undefined || typeof value === 'string';
  }

  function validPosition(position) {
    if (typeof position !== 'string') return false;
    try {
      const parsed = JSON.parse(position);
      return isRecord(parsed) && typeof parsed.pageIndex === 'number' && Number.isFinite(parsed.pageIndex);
    } catch (error) {
      return false;
    }
  }

  function fieldsFrom(value, requireType) {
    if (!isRecord(value)) return null;
    if (requireType && !TYPES.includes(value.type)) return null;
    if (
      typeof value.sortIndex !== 'string'
      || !validPosition(value.position)
      || !optionalString(value.text)
      || !optionalString(value.comment)
      || !optionalString(value.color)
      || !optionalString(value.pageLabel)
    ) return null;
    const fields = {
      color: value.color ?? null,
      comment: value.comment ?? null,
      pageLabel: value.pageLabel ?? null,
      position: value.position,
      sortIndex: value.sortIndex,
      text: value.text ?? null,
    };
    if (requireType) fields.type = value.type;
    // What Zotero held beyond the fields when the reader was shown the mark: its tags, and the item's
    // `clientDateModified` (Zotero bumps it on every saved change, tags included). Optional: absent
    // when WriteFlex does not know it.
    if (value.zoteroState !== undefined) {
      const state = value.zoteroState;
      if (!isRecord(state) || !Array.isArray(state.tags) || !state.tags.every((tag) => typeof tag === 'string')
        || state.tags.length > 1000 || !optionalString(state.modified)) return null;
      fields.zoteroState = { modified: state.modified ?? null, tags: state.tags.slice() };
    }
    return fields;
  }

  /**
   * One operation off the wire, checked field by field. Returns `{ operation }` or `{ outcome }` (a
   * rejection, or a protocol mismatch carrying `status: 409`).
   */
  function parseOperation(data) {
    if (!isRecord(data)) return { outcome: rejected(REASONS.malformed) };
    if (data.protocol !== PROTOCOL) return { outcome: Object.assign(rejected(REASONS.protocol), { status: 409 }) };
    const kind = data.operation;
    if (kind !== 'create' && kind !== 'update' && kind !== 'delete') return { outcome: rejected(REASONS.malformed) };
    if (!Number.isSafeInteger(data.libraryId) || data.libraryId <= 0) return { outcome: rejected(REASONS.malformed) };
    if (typeof data.parentItemKey !== 'string' || !KEY_PATTERN.test(data.parentItemKey)) {
      return { outcome: rejected(REASONS.malformed) };
    }
    if (typeof data.itemKey !== 'string' || (kind !== 'create' && !KEY_PATTERN.test(data.itemKey))) {
      return { outcome: rejected(REASONS.malformed) };
    }
    if (data.resend !== undefined && typeof data.resend !== 'boolean') return { outcome: rejected(REASONS.malformed) };
    const superseded = data.supersededKey;
    if (superseded !== undefined && superseded !== null && (typeof superseded !== 'string' || !KEY_PATTERN.test(superseded))) {
      return { outcome: rejected(REASONS.malformed) };
    }
    const operation = {
      itemKey: data.itemKey,
      kind,
      libraryId: data.libraryId,
      parentItemKey: data.parentItemKey,
      resend: data.resend === true,
      supersededKey: superseded || null,
    };
    if (kind === 'update' && data.areaQuotation !== undefined) {
      if (typeof data.areaQuotation !== 'string') return { outcome: rejected(REASONS.malformed) };
      const quotation = data.areaQuotation.trim();
      if (!AREA_QUOTATION_FORM.test(quotation)) return { outcome: rejected(REASONS.areaForm) };
      if (utf8Length(quotation) > MAX_AREA_QUOTATION_BYTES) return { outcome: rejected(REASONS.areaTooLong) };
      operation.areaQuotation = quotation;
      return { operation };
    }
    if (kind !== 'delete') {
      const payload = fieldsFrom(data.payload, true);
      if (!payload) return { outcome: rejected(REASONS.malformed) };
      const colour = normalisedColour(payload.color);
      if (colour === undefined) return { outcome: rejected(REASONS.malformed) };
      payload.color = colour;
      if (!PDF_SORT_INDEX.test(payload.sortIndex)) return { outcome: rejected(REASONS.malformed) };
      operation.payload = payload;
    }
    if (kind !== 'create') {
      // The before-state carries the annotation type too: the compare covers it (a highlight Zotero
      // turned into an underline is not the mark WriteFlex showed).
      const baseline = fieldsFrom(data.baseline, true);
      if (!baseline) return { outcome: rejected(REASONS.malformed) };
      operation.baseline = baseline;
    }
    return { operation };
  }

  // -------------------------------------------------------------------------------------------------
  // Field comparison, as Zotero stores fields
  // -------------------------------------------------------------------------------------------------

  /** What Zotero's annotation setters store for a string: trimmed, NFC, empty as null. */
  function storedText(value) {
    if (typeof value !== 'string') return null;
    const normalised = value.trim().normalize();
    return normalised === '' ? null : normalised;
  }

  /** A colour as Zotero accepts it (lower-case `#rrggbb`), null for none, undefined when malformed. */
  function normalisedColour(value) {
    if (value === null || value === undefined || value === '') return null;
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value && typeof value === 'object') {
      const sorted = {};
      for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key]);
      return sorted;
    }
    return value;
  }

  /** Structural equality of two JSON strings: key order and whitespace do not count. */
  function sameJson(left, right) {
    try {
      return JSON.stringify(canonicalJson(JSON.parse(left))) === JSON.stringify(canonicalJson(JSON.parse(right)));
    } catch (error) {
      return left === right;
    }
  }

  function sameField(name, left, right) {
    switch (name) {
      case 'position':
        return sameJson(left ?? '', right ?? '');
      case 'color':
        return (String(left || DEFAULT_COLOUR)).toLowerCase() === (String(right || DEFAULT_COLOUR)).toLowerCase();
      case 'sortIndex':
        return (left ?? '') === (right ?? '');
      default:
        return storedText(left) === storedText(right);
    }
  }

  function fieldsOfRow(row) {
    return {
      color: row.color,
      comment: row.comment,
      pageLabel: row.pageLabel,
      position: row.position,
      sortIndex: row.sortIndex,
      text: row.text,
    };
  }

  /** Every field equal, except `text` on types whose text Zotero does not take from the reader. */
  function sameFields(type, left, right) {
    return FIELDS.every((name) =>
      (name === 'text' && !TEXT_TYPES.includes(type)) || sameField(name, left[name], right[name]));
  }

  function utf8Length(value) {
    return new TextEncoder().encode(value).length;
  }

  // -------------------------------------------------------------------------------------------------
  // Outcomes
  // -------------------------------------------------------------------------------------------------

  function confirmed(itemKey) {
    return { itemKey, kind: 'confirmed' };
  }
  function conflict(reason) {
    return { kind: 'conflict', reason };
  }
  /** The proposed key is taken: WriteFlex chooses another and sends the create again. */
  function keyInUse() {
    return { code: 'key-in-use', kind: 'conflict', reason: REASONS.keyInUse };
  }
  function rejected(reason) {
    return { kind: 'rejected', reason };
  }
  function retry(reason) {
    return { kind: 'retry', reason };
  }

  // -------------------------------------------------------------------------------------------------
  // Decisions (pure: a stored row and an operation in, a decision out)
  // -------------------------------------------------------------------------------------------------

  /** The checks every update and delete share: the key names an annotation of THIS document. */
  function targetProblem(row, operation) {
    if (!row) return null;
    if (row.annotationID === null || row.annotationID === undefined) return rejected(REASONS.notAnnotation);
    if (row.parentKey !== operation.parentItemKey) return rejected(REASONS.otherDocument);
    if (row.isExternal) return rejected(REASONS.external);
    return null;
  }

  /**
   * True when the stored annotation at a create's key is exactly the mark the create carries: type,
   * position, text (for types that have it), comment and colour. How a resend recognises the mark its
   * earlier, cut-off send already made at that key.
   */
  function identicalMark(row, payload) {
    return !row.isExternal
      && TYPE_NAMES[row.type] === payload.type
      && sameField('position', row.position, payload.position)
      && (!TEXT_TYPES.includes(payload.type) || sameField('text', row.text, payload.text))
      && sameField('comment', row.comment, payload.comment)
      && sameField('color', row.color, payload.color);
  }

  /**
   * An edit against the stored row: `{ outcome }` when nothing is to be written, or `{ changed }` with
   * the field names to write.
   */
  function decideUpdate(row, operation) {
    if (!row) return { outcome: rejected(REASONS.gone) };
    const problem = targetProblem(row, operation);
    if (problem) return { outcome: problem };
    const type = TYPE_NAMES[row.type];
    const stored = fieldsOfRow(row);
    if (operation.resend && type === operation.payload.type && sameFields(type, stored, operation.payload)) {
      return { outcome: confirmed(operation.itemKey) };
    }
    if (type !== operation.baseline.type || !sameFields(type, stored, operation.baseline)) {
      return { outcome: conflict(REASONS.changedSinceEdit) };
    }
    // WriteFlex never changes a mark's type.
    if (operation.payload.type !== type) return { outcome: rejected(REASONS.otherType) };
    const changed = FIELDS.filter((name) =>
      !(name === 'text' && !TEXT_TYPES.includes(type))
      && !sameField(name, operation.payload[name], operation.baseline[name]));
    if ((type === 'image' || type === 'ink') && changed.includes('position')) {
      return { outcome: rejected(REASONS.imagePosition) };
    }
    if (type === 'ink' && changed.includes('color')) return { outcome: rejected(REASONS.inkColour) };
    if (changed.length === 0) return { outcome: confirmed(operation.itemKey) };
    return { changed };
  }

  /** A deletion against the stored row: `{ outcome }`, or `{ erase: true }`. */
  function decideDelete(row, operation) {
    if (!row) return { outcome: operation.resend ? confirmed(operation.itemKey) : rejected(REASONS.gone) };
    const problem = targetProblem(row, operation);
    if (problem) return { outcome: problem };
    const type = TYPE_NAMES[row.type];
    if (type === 'image' || type === 'ink') return { outcome: rejected(REASONS.imageDelete) };
    if (type !== operation.baseline.type || !sameFields(type, fieldsOfRow(row), operation.baseline)) {
      return { outcome: conflict(REASONS.changedSinceDelete) };
    }
    // Without the tags (and stamp) the reader was shown, a tag added in Zotero since could not be seen,
    // and the erase would take it too. WriteFlex sends a state with every deletion it can check.
    if (!operation.baseline.zoteroState) return { outcome: conflict(REASONS.unverifiedDelete) };
    return { erase: true };
  }

  /**
   * True when a saved change the field compare cannot see has touched the annotation since the reader
   * was shown it: its tags differ from the ones shown, or its `clientDateModified` is not the one shown.
   * Both are compared for equality with what Zotero itself reported, so no clock but Zotero's is used;
   * the tag compare also covers a tag change within the same second (Zotero's stamp has whole seconds).
   * A baseline without a state counts as changed: nothing here can show it was not (`decideDelete`
   * refuses it first).
   */
  async function changedBeyondFields(Z, row, baseline) {
    const state = baseline.zoteroState;
    if (!state) return true;
    if (state.modified !== null && String(row.modified) !== state.modified) return true;
    const tagRows = (await Z.DB.queryAsync(ITEM_TAGS_SQL, [row.itemID])) || [];
    const stored = tagRows.map((tagRow) => column(tagRow, 'name')).sort();
    const shown = state.tags.slice().sort();
    return stored.length !== shown.length || stored.some((tag, index) => tag !== shown[index]);
  }

  /** The Area quotation appended to an image annotation's comment: `{ outcome }` or `{ comment }`. */
  function decideAreaQuotation(row, operation) {
    if (!row || row.annotationID === null || row.annotationID === undefined
      || row.parentKey !== operation.parentItemKey || row.isExternal || TYPE_NAMES[row.type] !== 'image') {
      return { outcome: rejected(REASONS.areaMissing) };
    }
    const current = row.comment || '';
    const lines = current.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (lines.includes(operation.areaQuotation)) return { outcome: confirmed(operation.itemKey) };
    const comment = current ? current + '\n\n' + operation.areaQuotation : operation.areaQuotation;
    if (utf8Length(comment) > MAX_AREA_COMMENT_BYTES) return { outcome: rejected(REASONS.areaNoRoom) };
    return { comment };
  }

  // -------------------------------------------------------------------------------------------------
  // Running one operation inside Zotero
  // -------------------------------------------------------------------------------------------------

  function libraryProblem(Z, libraryId) {
    const library = Z.Libraries.get(libraryId);
    if (!library) return rejected(REASONS.library);
    if (libraryId !== Z.Libraries.userLibraryID) return rejected(REASONS.group);
    if (!library.editable) return rejected(REASONS.readOnly);
    return null;
  }

  async function itemRow(Z, libraryId, key) {
    return (await Z.DB.rowQueryAsync(ITEM_ROW_SQL, [libraryId, key])) || null;
  }

  /**
   * The cached item for a key, with its annotation fields freshly read — or a retry outcome when some
   * other part of Zotero holds unsaved changes to it (a reader save waiting behind this transaction).
   */
  async function cleanItem(Z, libraryId, key) {
    const item = await Z.Items.getByLibraryAndKeyAsync(libraryId, key);
    if (!item) return { outcome: retry(REASONS.saving) };
    if (item.hasChanged()) return { outcome: retry(REASONS.saving) };
    await item.loadDataType('annotation');
    await item.loadDataType('annotationDeferred');
    // Checked again after the awaits, immediately before the setters: nothing may have started since.
    if (item.hasChanged()) return { outcome: retry(REASONS.saving) };
    return { item };
  }

  function setFields(item, fields, names) {
    for (const name of names) {
      switch (name) {
        case 'text':
          item.annotationText = fields.text;
          break;
        case 'comment':
          item.annotationComment = fields.comment;
          break;
        case 'color':
          item.annotationColor = fields.color || DEFAULT_COLOUR;
          break;
        case 'pageLabel':
          item.annotationPageLabel = fields.pageLabel;
          break;
        case 'sortIndex':
          item.annotationSortIndex = fields.sortIndex;
          break;
        case 'position':
          item.annotationPosition = fields.position;
          break;
      }
    }
  }

  /** Annotation fields as Zotero names them on an item, by the short names used here. */
  const ITEM_FIELDS = {
    color: 'annotationColor',
    comment: 'annotationComment',
    pageLabel: 'annotationPageLabel',
    position: 'annotationPosition',
    sortIndex: 'annotationSortIndex',
    text: 'annotationText',
    type: 'annotationType',
  };

  /** Which change flag a field's setter raises (item.js: `position` is deferred data, the rest is not). */
  function changeCategory(field) {
    return field === 'annotationPosition' ? 'annotationDeferred' : 'annotation';
  }

  /**
   * Mark a field as changed exactly as its setter would: the value in `_changedData` and the category
   * flag in `_changed`. `_saveData` writes the annotation row only when that flag is set
   * (item.js: `if (this._changed.annotation || this._changed.annotationDeferred)`), so a value left
   * in `_changedData` without its flag would never be saved.
   */
  function markChanged(item, field, value) {
    item._markFieldChange(field, value);
    if (item._changed && typeof item._changed === 'object') item._changed[changeCategory(field)] = true;
  }

  /** Whether a value equals what the database row holds for that field, as Zotero stores it. */
  function storedMatches(short, value, row) {
    if (short === 'type') return TYPE_NAMES[row.type] === value;
    return sameField(short, value, row[short]);
  }

  /**
   * Record every annotation field change made through this item while `work` runs. `_markFieldChange`
   * is the one path every annotation setter takes, so nothing set during `work` escapes the record.
   */
  async function recordingChanges(item, work) {
    const changes = new Map();
    const own = Object.prototype.hasOwnProperty.call(item, '_markFieldChange');
    const original = item._markFieldChange;
    if (typeof original === 'function') {
      item._markFieldChange = function (field, value) {
        if (typeof field === 'string' && field.startsWith('annotation')) changes.set(field, value);
        return original.apply(this, arguments);
      };
    }
    try {
      return { changes, result: await work() };
    } catch (error) {
      error.recordedChanges = changes;
      throw error;
    } finally {
      if (typeof original === 'function') {
        if (own) item._markFieldChange = original;
        else delete item._markFieldChange;
      }
    }
  }

  /**
   * `item.save()`, without swallowing an edit someone else makes to the same item while it runs.
   *
   * Zotero items are shared objects. `Item._saveData` reads the fields, awaits the `REPLACE`, clears
   * each field's change record, and `_finalizeSave` reloads the row and clears the change flag. An edit
   * made during that window loses its record, its flag, or both, and the reader's own save, queued
   * behind this transaction, would then write nothing. So:
   *
   * - every annotation change made through the item while the save runs is recorded;
   * - after the save the in-memory fields are compared with the row just written: any field with an
   *   unsaved value, or a recorded change, that differs from the row is marked changed again, value and
   *   flag, so the reader's save writes it and the newer edit wins;
   * - if the save fails, Zotero's recovery reloads the item and clears every change: the recorded
   *   changes are marked again before the error goes on.
   *
   * Returns `{ kept, lost }`: field names marked again, and those of them this save had changed.
   */
  async function saveKeepingEdits(Z, item, written, libraryId, key) {
    let changes;
    try {
      changes = (await recordingChanges(item, () => item.save({ skipSelect: true }))).changes;
    } catch (error) {
      for (const [field, value] of error.recordedChanges || []) markChanged(item, field, value);
      throw error;
    }
    const row = await itemRow(Z, libraryId, key);
    const kept = [];
    const lost = [];
    for (const short of Object.keys(ITEM_FIELDS)) {
      const field = ITEM_FIELDS[short];
      const unsaved = item._changedData ? item._changedData[field] : undefined;
      const value = unsaved !== undefined ? unsaved : changes.has(field) ? changes.get(field) : undefined;
      if (value === undefined || (row && storedMatches(short, value, row))) continue;
      markChanged(item, field, value);
      kept.push(field);
      if (Object.prototype.hasOwnProperty.call(written, short)) lost.push(field);
    }
    return { kept, lost };
  }

  /** The outcome of a save that may have met a concurrent edit (see `saveKeepingEdits`). */
  function afterSave(result, key) {
    if (result.lost.length > 0) return conflict(REASONS.changedWhileSaving);
    const outcome = confirmed(key);
    if (result.kept.length > 0) {
      outcome.note = 'Zotero changed other parts of this highlight while it was being saved; those changes are kept.';
    }
    return outcome;
  }

  /** Thrown inside the transaction to roll it back and answer with `outcome`. */
  function rollBackWith(outcome) {
    const error = new Error('WriteFlex rolled this change back.');
    error.writeflexOutcome = outcome;
    return error;
  }

  function writtenFields(fields, names) {
    const written = {};
    for (const name of names) written[name] = name === 'color' ? fields.color || DEFAULT_COLOUR : fields[name];
    return written;
  }

  async function create(Z, operation, attachment, watch) {
    const payload = operation.payload;
    const key = operation.itemKey;
    // The proposed key is the mark's identity. A key that is not a Zotero key, or that Zotero already
    // uses for anything, is never swapped for a fresh one here: WriteFlex chooses the new key itself,
    // so it always knows which key its mark lives under.
    if (!KEY_PATTERN.test(key)) return keyInUse();
    const row = await itemRow(Z, operation.libraryId, key);
    if (row) {
      // An earlier, cut-off send of this create may have landed at exactly this key on this document.
      const ours = operation.resend && row.annotationID !== null && row.annotationID !== undefined
        && row.parentKey === operation.parentItemKey;
      if (!ours) return keyInUse();
      return identicalMark(row, payload) ? confirmed(key) : conflict(REASONS.changedSinceSend);
    }

    // The same steps as `Zotero.Annotations.saveFromJSON` for a new annotation, minus the tag and
    // author-name writes, and `save()` rather than `saveTx()` because this runs inside a transaction.
    const names = FIELDS.filter((name) => name !== 'text' || TEXT_TYPES.includes(payload.type));
    const item = new Z.Item('annotation');
    item.libraryID = operation.libraryId;
    item.key = key;
    await item.loadPrimaryData();
    item.parentID = attachment.id;
    item.annotationType = payload.type;
    item.annotationIsExternal = false;
    setFields(item, payload, names);
    const written = Object.assign({ type: payload.type }, writtenFields(payload, names));
    // A new item: on a rollback Zotero unloads it itself (`_initSave`); only its parent needs reloading.
    watch.wrote = true;
    return afterSave(await saveKeepingEdits(Z, item, written, operation.libraryId, key), key);
  }

  async function update(Z, operation, watch) {
    const row = await itemRow(Z, operation.libraryId, operation.itemKey);
    const decision = operation.areaQuotation !== undefined
      ? decideAreaQuotation(row, operation)
      : decideUpdate(row, operation);
    if (decision.outcome) return decision.outcome;
    const held = await cleanItem(Z, operation.libraryId, operation.itemKey);
    if (held.outcome) return held.outcome;
    let written;
    if (decision.comment !== undefined) {
      held.item.annotationComment = decision.comment;
      written = { comment: decision.comment };
    } else {
      setFields(held.item, operation.payload, decision.changed);
      written = writtenFields(operation.payload, decision.changed);
    }
    // From here every change anyone else makes to the item is recorded until the transaction is over
    // (installed after this write's own setters, in the same synchronous run as the save's start).
    watch.track(held.item);
    watch.wrote = true;
    const saved = await saveKeepingEdits(Z, held.item, written, operation.libraryId, operation.itemKey);
    // Changes made during the save were handled by `saveKeepingEdits`; later ones are put back after the commit.
    watch.savedAt = watch.log.length;
    return afterSave(saved, operation.itemKey);
  }

  /**
   * Erase, unless someone changes the annotation while it is being erased.
   *
   * The last `hasChanged()` look, installing the change record and starting `erase()` happen in one
   * synchronous run, so no edit can slip in between them. An edit that arrives while the erase awaits
   * is recorded; the erase is then rolled back (thrown out of the transaction), which in Zotero also
   * drops the queued delete notification and leaves the item in the cache (it is unloaded only on
   * commit), with the edit marked again so the reader's save writes it.
   */
  async function erase(Z, operation, watch) {
    const row = await itemRow(Z, operation.libraryId, operation.itemKey);
    const decision = decideDelete(row, operation);
    if (decision.outcome) return decision.outcome;
    if (await changedBeyondFields(Z, row, operation.baseline)) return conflict(REASONS.changedSinceDelete);
    const held = await cleanItem(Z, operation.libraryId, operation.itemKey);
    if (held.outcome) return held.outcome;
    const item = held.item;
    if (item.hasChanged()) return retry(REASONS.saving);
    // `erase()` inside the transaction does what the reader's `eraseTx()` does: the client version,
    // the sync cache, the delete-log entry (through the notifier) and the cached image. The check
    // above, the recorder and the start of `erase()` run in one synchronous run.
    watch.track(item);
    watch.wrote = true;
    watch.erasing = true;
    await item.erase();
    if (watch.log.length > 0 || item.hasChanged()) throw rollBackWith(conflict(REASONS.changedWhileDeleting));
    return confirmed(operation.itemKey);
  }

  /**
   * True when the attachment is open in a Zotero reader (a tab or a window, loaded or not): the reader
   * holds the annotations in memory and saves them on its own schedule, so WriteFlex waits until it is
   * closed. `Zotero.Reader._readers` is the list `Zotero.Reader.open` and `getByTabID` use.
   */
  function openInReader(Z, attachmentId) {
    const readers = Z.Reader && Z.Reader._readers;
    if (!Array.isArray(readers)) return false;
    return readers.some((reader) => reader && reader.itemID === attachmentId);
  }

  function syncing(Z) {
    return !!(Z.Sync && Z.Sync.Runner && Z.Sync.Runner.syncInProgress);
  }

  /**
   * Apply one checked operation. Everything from the first read to the save is ONE Zotero transaction,
   * so no other Zotero write can land between the compare and the set.
   */
  async function runOperation(Z, operation) {
    const watch = changeWatch();
    try {
      const outcome = await Z.DB.executeTransaction(async () => {
        const libraryRefusal = libraryProblem(Z, operation.libraryId);
        if (libraryRefusal) return libraryRefusal;
        const attachment = await Z.Items.getByLibraryAndKeyAsync(operation.libraryId, operation.parentItemKey);
        if (!attachment) return rejected(REASONS.parentMissing);
        if (!attachment.isPDFAttachment()) return rejected(REASONS.parentNotPdf);
        // Not while someone is working on this PDF in Zotero, or while a sync may rewrite it.
        if (openInReader(Z, attachment.id)) return retry(REASONS.openInZotero);
        if (syncing(Z)) return retry(REASONS.syncing);
        watch.parentId = attachment.id;
        const result = operation.kind === 'create'
          ? await create(Z, operation, attachment, watch)
          : operation.kind === 'update' ? await update(Z, operation, watch) : await erase(Z, operation, watch);
        // The last step before Zotero commits, after every await of the write: if the PDF was opened
        // in Zotero or a sync started meanwhile, or the item was changed while it was being erased, the
        // write is rolled back. After this returns, Zotero awaits only its COMMIT.
        if (watch.wrote) {
          if (openInReader(Z, attachment.id)) throw rollBackWith(retry(REASONS.openInZotero));
          if (syncing(Z)) throw rollBackWith(retry(REASONS.syncing));
          if (watch.erasing && watch.log.length > 0) throw rollBackWith(conflict(REASONS.changedWhileDeleting));
        }
        return result;
      });
      // Committed. Anything changed on the item after its save is marked again, so the reader's own
      // save, queued behind this transaction, still writes it.
      if (watch.item && !watch.erasing) watch.reapply(watch.savedAt);
      return outcome;
    } catch (error) {
      if (watch.wrote) await restoreAfterRollback(Z, watch);
      if (error && error.writeflexOutcome) return error.writeflexOutcome;
      if (error && error.name === 'TimeoutError') return retry(REASONS.busy);
      const message = error && error.message ? String(error.message) : String(error);
      return rejected('Zotero could not save this change: ' + message);
    } finally {
      watch.stop();
    }
  }

  /**
   * Records every annotation change made through one item from `track()` until `stop()`, which
   * `runOperation` calls only after the transaction has committed or rolled back and the item has
   * been put right. `log` keeps the order, so marking them again leaves the latest value.
   */
  function changeWatch() {
    const watch = { erasing: false, item: null, log: [], parentId: null, savedAt: 0, wrote: false };
    watch.stop = () => {};
    watch.track = (item) => {
      watch.item = item;
      const own = Object.prototype.hasOwnProperty.call(item, '_markFieldChange');
      const original = item._markFieldChange;
      if (typeof original !== 'function') return;
      item._markFieldChange = function (field, value) {
        if (typeof field === 'string' && field.startsWith('annotation')) watch.log.push([field, value]);
        return original.apply(this, arguments);
      };
      watch.stop = () => {
        if (own) item._markFieldChange = original;
        else delete item._markFieldChange;
        watch.stop = () => {};
      };
    };
    watch.reapply = (from = 0) => {
      for (const [field, value] of watch.log.slice(from)) markChanged(watch.item, field, value);
    };
    return watch;
  }

  /**
   * After a rollback, make Zotero's objects in memory match the database again, the way Zotero's own
   * save and erase leave them (item.js `_eraseData` and `_saveData` end with
   * `parentItem.reload(['primaryData', 'childItems'], true)` and `clearBestAttachmentState()`, inside
   * the transaction that was rolled back):
   *
   * - the attachment's child items are reloaded, so its annotation list again holds an annotation
   *   whose erase was rolled back, and no longer holds a new one Zotero unloaded on rollback;
   * - an edited item is reloaded from its row (our values were loaded into it by the save), and
   *   every change anyone made to it while this ran is marked again, value and flag.
   */
  async function restoreAfterRollback(Z, watch) {
    try {
      const item = watch.item;
      if (item && !watch.erasing && typeof item.reload === 'function') await item.reload(null, true);
      if (item) watch.reapply(0);
      if (watch.parentId !== null && Z.Items && typeof Z.Items.getAsync === 'function') {
        const parent = await Z.Items.getAsync(watch.parentId);
        if (parent && typeof parent.reload === 'function') {
          await parent.reload(['primaryData', 'childItems'], true);
          if (typeof parent.clearBestAttachmentState === 'function') parent.clearBestAttachmentState();
        }
      }
    } catch (error) {
      if (typeof Z.logError === 'function') Z.logError(error);
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Reading one attachment's annotations (what `@readflex/zotero-bridge` `readAnnotations` reads)
  // -------------------------------------------------------------------------------------------------

  const READ_ANNOTATIONS_SQL =
    'SELECT annotationItem.key AS key, annotation.type AS type, attachmentItem.key AS parentItemKey, '
    + 'annotation.authorName AS authorName, annotation.text AS text, annotation.comment AS comment, '
    + 'annotation.color AS color, annotation.pageLabel AS pageLabel, annotation.sortIndex AS sortIndex, '
    + 'annotation.position AS position, annotation.isExternal AS isExternal, '
    + 'annotationItem.clientDateModified AS modified '
    + 'FROM itemAnnotations AS annotation '
    + 'JOIN items AS annotationItem ON annotationItem.itemID = annotation.itemID '
    + 'JOIN items AS attachmentItem ON attachmentItem.itemID = annotation.parentItemID '
    + 'LEFT JOIN deletedItems AS deletedAnnotation ON deletedAnnotation.itemID = annotation.itemID '
    + 'WHERE attachmentItem.libraryID = ? AND attachmentItem.key = ? AND deletedAnnotation.itemID IS NULL '
    + 'ORDER BY annotation.sortIndex';

  const READ_TAGS_SQL =
    'SELECT annotationItem.key AS annotationKey, tag.name AS name '
    + 'FROM itemAnnotations AS annotation '
    + 'JOIN items AS annotationItem ON annotationItem.itemID = annotation.itemID '
    + 'JOIN items AS attachmentItem ON attachmentItem.itemID = annotation.parentItemID '
    + 'JOIN itemTags AS itemTag ON itemTag.itemID = annotation.itemID '
    + 'JOIN tags AS tag ON tag.tagID = itemTag.tagID '
    + 'LEFT JOIN deletedItems AS deletedAnnotation ON deletedAnnotation.itemID = annotation.itemID '
    + 'WHERE attachmentItem.libraryID = ? AND attachmentItem.key = ? AND deletedAnnotation.itemID IS NULL '
    + 'ORDER BY annotationItem.key, tag.name';

  function column(row, name) {
    const value = row[name];
    return value === undefined ? null : value;
  }

  /**
   * The annotations as committed: read inside a transaction, so the read waits for any write in
   * progress and sees none of it half-done (Zotero has one connection; a plain query would see an open
   * transaction's uncommitted rows).
   */
  async function readAnnotations(Z, libraryId, attachmentKey) {
    return Z.DB.executeTransaction(async () => {
      const rows = (await Z.DB.queryAsync(READ_ANNOTATIONS_SQL, [libraryId, attachmentKey])) || [];
      const tagRows = (await Z.DB.queryAsync(READ_TAGS_SQL, [libraryId, attachmentKey])) || [];
      const tags = new Map();
      for (const tagRow of tagRows) {
        const key = column(tagRow, 'annotationKey');
        if (!tags.has(key)) tags.set(key, []);
        tags.get(key).push(column(tagRow, 'name'));
      }
      return rows.map((row) => ({
        authorName: column(row, 'authorName'),
        color: column(row, 'color'),
        comment: column(row, 'comment'),
        isExternal: !!column(row, 'isExternal'),
        key: column(row, 'key'),
        modified: column(row, 'modified'),
        pageLabel: column(row, 'pageLabel'),
        parentItemKey: column(row, 'parentItemKey'),
        position: column(row, 'position'),
        sortIndex: column(row, 'sortIndex'),
        tags: tags.get(column(row, 'key')) || [],
        text: column(row, 'text'),
        type: TYPE_NAMES[column(row, 'type')] || 'unknown',
      }));
    });
  }

  // -------------------------------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------------------------------

  /**
   * `GET /writeflex/ping`: a signed answer proves to WriteFlex that this plugin holds the key, and
   * tells it this run's session id, which every other request must carry.
   */
  async function handlePing(request, context) {
    const checked = await authenticate(request, context, PING_PATH, '', false);
    if (checked.refusal) return checked.refusal;
    return signedAnswer(context, checked.nonce, 200, {
      pluginVersion: context.pluginVersion,
      protocol: PROTOCOL,
      sessionId: context.sessionId,
      zoteroVersion: context.zoteroVersion,
    });
  }

  /** Body text as Zotero's server hands over a `text/plain` request, or null. */
  function bodyOf(request) {
    return typeof request.data === 'string' ? request.data : null;
  }

  /**
   * `POST /writeflex/annotations`: one operation, one signed answer `{ kind, reason?, itemKey?, note?, code? }`.
   * The body is sent as `text/plain` so Zotero's server hands it over as the exact string WriteFlex
   * signed; it is parsed here.
   */
  async function handleAnnotation(Z, request, context) {
    const body = bodyOf(request);
    if (body === null) return refused('This request was not signed with the WriteFlex key.');
    const checked = await authenticate(request, context, ANNOTATIONS_PATH, body, true);
    if (checked.refusal) return checked.refusal;
    if (checked.stale) return staleSession(context, checked.nonce);
    let data;
    try {
      data = JSON.parse(body);
    } catch (error) {
      return signedAnswer(context, checked.nonce, 200, rejected(REASONS.malformed));
    }
    const parsed = parseOperation(data);
    if (parsed.outcome) {
      const status = parsed.outcome.status || 200;
      const answer = { kind: parsed.outcome.kind, reason: parsed.outcome.reason };
      if (status === 409) answer.protocol = PROTOCOL;
      return signedAnswer(context, checked.nonce, status, answer);
    }
    return signedAnswer(context, checked.nonce, 200, await runOperation(Z, parsed.operation));
  }

  /**
   * `POST /writeflex/annotations/read` with `{ protocol, libraryId, parentItemKey }`: the attachment's
   * annotations as Zotero holds them now, signed: `{ kind: 'annotations', annotations }`.
   */
  async function handleRead(Z, request, context) {
    const body = bodyOf(request);
    if (body === null) return refused('This request was not signed with the WriteFlex key.');
    const checked = await authenticate(request, context, READ_PATH, body, true);
    if (checked.refusal) return checked.refusal;
    if (checked.stale) return staleSession(context, checked.nonce);
    let data;
    try {
      data = JSON.parse(body);
    } catch (error) {
      data = null;
    }
    if (isRecord(data) && data.protocol !== PROTOCOL) {
      return signedAnswer(context, checked.nonce, 409, { kind: 'rejected', protocol: PROTOCOL, reason: REASONS.protocol });
    }
    if (!isRecord(data) || !Number.isSafeInteger(data.libraryId) || data.libraryId <= 0
      || typeof data.parentItemKey !== 'string' || !KEY_PATTERN.test(data.parentItemKey)) {
      return signedAnswer(context, checked.nonce, 200, rejected(REASONS.malformed));
    }
    if (!Z.Libraries.get(data.libraryId)) return signedAnswer(context, checked.nonce, 200, rejected(REASONS.library));
    try {
      const annotations = await readAnnotations(Z, data.libraryId, data.parentItemKey);
      return signedAnswer(context, checked.nonce, 200, { annotations, kind: 'annotations' });
    } catch (error) {
      if (error && error.name === 'TimeoutError') return signedAnswer(context, checked.nonce, 200, retry(REASONS.busy));
      return signedAnswer(context, checked.nonce, 200, rejected('Zotero could not read this document\'s annotations.'));
    }
  }

  /** A fresh session id for one run of the plugin: 16 random bytes as hex. */
  function newSessionId(getRandomValues) {
    const bytes = new Uint8Array(16);
    getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /** A fresh 32-byte key as 64 hex characters. */
  function newToken(getRandomValues) {
    const bytes = new Uint8Array(32);
    getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return {
    ANNOTATIONS_PATH,
    ITEM_ROW_SQL,
    ITEM_TAGS_SQL,
    NONCE_HEADER,
    PING_PATH,
    PROTOCOL,
    READ_ANNOTATIONS_SQL,
    READ_PATH,
    READ_TAGS_SQL,
    REASONS,
    RESPONSE_SIGNATURE_HEADER,
    SESSION_HEADER,
    SIGNATURE_HEADER,
    SIGNATURE_WINDOW_MS,
    TIMESTAMP_HEADER,
    constantTimeEqual,
    decideAreaQuotation,
    decideDelete,
    decideUpdate,
    identicalMark,
    requestMessage,
    responseMessage,
    fromBrowser,
    handleAnnotation,
    handlePing,
    handleRead,
    newSessionId,
    isValidToken: (token) => TOKEN_PATTERN.test(token || ''),
    newToken,
    parseOperation,
    runOperation,
    sameJson,
  };
})();

if (typeof module === 'object' && module && module.exports) module.exports = WriteFlexZotero;
