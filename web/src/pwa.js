// Service-worker registration and the "install this app" prompt.
//
// Only registered in a production build: in dev the worker would cache Vite's
// module graph and fight HMR for no benefit.

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');

      // A worker that installs while an old one is controlling the page stays
      // in "waiting" until every tab closes. The panel is a single long-lived
      // tab, so nudge it through instead and let controllerchange reload.
      const promote = (worker) => {
        if (worker?.state === 'installed' && navigator.serviceWorker.controller) {
          worker.postMessage('skip-waiting');
        }
      };
      promote(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => promote(worker));
      });
    } catch {
      // No worker means no offline shell — the panel itself still works.
    }
  });

  // Only a *replacement* worker should reload the page. The very first one
  // claims an already-loaded page, and reloading on that would be a flash for
  // no reason.
  let reloading = false;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// Chromium fires beforeinstallprompt when the app qualifies for installation;
// stashing the event is the only way to trigger the prompt later from a click.
// Safari has no equivalent — there the Share sheet is the install path.
export function watchInstallPrompt(onChange) {
  const onPrompt = (e) => {
    e.preventDefault();
    onChange(e);
  };
  const onInstalled = () => onChange(null);

  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onInstalled);
  };
}
