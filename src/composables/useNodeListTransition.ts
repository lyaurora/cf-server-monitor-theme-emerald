import type { VNode } from 'vue'

export function useNodeListTransition() {
  const positions = new WeakMap<Element, { left: string, top: string, width: string, height: string }>()
  const leaving = new Map<Element, HTMLElement>()

  function beforeUpdate(vnode: VNode) {
    const container = vnode.el as HTMLElement
    // Capture every item before any leaving item releases its space.
    for (const child of container.children) {
      const element = child as HTMLElement
      positions.set(element, {
        left: `${element.offsetLeft}px`,
        top: `${element.offsetTop}px`,
        width: `${element.offsetWidth}px`,
        height: `${element.offsetHeight}px`,
      })
    }
  }

  function beforeLeave(element: Element) {
    const container = element.parentElement!
    // Keep scrolling containers from clipping items while they move or fade out.
    if (!container.style.minHeight)
      container.style.minHeight = `${container.offsetHeight}px`
    leaving.set(element, container)
    Object.assign((element as HTMLElement).style, positions.get(element), {
      position: 'absolute',
      pointerEvents: 'none',
    })
  }

  function afterLeave(element: Element) {
    const container = leaving.get(element)
    leaving.delete(element)
    if (container && ![...leaving.values()].includes(container))
      container.style.minHeight = ''
  }

  return { beforeUpdate, beforeLeave, afterLeave }
}
