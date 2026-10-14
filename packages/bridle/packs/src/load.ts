import { computePackContentHash } from "./hash.ts";
import {
  PackHashMismatchError,
  PackIdentityMismatchError,
  PackValidationError,
  type LoadedScriptPack,
  type PackPin,
} from "./types.ts";
import { validatePackFolder } from "./validate.ts";

export async function loadPack(root: string, options: { pin?: PackPin } = {}): Promise<LoadedScriptPack> {
  const result = await validatePackFolder(root);
  if (!result.ok) throw new PackValidationError(result.issues);

  const { pack } = result;
  if (options.pin && (options.pin.name !== pack.name || options.pin.version !== pack.version)) {
    throw new PackIdentityMismatchError(`${options.pin.name}@${options.pin.version}`, `${pack.name}@${pack.version}`);
  }

  const contentHash = await computePackContentHash(root);
  if (options.pin && options.pin.hash !== contentHash) {
    throw new PackHashMismatchError(options.pin.hash, contentHash);
  }

  return {
    ...pack,
    contentHash,
    scriptsById: new Map(pack.scripts.map((script) => [script.id, script])),
    probesById: new Map(pack.probes.map((probe) => [probe.id, probe])),
    assetsById: new Map(pack.assets.map((asset) => [asset.id, asset])),
  };
}
