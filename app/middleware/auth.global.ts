export default defineNuxtRouteMiddleware(async (to) => {
  const PUBLIC = new Set(['/login', '/forgot-password', '/reset-password'])
  const auth = useAuthStore()
  if (!auth.ready) await auth.fetchMe()

  if (PUBLIC.has(to.path)) {
    // Signed-in users don't need the public auth pages — send them home.
    if (auth.isAuthenticated) {
      return navigateTo(auth.role === 'client' ? '/portal' : '/')
    }
    return
  }

  if (!auth.isAuthenticated) return navigateTo('/login')
  if (auth.role === 'client' && !to.path.startsWith('/portal')) return navigateTo('/portal')
  if (auth.role !== 'client' && to.path.startsWith('/portal')) return navigateTo('/')
})
