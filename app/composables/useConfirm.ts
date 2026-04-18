// app/composables/useConfirm.ts
import { ref, createApp, h } from 'vue'
import ConfirmDialog from '~/app/components/ConfirmDialog.vue'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export function useConfirm() {
  return (options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const open = ref(true)
      const mount = document.createElement('div')
      document.body.appendChild(mount)
      const app = createApp({
        setup() {
          return () =>
            h(ConfirmDialog as any, {
              modelValue: open.value,
              options,
              'onUpdate:modelValue': (v: boolean) => (open.value = v),
              onResolve: (v: boolean) => {
                setTimeout(() => {
                  app.unmount()
                  mount.remove()
                  resolve(v)
                }, 150)
              }
            })
        }
      })
      app.mount(mount)
    })
  }
}
