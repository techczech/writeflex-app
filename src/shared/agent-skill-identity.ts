// What is WriteFlex's in the built-in agent skill (the portable module in src/shared/agent-skill/ and
// src/main/agent-skill/ takes these as parameters): read by main, by the command line and by the renderer.
// Pure; erasable TypeScript only (a node script imports it as it is).
export const STABLE_BUNDLE_ID = 'net.dominiklukes.writeflex'
export const BETA_BUNDLE_ID = 'net.dominiklukes.writeflex.beta'

export const AGENT_SKILL_IDENTITY = {
  appId: 'writeflex',
  appName: 'WriteFlex',
  skillName: 'writeflex',
  /** What the skill lets the person ask an agent for (the offer's sentence, in the person's terms; the owner's wording). */
  features: 'draft, edit and review your documents',
  tryExample: (agent: string): string => `Ask ${agent} to read a document in your WriteFlex Collection and suggest edits that tighten it.`,
  /** The one `writeflex` command (src/main/cli/shim.ts): runs the app's binary in Node mode on the bundled command line. */
  cli: {
    command: 'writeflex',
    appName: 'WriteFlex',
    bundleId: STABLE_BUNDLE_ID,
    nodeEntry: 'Contents/Resources/app.asar/out/main/writeflex-cli.js',
    announceElsewhere: true
  }
} as const
