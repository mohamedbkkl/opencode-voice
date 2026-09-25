/**
 * Process-wide single-registration guard.
 *
 * The plugin can be registered twice in one process (e.g. a global
 * `file://…dist/…` entry plus a project-local `.opencode/plugins` shim).
 * The two copies are different module instances, so a module-level flag
 * would not be shared — `Symbol.for` is process-global and works across
 * both. Separate OpenCode windows are separate processes and correctly load
 * once each. Returns true for the first caller, false afterwards.
 */
const claimed = new Set<symbol>();

export function claimProcessSlot(name: string): boolean {
  const key = Symbol.for(name);
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

/**
 * @internal Test-only escape hatch: `Symbol.for` entries are process-global
 * with no delete API, so suites that set up the plugin more than once in one
 * process must reset between cases. Never call outside tests.
 */
export function __resetProcessSlots(): void {
  claimed.clear();
}
