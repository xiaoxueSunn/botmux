import { execFile } from 'node:child_process';

/** macOS Dispatch memory-pressure levels exposed by the kernel. */
export type DarwinMemoryPressureLevel = 'normal' | 'warning' | 'critical';

export interface DarwinMemoryPressureSnapshot {
  level: DarwinMemoryPressureLevel;
  rawLevel: number;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  compressorBytesUsed?: number;
}

export type DarwinPressureCommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

const SYSCTL_PATH = '/usr/sbin/sysctl';
const KIB = 1024;
const MIB = 1024 * KIB;
const COMMAND_TIMEOUT_MS = 2_000;
const COMMAND_MAX_BUFFER = 64 * KIB;

function defaultRun(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: COMMAND_MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/**
 * `kern.memorystatus_vm_pressure_level` is a bitmask:
 * 0x01 normal, 0x02 warning, 0x04 critical.
 */
export function parseDarwinMemoryPressureLevel(
  raw: string,
): DarwinMemoryPressureLevel | undefined {
  const level = Number(raw.trim());
  if (!Number.isInteger(level) || level <= 0) return undefined;
  if ((level & 0x04) !== 0) return 'critical';
  if ((level & 0x02) !== 0) return 'warning';
  if ((level & 0x01) !== 0) return 'normal';
  return undefined;
}

function unitMultiplier(unit: string | undefined): number {
  switch ((unit ?? '').toUpperCase()) {
    case 'K': return KIB;
    case 'M': return MIB;
    case 'G': return 1024 * MIB;
    case 'T': return 1024 * 1024 * MIB;
    default: return 1;
  }
}

function parseUnitBytes(value: string, unit: string | undefined): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.round(number * unitMultiplier(unit));
}

export function parseDarwinSwapUsage(raw: string): {
  totalBytes?: number;
  usedBytes?: number;
} {
  const match = raw.match(
    /total\s*=\s*([\d.]+)([KMGT]?)\s+used\s*=\s*([\d.]+)([KMGT]?)/i,
  );
  if (!match) return {};
  return {
    totalBytes: parseUnitBytes(match[1], match[2]),
    usedBytes: parseUnitBytes(match[3], match[4]),
  };
}

/** Parse the three newline-delimited values returned by one bounded sysctl call. */
export function parseDarwinMemoryPressureSnapshot(
  raw: string,
): DarwinMemoryPressureSnapshot | undefined {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 3) return undefined;
  const level = parseDarwinMemoryPressureLevel(lines[0] ?? '');
  const rawLevel = Number(lines[0]?.trim());
  if (!level || !Number.isInteger(rawLevel)) return undefined;

  const swap = parseDarwinSwapUsage(lines[1] ?? '');
  const compressorBytesUsed = Number(lines[2]?.trim());
  return {
    level,
    rawLevel,
    ...(swap.totalBytes === undefined ? {} : { swapTotalBytes: swap.totalBytes }),
    ...(swap.usedBytes === undefined ? {} : { swapUsedBytes: swap.usedBytes }),
    ...(Number.isFinite(compressorBytesUsed) && compressorBytesUsed >= 0
      ? { compressorBytesUsed }
      : {}),
  };
}

/**
 * Read the kernel-owned pressure state plus diagnostic swap/compressor values.
 * This replaces os.freemem() only on Darwin; other platforms keep the existing
 * overload sampler.
 */
export async function readDarwinMemoryPressure(
  run: DarwinPressureCommandRunner = defaultRun,
): Promise<DarwinMemoryPressureSnapshot> {
  try {
    const stdout = await run(SYSCTL_PATH, [
      '-n',
      'kern.memorystatus_vm_pressure_level',
      'vm.swapusage',
      'vm.compressor_bytes_used',
    ], COMMAND_TIMEOUT_MS);
    const snapshot = parseDarwinMemoryPressureSnapshot(stdout);
    if (snapshot) return snapshot;
  } catch {
    // Swap/compressor values are diagnostic-only and may be unavailable on an
    // older Darwin release. Fall through to the mandatory pressure key so an
    // optional metric can never disable alerting.
  }

  const raw = await run(
    SYSCTL_PATH,
    ['-n', 'kern.memorystatus_vm_pressure_level'],
    COMMAND_TIMEOUT_MS,
  );
  const level = parseDarwinMemoryPressureLevel(raw);
  const rawLevel = Number(raw.trim());
  if (!level || !Number.isInteger(rawLevel)) {
    throw new Error('unexpected Darwin memory-pressure sysctl output');
  }
  return { level, rawLevel };
}
