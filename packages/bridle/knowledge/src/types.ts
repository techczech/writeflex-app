/** Parsed frontmatter: typed access to reserved OKF fields + verbatim unknowns. */
export type Frontmatter = {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  /** Every key not listed above, preserved for round-trip. */
  extra: Record<string, unknown>;
};

export type KnowledgeDoc = {
  /** Bundle-relative path, "/"-prefixed (OKF absolute-link form). */
  path: string;
  frontmatter: Frontmatter | null;
  body: string;
};
