export function digestDisplayGist(gist: string): string {
  return gist.replace(/\[\[([^\]\n]+)\]\]/g, (_match, value: string) => {
    const [target, display] = value.split('|', 2)
    return (display ?? target).split('#', 1)[0].trim()
  })
}
