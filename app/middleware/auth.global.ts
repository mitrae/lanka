export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.fetchMe()

  const onLogin = to.path === '/login'
  if (!auth.isAuthenticated) {
    return onLogin ? undefined : navigateTo('/login')
  }
  if (onLogin) {
    return navigateTo(auth.role === 'client' ? '/portal' : '/')
  }
  if (auth.role === 'client' && !to.path.startsWith('/portal')) {
    return navigateTo('/portal')
  }
  if (auth.role !== 'client' && to.path.startsWith('/portal')) {
    return navigateTo('/')
  }
})
