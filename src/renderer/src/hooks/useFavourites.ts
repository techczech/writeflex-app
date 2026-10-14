import { useCallback, useEffect, useState } from 'react'

export type UseFavourites = {
  /** Favourite file paths (relative to the workspace root) for the window's open workspace. */
  favourites: string[]
  /** Pin or unpin a path; main returns the fresh list, which becomes the source of truth. */
  toggle: (path: string) => void
}

/**
 * Favourites view over the preload bridge. Main keys pins by the window's workspace root, so this
 * hook needs `root` only as a load gate — it (re)loads when a root first resolves, and stays empty
 * while there is no workspace (the list channel throws without one, so we never call it then).
 * Accepts the `undefined` loading sentinel too: it is falsy, so the load gate treats it as "no
 * workspace yet" and holds an empty list until the fetch resolves.
 */
export function useFavourites(root: string | null | undefined): UseFavourites {
  const [favourites, setFavourites] = useState<string[]>([])

  useEffect(() => {
    if (!root) {
      setFavourites([])
      return
    }
    let alive = true
    void window.writeflex
      .listFavourites()
      .then((list) => {
        if (alive) setFavourites(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [root])

  const toggle = useCallback((path: string) => {
    void window.writeflex.toggleFavourite(path).then(setFavourites).catch(() => {})
  }, [])

  return { favourites, toggle }
}
