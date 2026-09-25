// OpenCode loads a configured plugin directory via root `index.ts` / `tui.ts`
// (package.json `exports` alone is not consulted). Re-export the compiled
// entries so global `file://` installs resolve.
export { default } from "./dist/server.js";
