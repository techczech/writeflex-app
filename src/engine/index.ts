// The change ledger lives upstream in Bridle (@bridle/ledger) — provenance, authorship, the
// accept/reject/hold review lifecycle, sessions, and version comparison are harness concerns, not app
// concerns. This re-export is the app's ONE seam onto it: when the upstream API evolves, adapt here.
export * from '@bridle/ledger'
