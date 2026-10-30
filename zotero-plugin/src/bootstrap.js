/*
 * WriteFlex for Zotero: lifecycle.
 *
 * The build bundles `writeflex-bridge.js` (which defines `WriteFlexZotero`) ahead of this file into the
 * xpi's single `bootstrap.js`, so nothing is loaded at run time: Gecko's plain subscript loader refuses
 * the `jar:file:` URLs plugins live at.
 *
 * On install: make a fresh 32-byte key (kept in a Zotero preference). On startup: make sure a key
 * exists, pick a fresh session id for this run (requests from an earlier run are refused), register
 * three endpoints on Zotero's local HTTP server, and write
 * `<Zotero data directory>/writeflex/bridge.json` ({ token, pluginVersion, port, protocol }, owner-only)
 * so WriteFlex on this computer can find the server. The key never travels: both sides sign with it.
 * On shutdown: unregister the endpoints. On uninstall (not on an upgrade): remove the key and the file.
 */
/* global Zotero, IOUtils, PathUtils, crypto, WriteFlexZotero, ADDON_INSTALL, ADDON_UNINSTALL */

const TOKEN_PREF = 'extensions.writeflex.token';
let registeredEndpoints = [];

/** A fresh key on every install (not on upgrade or restart): an old pairing does not carry over. */
function install(_data, reason) {
  if (typeof ADDON_INSTALL !== 'undefined' && reason !== ADDON_INSTALL) return;
  try {
    Zotero.Prefs.set(TOKEN_PREF, WriteFlexZotero.newToken((bytes) => crypto.getRandomValues(bytes)), true);
  } catch (error) {
    // Zotero may not be ready this early; startup makes a key if none is there.
  }
}

function endpointClass(methods, handler) {
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: methods,
    // text/plain: Zotero's server hands the body over as the exact string WriteFlex signed.
    supportedDataTypes: ['text/plain'],
    // Exactly one declared parameter: Zotero's server then passes the whole request object.
    init: function (request) {
      return handler(request);
    },
  };
  return Endpoint;
}

function ensureToken() {
  const existing = Zotero.Prefs.get(TOKEN_PREF, true);
  if (WriteFlexZotero.isValidToken(existing)) return existing;
  const token = WriteFlexZotero.newToken((bytes) => crypto.getRandomValues(bytes));
  Zotero.Prefs.set(TOKEN_PREF, token, true);
  return token;
}

function bridgeDirectory() {
  return PathUtils.join(Zotero.DataDirectory.dir, 'writeflex');
}

async function writeBridgeFile(context) {
  const directory = bridgeDirectory();
  // The directory is owner-only before the file exists, so no moment exists in which another
  // account on this computer could read the key.
  await IOUtils.makeDirectory(directory, { createAncestors: false, ignoreExisting: true, permissions: 0o700 });
  await IOUtils.setPermissions(directory, 0o700, false);
  const path = PathUtils.join(directory, 'bridge.json');
  const body = JSON.stringify({
    pluginVersion: context.pluginVersion,
    port: Number(Zotero.Prefs.get('httpServer.port')) || 23119,
    protocol: WriteFlexZotero.PROTOCOL,
    token: context.token,
  }, null, 2);
  await IOUtils.writeUTF8(path, body, { tmpPath: path + '.tmp' });
  await IOUtils.setPermissions(path, 0o600, false);
}

async function startup({ version }) {
  await Zotero.initializationPromise;
  const context = {
    crypto,
    nonces: new Map(),
    pluginVersion: version,
    sessionId: WriteFlexZotero.newSessionId((bytes) => crypto.getRandomValues(bytes)),
    token: ensureToken(),
    zoteroVersion: Zotero.version,
  };
  const ping = endpointClass(['GET'], (request) => WriteFlexZotero.handlePing(request, context));
  const annotations = endpointClass(['POST'], (request) =>
    WriteFlexZotero.handleAnnotation(Zotero, request, context));
  const read = endpointClass(['POST'], (request) => WriteFlexZotero.handleRead(Zotero, request, context));
  Zotero.Server.Endpoints[WriteFlexZotero.PING_PATH] = ping;
  Zotero.Server.Endpoints[WriteFlexZotero.ANNOTATIONS_PATH] = annotations;
  Zotero.Server.Endpoints[WriteFlexZotero.READ_PATH] = read;
  registeredEndpoints = [
    [WriteFlexZotero.PING_PATH, ping],
    [WriteFlexZotero.ANNOTATIONS_PATH, annotations],
    [WriteFlexZotero.READ_PATH, read],
  ];
  try {
    await writeBridgeFile(context);
  } catch (error) {
    Zotero.logError(error);
  }
}

function shutdown() {
  for (const [path, endpoint] of registeredEndpoints) {
    if (Zotero.Server.Endpoints[path] === endpoint) delete Zotero.Server.Endpoints[path];
  }
  registeredEndpoints = [];
}

async function uninstall(_data, reason) {
  if (reason !== ADDON_UNINSTALL) return;
  Zotero.Prefs.clear(TOKEN_PREF, true);
  try {
    await IOUtils.remove(PathUtils.join(bridgeDirectory(), 'bridge.json'), { ignoreAbsent: true });
  } catch (error) {
    Zotero.logError(error);
  }
}
