/**
 * Standalone diagnostics CLI: `npm run diagnose`.
 * Prints provider / model / microphone status without starting OpenCode.
 */
import { loadConfig } from "../src/core/config.js";
import { diagnose, formatDiagnostics } from "../src/core/diagnostics.js";
import { createProvider } from "../src/providers/provider.js";
import { selectProvider } from "../src/providers/index.js";
import "../src/providers/whisper-cpp.js";
import "../src/providers/transcribe-cpp.js";
import { createDefaultRecorder } from "../src/recorder/ffmpeg.js";

async function main(): Promise<void> {
  const { config, source } = loadConfig({ cwd: process.cwd() });
  const selection = await selectProvider(config).catch(() => undefined);
  const provider =
    selection?.provider ??
    createProvider(config.provider, config) ??
    createProvider("whisper.cpp", config);
  const recorder = await createDefaultRecorder().catch(() => undefined);
  if (!provider) {
    console.log(`OpenCode Voice\n\nUnknown provider "${config.provider}".`);
    process.exitCode = 1;
    return;
  }
  const diagnostics = await diagnose({ config, provider, recorder });
  console.log(formatDiagnostics(diagnostics));
  if (source) console.log(`\nConfig: ${source}`);
  else console.log("\nConfig: defaults (no config file found)");
  process.exitCode = diagnostics.ready ? 0 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
