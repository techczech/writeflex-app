const messages = {
  workspace: 'Could not load the workspace.',
  listing: 'Could not load files.',
  refresh: 'Could not refresh files. Showing the last result.',
}

export function WorkspaceReadProblem({ phase, onRetry }: { phase: keyof typeof messages; onRetry: () => void }): JSX.Element {
  return (
    <div className="filter-empty workspace-read-problem" role="alert">
      <div>{messages[phase]}</div>
      <button className="ghost" type="button" onClick={onRetry}>Try again</button>
    </div>
  )
}
