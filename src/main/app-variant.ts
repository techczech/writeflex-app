export type AppVariant = {
  userDataDirectoryName: 'writeflex-desktop' | 'writeflex-desktop-beta'
  versionLabelSuffix: '' | ' beta'
}

const PRODUCTION_VARIANT: AppVariant = {
  userDataDirectoryName: 'writeflex-desktop',
  versionLabelSuffix: '',
}

const BETA_VARIANT: AppVariant = {
  userDataDirectoryName: 'writeflex-desktop-beta',
  versionLabelSuffix: ' beta',
}

/** Resolve the build-baked package metadata without consulting Electron or process state. */
export function resolveAppVariant(metadata: unknown): AppVariant {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return PRODUCTION_VARIANT
  }
  return (metadata as Record<string, unknown>).writeflexVariant === 'beta'
    ? BETA_VARIANT
    : PRODUCTION_VARIANT
}
