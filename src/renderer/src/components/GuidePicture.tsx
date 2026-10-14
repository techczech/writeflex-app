import type { ComponentType } from 'react'
import { PictureAgent, PictureBlocks, PictureCollections, PictureFolder, PictureModes, PicturePlain, PictureSave, PictureSkills } from './guide-pictures-how'
import {
  PictureCapture, PictureCopy, PictureDiagrams, PictureFocus, PictureListen, PictureReader, PictureSearch, PictureSend, PictureSession, PictureSettings, PictureVersions,
} from './guide-pictures-features'

/** A topic's picture, by the key in `src/shared/guide-topics.ts`. SVG in the app's own look. */
const PICTURES: Record<string, ComponentType> = {
  folder: PictureFolder, plain: PicturePlain, save: PictureSave, blocks: PictureBlocks, modes: PictureModes, agent: PictureAgent, skills: PictureSkills, collections: PictureCollections,
  send: PictureSend, listen: PictureListen, focus: PictureFocus, session: PictureSession, reader: PictureReader, diagrams: PictureDiagrams, capture: PictureCapture,
  versions: PictureVersions, copy: PictureCopy, search: PictureSearch, settings: PictureSettings,
}

export const hasGuidePicture = (key: string): boolean => Object.hasOwn(PICTURES, key)

export function GuidePicture({ name }: { name: string }): JSX.Element | null {
  const Picture = PICTURES[name]
  return Picture ? <Picture /> : null
}
