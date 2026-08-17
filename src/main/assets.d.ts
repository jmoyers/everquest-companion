// assets.d.ts — the one non-code import the MAIN bundle makes (JOS-139).
//
// `import icon from '../../build/icon.png?asset'` hands a file to electron-vite's asset pipeline:
// it is emitted beside the main bundle (so electron-builder's `out/**` ships it with no change to
// electron-builder.yml) and the import is rewritten to the emitted path at build time. TypeScript
// needs to be told that the specifier resolves to a string.
//
// NARROW ON PURPOSE. electron-vite ships a whole `electron-vite/node` type block (`?nodeWorker`,
// `?modulePath`, `*.node`, `?loader`, its own `ImportMetaEnv`) and adding it to
// tsconfig.node.json's `types` would declare every one of those for a tree that uses exactly one
// of them — including a second opinion about `import.meta.env`, which this repo has laws about
// (AGENTS.md: never reference a vite `define` bare). One module pattern, one line.

declare module '*.png?asset' {
  const src: string
  export default src
}
