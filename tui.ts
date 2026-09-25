// OpenCode loads a configured plugin directory via root `index.ts` / `tui.ts`
// (package.json `exports` alone is not consulted). Re-export the compiled
// entry so global `file://` installs resolve.
export { default } from "./dist/tui-v2.js";
