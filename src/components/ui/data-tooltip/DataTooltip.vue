<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useElementSize } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, useId, useSlots, watch } from 'vue'
import { cn } from '@/lib/utils'

type DataTooltipPlacement = 'top' | 'bottom' | 'left' | 'right' | 'cursor'

interface Props {
  /** 提示文本，留空且无 #content 插槽时不渲染气泡 */
  content?: string
  /** 气泡方位；cursor 跟随指针并保持在视口内 */
  placement?: DataTooltipPlacement
  /** 气泡宽度，number 视为 px；默认由内容撑起 */
  width?: number | string
  /** 气泡高度，number 视为 px；默认由内容撑起 */
  height?: number | string
  /** 包裹元素标签，默认 div */
  as?: string
  /** 包裹元素的附加类 */
  class?: HTMLAttributes['class']
  /** 气泡的附加类 */
  contentClass?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  placement: 'top',
  as: 'div',
})
const slots = useSlots()

const rootRef = ref<HTMLElement | null>(null)
const tooltipRef = ref<HTMLElement | null>(null)
const tooltipId = useId()
const cursor = ref({ x: 0, y: 0 })
const { width: tooltipWidth, height: tooltipHeight } = useElementSize(tooltipRef, undefined, { box: 'border-box' })
const isOpen = ref(false)
const isHoverOpen = ref(false)
let lastTouchOpenAt = 0
let shouldStopNextClick = false

const hasTooltip = computed(() => Boolean(props.content || slots.content))

const placementClass: Record<DataTooltipPlacement, string> = {
  top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-2 -translate-x-1/2',
  left: 'top-1/2 right-full mr-2 -translate-y-1/2',
  right: 'top-1/2 left-full ml-2 -translate-y-1/2',
  cursor: '',
}

const cursorStyle = computed(() => {
  if (props.placement !== 'cursor' || typeof window === 'undefined')
    return {}
  return {
    left: `${Math.max(8, Math.min(cursor.value.x + 12, window.innerWidth - tooltipWidth.value - 8))}px`,
    top: `${Math.max(8, Math.min(cursor.value.y + 16, window.innerHeight - tooltipHeight.value - 8))}px`,
  }
})

function updateCursor(event: PointerEvent | FocusEvent) {
  if (props.placement !== 'cursor')
    return
  const rect = rootRef.value?.getBoundingClientRect()
  cursor.value = 'clientX' in event
    ? { x: event.clientX, y: event.clientY }
    : { x: rect?.right ?? 0, y: rect?.bottom ?? 0 }
}

const sizeStyle = computed(() => {
  const style: Record<string, string> = {}
  if (props.width != null)
    style.width = typeof props.width === 'number' ? `${props.width}px` : props.width
  if (props.height != null)
    style.height = typeof props.height === 'number' ? `${props.height}px` : props.height
  return style
})

function isTouchLikePointer(event: PointerEvent) {
  const hasCoarsePointer = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: none), (pointer: coarse)').matches

  return event.pointerType !== 'mouse' || hasCoarsePointer
}

function closeTooltip() {
  isOpen.value = false
  isHoverOpen.value = false
}

function removeDocumentListeners() {
  if (typeof document === 'undefined')
    return

  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  document.removeEventListener('keydown', handleDocumentKeydown, true)
  document.removeEventListener('scroll', handleDocumentScroll, true)
  window.removeEventListener('resize', closeTooltip)
}

function handleDocumentPointerDown(event: PointerEvent) {
  const root = rootRef.value
  if (!root || !event.target || root.contains(event.target as Node))
    return

  closeTooltip()
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape')
    closeTooltip()
}

function handleDocumentScroll() {
  const target = document.elementFromPoint(cursor.value.x, cursor.value.y)
  if (!target || !rootRef.value?.contains(target))
    closeTooltip()
}

function handlePointerDown(event: PointerEvent) {
  if (!hasTooltip.value || !isTouchLikePointer(event))
    return

  updateCursor(event)
  lastTouchOpenAt = Date.now()
  shouldStopNextClick = true
  isOpen.value = !isOpen.value
}

function handleClick(event: MouseEvent) {
  if (shouldStopNextClick && Date.now() - lastTouchOpenAt < 800)
    event.stopPropagation()
  else
    closeTooltip()

  shouldStopNextClick = false
}

function openHoverTooltip(event: PointerEvent | FocusEvent) {
  if ('pointerType' in event && isTouchLikePointer(event))
    return
  if (!('pointerType' in event)) {
    // Restoring dialog focus must not revive the dismissed tooltip, including after Escape.
    const target = event.target as HTMLElement
    const previousDialog = event.relatedTarget instanceof Element
      ? event.relatedTarget.closest('[role="dialog"], [role="alertdialog"]')
      : null
    if (!target?.matches(':focus-visible') || (previousDialog && !previousDialog.contains(target))) {
      return
    }
  }
  updateCursor(event)
  if (hasTooltip.value)
    isHoverOpen.value = true
}

function closeHoverTooltip() {
  isHoverOpen.value = false
}

watch(() => isOpen.value || isHoverOpen.value, (open) => {
  if (typeof document === 'undefined')
    return

  if (open) {
    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    document.addEventListener('keydown', handleDocumentKeydown, true)
    if (props.placement === 'cursor') {
      document.addEventListener('scroll', handleDocumentScroll, true)
      window.addEventListener('resize', closeTooltip)
    }
    return
  }

  removeDocumentListeners()
})

watch(hasTooltip, (value) => {
  if (!value)
    closeTooltip()
})

onBeforeUnmount(removeDocumentListeners)
</script>

<template>
  <component
    :is="as"
    ref="rootRef"
    data-slot="data-tooltip"
    :data-state="isOpen ? 'open' : 'closed'"
    :aria-describedby="hasTooltip && (isOpen || isHoverOpen) ? tooltipId : undefined"
    :class="cn('group/data-tooltip relative inline-block', props.class)"
    @pointerdown.capture="handlePointerDown"
    @pointermove="openHoverTooltip"
    @pointerleave="closeHoverTooltip"
    @focusin="openHoverTooltip"
    @focusout="closeHoverTooltip"
    @click="handleClick"
  >
    <slot />
    <Teleport to="body" :disabled="placement !== 'cursor'">
      <span
        v-if="hasTooltip && (isOpen || isHoverOpen)"
        :id="tooltipId"
        ref="tooltipRef"
        role="tooltip"
        :class="cn(
          'pointer-events-none rounded bg-foreground/80 p-1 text-[10px] leading-none text-background shadow-lg',
          placement === 'cursor'
            ? 'fixed z-50 w-max whitespace-nowrap'
            : ['absolute z-20 hidden group-hover/data-tooltip:block group-focus-within/data-tooltip:block whitespace-normal break-words', isOpen && 'block', placementClass[placement]],
          props.contentClass,
        )"
        :style="[sizeStyle, cursorStyle]"
      >
        <slot name="content">{{ content }}</slot>
      </span>
    </Teleport>
  </component>
</template>
