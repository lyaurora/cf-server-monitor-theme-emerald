import type { VNode } from 'vue'

function resetLeavingStyle(element: Element) {
  const style = (element as HTMLElement).style
  style.position = ''
  style.left = ''
  style.top = ''
  style.width = ''
  style.height = ''
  style.pointerEvents = ''
}

export function useNodeListTransition() {
  const positions = new WeakMap<Element, { left: string, top: string, width: string, height: string }>()
  const leaving = new Map<Element, HTMLElement>()

  function beforeUpdate(vnode: VNode) {
    const container = vnode.el as HTMLElement | null
    if (!container)
      return
    // Capture every non-leaving item before any leaving item releases its space.
    for (const child of container.children) {
      if (leaving.has(child))
        continue
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
    const container = element.parentElement
    if (!container)
      return
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
    // Clear inline styles so elements kept by @leave-cancelled do not stay stuck absolute / unclickable.
    resetLeavingStyle(element)
    if (container && ![...leaving.values()].includes(container))
      container.style.minHeight = ''
  }

  return { beforeUpdate, beforeLeave, afterLeave }
}
