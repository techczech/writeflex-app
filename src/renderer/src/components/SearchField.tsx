import { forwardRef, type InputHTMLAttributes } from 'react'
import { Search, X } from 'lucide-react'

export type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> & {
  value: string
  /** The text, and where the caret is (the Files filter completes prefixes at the caret). */
  onValueChange: (value: string, caret: number | null) => void
  /** The clear button's label; it shows only while there is text. */
  clearLabel?: string
  /** Extra class for the wrapper. */
  wrapClassName?: string
}

/**
 * The one search field (house rule R12): a magnifier, the text, and a clear button while there is text.
 * The Files filter, the Board's card filter and the other list filters all draw this, so they look and
 * clear alike. It is a plain controlled input; each caller keeps its own matching.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onValueChange, clearLabel = 'Clear search', wrapClassName, className, onKeyDown, ...rest },
  ref,
) {
  return (
    <div className={`wf-search${wrapClassName ? ` ${wrapClassName}` : ''}`} data-testid="search-field">
      <Search className="icon sm" aria-hidden="true" />
      <input
        {...rest}
        ref={ref}
        type="text"
        className={className}
        value={value}
        spellCheck={false}
        onChange={(event) => onValueChange(event.target.value, event.target.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {value && (
        <button type="button" className="wf-search-clear" aria-label={clearLabel} title={clearLabel} onMouseDown={(event) => event.preventDefault()} onClick={() => onValueChange('', 0)}>
          <X className="icon sm" aria-hidden="true" />
        </button>
      )}
    </div>
  )
})
