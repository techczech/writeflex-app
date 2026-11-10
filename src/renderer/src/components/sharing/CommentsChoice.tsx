import { Lock, Users } from 'lucide-react'

export function CommentsChoice({ value, disabled, hasPrivateComments, onChange }: {
  value: 'private' | 'open'; disabled?: boolean; hasPrivateComments?: boolean
  onChange: (value: 'private' | 'open') => void
}): JSX.Element {
  return <div>
    <span className="shr-seg" role="group" aria-label="Comments are">
      <button type="button" aria-pressed={value === 'private'} disabled={disabled} onClick={() => onChange('private')}><Lock className="icon" aria-hidden="true" />Private comments</button>
      <button type="button" aria-pressed={value === 'open'} disabled={disabled} onClick={() => onChange('open')}><Users className="icon" aria-hidden="true" />Open comments</button>
    </span>
    <p className="shr-p shr-dim">{value === 'open' ? 'Open: every reader of this link sees all comments with their names and can reply.' : 'Private: each reader sees only their own comments and your replies.'}</p>
    {hasPrivateComments && <p className="shr-p shr-dim">Comments already made stay private.</p>}
  </div>
}
