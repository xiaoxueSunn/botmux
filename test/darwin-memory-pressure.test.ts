import { describe, expect, it, vi } from 'vitest';
import {
  parseDarwinMemoryPressureLevel,
  parseDarwinMemoryPressureSnapshot,
  parseDarwinSwapUsage,
  readDarwinMemoryPressure,
} from '../src/core/darwin-memory-pressure.js';

const MIB = 1024 ** 2;

describe('Darwin memory-pressure parsing', () => {
  it('maps kernel bitmasks to normal, warning, and critical', () => {
    expect(parseDarwinMemoryPressureLevel('1')).toBe('normal');
    expect(parseDarwinMemoryPressureLevel('2')).toBe('warning');
    expect(parseDarwinMemoryPressureLevel('4')).toBe('critical');
    expect(parseDarwinMemoryPressureLevel('6')).toBe('critical');
  });

  it('rejects zero, unknown bits, and malformed values', () => {
    expect(parseDarwinMemoryPressureLevel('0')).toBeUndefined();
    expect(parseDarwinMemoryPressureLevel('8')).toBeUndefined();
    expect(parseDarwinMemoryPressureLevel('garbage')).toBeUndefined();
  });

  it('parses decimal swap units', () => {
    expect(parseDarwinSwapUsage('total = 7.00G  used = 512.00M  free = 6.50G')).toEqual({
      totalBytes: 7 * 1024 * MIB,
      usedBytes: 512 * MIB,
    });
  });

  it('returns no swap metrics for an unknown format', () => {
    expect(parseDarwinSwapUsage('swap unavailable')).toEqual({});
  });

  it('parses pressure, swap, and compressor from one sysctl response', () => {
    expect(parseDarwinMemoryPressureSnapshot([
      '2',
      'total = 7168.00M  used = 6112.00M  free = 1056.00M  (encrypted)',
      '10846609408',
    ].join('\n'))).toEqual({
      level: 'warning',
      rawLevel: 2,
      swapTotalBytes: 7168 * MIB,
      swapUsedBytes: 6112 * MIB,
      compressorBytesUsed: 10846609408,
    });
  });

  it('fails closed on an incomplete snapshot', () => {
    expect(parseDarwinMemoryPressureSnapshot('2\ntotal = 0M')).toBeUndefined();
  });

  it('uses one bounded absolute-path sysctl call', async () => {
    const run = vi.fn(async () => [
      '1',
      'total = 0.00M  used = 0.00M  free = 0.00M',
      '1234',
    ].join('\n'));

    await expect(readDarwinMemoryPressure(run)).resolves.toMatchObject({
      level: 'normal',
      compressorBytesUsed: 1234,
    });
    expect(run).toHaveBeenCalledWith('/usr/sbin/sysctl', [
      '-n',
      'kern.memorystatus_vm_pressure_level',
      'vm.swapusage',
      'vm.compressor_bytes_used',
    ], 2_000);
  });

  it('falls back to the mandatory pressure key when diagnostics are unavailable', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('unknown oid vm.compressor_bytes_used'))
      .mockResolvedValueOnce('4\n');

    await expect(readDarwinMemoryPressure(run)).resolves.toEqual({
      level: 'critical',
      rawLevel: 4,
    });
    expect(run).toHaveBeenNthCalledWith(2, '/usr/sbin/sysctl', [
      '-n',
      'kern.memorystatus_vm_pressure_level',
    ], 2_000);
  });

  it('fails closed when even the mandatory pressure key is malformed', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('incomplete')
      .mockResolvedValueOnce('garbage');
    await expect(readDarwinMemoryPressure(run)).rejects.toThrow('unexpected Darwin');
  });
});
