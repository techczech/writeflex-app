declare module '*.md?raw' {
  const source: string
  export default source
}

declare module '*.css?inline' { const css: string; export default css }
