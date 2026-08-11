import { freemem, loadavg, totalmem } from 'node:os';
import {
  readDarwinMemoryPressure,
  type DarwinMemoryPressureSnapshot,
} from './darwin-memory-pressure.js';
import type { HostReading } from './host-overload-alert.js';

export interface HostOverloadSamplerDeps {
  platform?: NodeJS.Platform;
  load15?: () => number;
  totalmem?: () => number;
  freemem?: () => number;
  readDarwinPressure?: () => Promise<DarwinMemoryPressureSnapshot>;
}

export function hostOverloadSampleIntervalMs(platform: NodeJS.Platform): number {
  return platform === 'darwin' ? 5_000 : 30_000;
}

/**
 * Route one overload sample by platform. Darwin deliberately leaves physical
 * total/free at zero so the generic os.freemem() threshold is inert; the kernel
 * pressure state is authoritative. Linux and other platforms keep the exact
 * pre-existing load + total/free behavior.
 */
export async function readHostOverloadSample(
  deps: HostOverloadSamplerDeps = {},
): Promise<HostReading> {
  const platform = deps.platform ?? process.platform;
  const readLoad15 = deps.load15 ?? (() => loadavg()[2] ?? 0);

  if (platform === 'darwin') {
    const pressure = await (deps.readDarwinPressure ?? readDarwinMemoryPressure)();
    return {
      load15: readLoad15(),
      memTotalBytes: 0,
      memFreeBytes: 0,
      memoryPressureLevel: pressure.level,
      // Keep swap absolute usage diagnostic-only on Darwin. The kernel pressure
      // level remains the single memory-danger decision signal.
      swapUsedBytes: pressure.swapUsedBytes,
      compressorBytesUsed: pressure.compressorBytesUsed,
    };
  }

  return {
    load15: readLoad15(),
    memTotalBytes: (deps.totalmem ?? totalmem)(),
    memFreeBytes: (deps.freemem ?? freemem)(),
  };
}
