/**
 * WebGPU is the whole requirement for the downloadable models: no adapter, no local inference.
 *
 * Two questions, because they have different costs and different answers. Whether the API exists
 * is synchronous and decides what the picker lists. Whether an adapter can actually be had is
 * async, and is the one that matters — a browser can expose `navigator.gpu` and still hand back
 * nothing, on a blocklisted driver or a machine with no usable GPU at all.
 */

interface GpuNavigator {
  gpu?: { requestAdapter(): Promise<unknown | null> }
}

export function hasWebGpu(): boolean {
  return (navigator as GpuNavigator).gpu != null
}

export async function hasGpuAdapter(): Promise<boolean> {
  const gpu = (navigator as GpuNavigator).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}
