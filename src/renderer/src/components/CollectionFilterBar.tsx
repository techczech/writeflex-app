import { useRef } from 'react'
import { ArrowDownUp, ChevronDown, Layers, Search, X } from 'lucide-react'
import type { CollectionFilters, CollectionGroup } from './collection-view-state'
export function CollectionFilterBar({ filters, onChange, facets, group, onGroup, sort, onSort }: { filters: CollectionFilters; onChange: (value: CollectionFilters) => void; facets: { statuses: string[]; purposes: string[]; tags: string[] }; group: CollectionGroup; onGroup: (value: CollectionGroup) => void; sort: string; onSort: (value: string) => void }): JSX.Element {
  const bar = useRef<HTMLDivElement>(null)
  const set = <K extends keyof CollectionFilters>(key: K, value: CollectionFilters[K]) => onChange({ ...filters, [key]: value })
  return <div className="cv-filters" ref={bar}>
    <div className="cv-search"><Search className="icon sm" /><input data-collection-control="search" aria-label="Search this collection" placeholder="Search this collection" value={filters.query} onChange={e => set('query', e.target.value)} />{filters.query && <button aria-label="Clear collection search" onClick={() => set('query', '')}><X className="icon sm" /></button>}<kbd>⌘F</kbd></div>
    <select className="cv-search-scope" data-collection-control="search-in" aria-label="Search in" value={filters.searchIn} onChange={e => set('searchIn', e.target.value as CollectionFilters['searchIn'])}><option value="all">Title and text</option><option value="title">Title only</option></select>
    {(['statuses', 'purposes', 'tags'] as const).map((key, index) => {
      const label = ['Status', 'Purpose', 'Tags'][index], control = ['status', 'purpose', 'tags'][index]
      return <details className={`cv-facet${filters[key].length ? ' on' : ''}`} key={key} data-collection-control={control}><summary>{label}{filters[key].length ? `: ${filters[key].join(', ')}` : ''}<ChevronDown className="icon sm" /></summary><div className="cv-facet-options" aria-label={`${label} filters`}>
        {facets[key].map(value => <label key={value}><input type="checkbox" checked={filters[key].includes(value)} onChange={() => set(key, filters[key].includes(value) ? filters[key].filter(x => x !== value) : [...filters[key], value])} />{value}</label>)}
        {!facets[key].length && <span>No tags in this collection.</span>}
        <button onClick={() => set(key, [])}>Clear {label.toLowerCase()}</button>
      </div></details>
    })}
    <select className={`cv-modified${filters.modified !== 'any' ? ' on' : ''}`} data-collection-control="modified" aria-label="Filter by modified date" value={filters.modified} onChange={e => set('modified', e.target.value as CollectionFilters['modified'])}><option value="any">Modified</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
    <div className="cv-view-controls"><label className="cv-group"><Layers className="icon sm" /><select data-collection-control="group" aria-label="Group documents" value={group} onChange={e => onGroup(e.target.value as CollectionGroup)}><option value="none">Group: none</option><option value="status">Group: Status</option><option value="purpose">Group: Purpose</option><option value="month">Group: Month</option></select></label>
    <label className="cv-sort"><ArrowDownUp className="icon sm" /><select data-collection-control="sort" aria-label="Sort documents" value={sort} onChange={e => onSort(e.target.value)}><option value="date:desc">Modified</option><option value="date:asc">Oldest modified</option><option value="title:asc">Title A–Z</option><option value="title:desc">Title Z–A</option><option value="status:asc">Status</option><option value="purpose:asc">Purpose</option><option value="words:desc">Most words</option><option value="words:asc">Fewest words</option></select></label></div>
  </div>
}
