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
  // Resolved here, in a real component setup: the dialog is mounted as its own
  // Vue app below, which has no access to the Nuxt app's i18n plugin — a `$t`
  // call inside ConfirmDialog throws mid-render and silently drops the rest of
  // the footer (this is how the Cancel button went missing).
  const { t } = useI18n()

  return (options: ConfirmOptions): Promise<boolean> => {
    const resolved: ConfirmOptions = {
      ...options,
      confirmLabel: options.confirmLabel ?? t('common.confirm'),
      cancelLabel: options.cancelLabel ?? t('common.cancel')
    }
    return new Promise((resolve) => {
      const open = ref(true)
      const mount = document.createElement('div')
      document.body.appendChild(mount)
      const app = createApp({
        setup() {
          return () =>
            h(ConfirmDialog as any, {
              modelValue: open.value,
              options: resolved,
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
