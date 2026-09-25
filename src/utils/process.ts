/** Small process/filesystem helpers shared by recorders and providers. */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stdin content (closes stdin afterwards) or "ignore". */
  stdin?: string | "ignore";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Max bytes retained per stream (default 1 MiB). */
  maxBufferBytes?: number;
}

/** Read an executable path from the environment (undefined when unset/empty). */
export function envExecutable(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : undefined;
}

/** Find an executable on PATH (plus extra dirs), like `which`. */
export function which(
  names: string[],
  extraDirs: string[] = [],
): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  const dirs = [
    ...extraDirs,
    ...pathEnv.split(path.delimiter).filter(Boolean),
  ];
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const name of names) {
    if (path.isAbsolute(name)) {
      if (isExecutable(name)) return name;
      continue;
    }
    if (name.includes("/") || (process.platform === "win32" && name.includes("\\"))) {
      const abs = path.resolve(name);
      if (isExecutable(abs)) return abs;
      continue;
    }
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = path.join(dir, `${name}${ext}`);
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Run a command to completion, capturing output. Supports timeout and
 * AbortSignal cancellation (SIGTERM, escalating to SIGKILL).
 */
export function runCommand(
  executable: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  // `.cmd`/`.bat` files cannot be spawned directly on Windows; run them
  // through the shell so Node builds the correct `cmd.exe /d /s /c` line.
  const windowsScript =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(executable, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(windowsScript ? { shell: true } : {}),
    });
    const cap = options.maxBufferBytes ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    let timeout: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);
      timeout.unref?.();
    }

    const onAbort = (): void => {
      killTree(child);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= cap) return;
      const text = chunk.toString("utf8");
      const room = cap - stdoutBytes;
      const slice = text.slice(0, room);
      stdout += slice;
      stdoutBytes += Buffer.byteLength(slice);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= cap) return;
      const text = chunk.toString("utf8");
      const room = cap - stderrBytes;
      const slice = text.slice(0, room);
      stderr += slice;
      stderrBytes += Buffer.byteLength(slice);
    });
    child.on("error", () => {
      // Emitted when the executable cannot start; `close` follows.
    });
    child.on("close", (code, sig) => finish(code, sig));

    if (options.stdin === "ignore" || options.stdin === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(options.stdin);
    }
  });
}

/** SIGTERM now, SIGKILL after a short grace period. */
export function killTree(child: ChildProcess, graceMs = 1500): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* fall through to the direct kill below */
    }
  }
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }, graceMs);
  timer.unref?.();
}

/** Create a unique temp file path (file itself is NOT created). */
export async function tempFile(prefix: string, suffix: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `${prefix}-`),
  );
  void dir;
  // mkdtemp creates the dir; place the file inside it.
  const base = path.basename(dir);
  return path.join(dir, `${base}${suffix}`);
}

/** Best-effort delete (file or directory), never throws. */
export async function removeQuietly(target: string | undefined): Promise<void> {
  if (!target) return;
  try {
    const stat = await fs.promises.stat(target).catch(() => undefined);
    if (!stat) return;
    if (stat.isDirectory()) {
      await fs.promises.rm(target, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(target);
    }
  } catch {
    /* best effort */
  }
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function fileSize(target: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(target);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/** Stable per-process instance id: `<hostname>:<pid>:<startTime>`. */
let cachedInstanceID: string | undefined;
export function instanceID(): string {
  if (!cachedInstanceID) {
    cachedInstanceID = `${os.hostname()}:${process.pid}:${Math.floor(process.uptime() * 1000)}`;
  }
  return cachedInstanceID;
}
