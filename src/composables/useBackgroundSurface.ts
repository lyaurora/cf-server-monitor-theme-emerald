import { useAppStore } from '@/stores/app'

export function useBackgroundSurface() {
  const appStore = useAppStore()

  function pickSurfaceClass(defaultClass: string, customBackgroundClass: string): string {
    return appStore.backgroundEnabled ? customBackgroundClass : defaultClass
  }

  return {
    pickSurfaceClass,
  }
}
