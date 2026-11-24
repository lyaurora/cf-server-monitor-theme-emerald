import { createSharedComposable, useDevicePixelRatio, useMediaQuery } from '@vueuse/core'

export const useCoarsePointer = createSharedComposable(() => useMediaQuery('(hover: none), (pointer: coarse)'))
export const useSharedDevicePixelRatio = createSharedComposable(useDevicePixelRatio)

const elementWidthCallbacks = new WeakMap<Element, (width: number) => void>()
let sharedResizeObserver: ResizeObserver | null = null

export function observeElementWidth(el: Element, callback: (width: number) => void): () => void {
  if (typeof ResizeObserver === 'undefined') {
    callback(el.getBoundingClientRect().width)
    return () => {}
  }
  sharedResizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const cb = elementWidthCallbacks.get(entry.target)
      cb?.(entry.contentRect.width)
    }
  })
  elementWidthCallbacks.set(el, callback)
  sharedResizeObserver.observe(el)
  return () => {
    elementWidthCallbacks.delete(el)
    sharedResizeObserver?.unobserve(el)
  }
}
