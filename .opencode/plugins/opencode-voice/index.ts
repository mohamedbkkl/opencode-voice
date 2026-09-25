// OpenCode V2 loads this project-local entry directly. Use the compiled
// package entry because `src/server-v2.ts` only exports the named setup
// function and is not itself a plugin definition.
export { default } from "../../../dist/server.js";
