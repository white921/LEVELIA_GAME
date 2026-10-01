export type ActivityRoute = 'lobby' | 'high-low';

export function routeFromHash(hash: string): ActivityRoute {
  return hash === '#high-low' ? 'high-low' : 'lobby';
}

export function hashForRoute(route: ActivityRoute): string {
  return route === 'high-low' ? '#high-low' : '#lobby';
}

export function navigateTo(route: ActivityRoute): void {
  const hash = hashForRoute(route);
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}
