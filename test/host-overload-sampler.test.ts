import { describe, expect, it, vi } from 'vitest';
import {
  hostOverloadSampleIntervalMs,
  readHostOverloadSample,
} from '../src/core/host-overload-sampler.js';

describe('host-overload platform sampler', () => {
  it('uses the 5-second Darwin interval and preserves 30 seconds elsewhere', () => {
    expect(hostOverloadSampleIntervalMs('darwin')).toBe(5_000);
    expect(hostOverloadSampleIntervalMs('linux')).toBe(30_000);
    expect(hostOverloadSampleIntervalMs('win32')).toBe(30_000);
  });

  it('uses kernel pressure on Darwin and never consults os.freemem inputs', async () => {
    const total = vi.fn(() => 36 * 1024 ** 3);
    const free = vi.fn(() => 1);
    await expect(readHostOverloadSample({
      platform: 'darwin',
      load15: () => 3,
      totalmem: total,
      freemem: free,
      readDarwinPressure: async () => ({
        level: 'warning',
        rawLevel: 2,
        swapTotalBytes: 7 * 1024 ** 3,
        swapUsedBytes: 6 * 1024 ** 3,
        compressorBytesUsed: 10 * 1024 ** 3,
      }),
    })).resolves.toEqual({
      load15: 3,
      memTotalBytes: 0,
      memFreeBytes: 0,
      memoryPressureLevel: 'warning',
      swapUsedBytes: 6 * 1024 ** 3,
      compressorBytesUsed: 10 * 1024 ** 3,
    });
    expect(total).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
  });

  it('keeps swap total out of Darwin decisions', async () => {
    const reading = await readHostOverloadSample({
      platform: 'darwin',
      readDarwinPressure: async () => ({
        level: 'normal',
        rawLevel: 1,
        swapTotalBytes: 100,
        swapUsedBytes: 99,
      }),
    });
    expect(reading.swapTotalBytes).toBeUndefined();
    expect(reading.swapUsedBytes).toBe(99);
  });

  it('preserves the pre-existing load plus total/free sample on Linux', async () => {
    const readDarwinPressure = vi.fn();
    await expect(readHostOverloadSample({
      platform: 'linux',
      load15: () => 12.5,
      totalmem: () => 1_000,
      freemem: () => 125,
      readDarwinPressure,
    })).resolves.toEqual({
      load15: 12.5,
      memTotalBytes: 1_000,
      memFreeBytes: 125,
    });
    expect(readDarwinPressure).not.toHaveBeenCalled();
  });

  it('propagates a failed Darwin sample instead of falling back to os.freemem', async () => {
    await expect(readHostOverloadSample({
      platform: 'darwin',
      freemem: () => 1,
      readDarwinPressure: async () => { throw new Error('sysctl timeout'); },
    })).rejects.toThrow('sysctl timeout');
  });
});
