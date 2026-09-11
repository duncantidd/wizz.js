export function createRouter({ routes, hydratableRoutes = {}, target, window, document }) {
  let currentComponent = null;
  let notFoundNode = null;
  // Only the first render can hydrate: the dev server delivers server markup
  // with a serialized state script for the initial document load, while later
  // navigations always mount fresh.
  let isFirstRender = true;
  // Renders are async and un-awaited, so a render whose import resolves after
  // a newer render started must not touch the DOM. Each render captures a
  // monotonic token and abandons itself if a newer render superseded it.
  let renderSequence = 0;

  function clearCurrentView() {
    if (currentComponent) {
      currentComponent.destroy();
      currentComponent = null;
    }

    if (notFoundNode) {
      target.removeChild(notFoundNode);
      notFoundNode = null;
    }
  }

  function clearTarget() {
    for (const node of [...target.childNodes]) {
      target.removeChild(node);
    }
  }

  // Reads the serialized initial state the dev server places beside the mount
  // point and removes the script, whose payload is consumed by this read.
  // Malformed payloads behave like an absent state so the route mounts fresh.
  function findInitialState() {
    const stateScript = document.querySelector('script[type="application/wizz-state"]');
    if (!stateScript) return null;

    let state = null;
    try {
      state = JSON.parse(stateScript.textContent);
    } catch {
      state = null;
    }
    stateScript.remove();
    return { state };
  }

  function renderNotFound() {
    notFoundNode = document.createElement('main');
    notFoundNode.textContent = 'Not found';
    target.appendChild(notFoundNode);
  }

  async function render() {
    const isHydrationCandidate = isFirstRender;
    isFirstRender = false;
    const token = ++renderSequence;

    clearCurrentView();

    const pathname = window.location.pathname;
    const loadComponent = routes[pathname];
    if (!loadComponent) {
      // A document delivered for a route the router cannot claim must not
      // keep its server markup beside the not-found message.
      if (isHydrationCandidate && findInitialState()) {
        clearTarget();
      }
      renderNotFound();
      return;
    }

    if (isHydrationCandidate) {
      const delivery = findInitialState();
      const loadHydratable = hydratableRoutes[pathname];

      if (delivery && loadHydratable && delivery.state !== null) {
        try {
          const hydrateModule = await loadHydratable();
          if (token !== renderSequence) return;
          // Hydratable modules self-fallback: on any adoption mismatch they
          // warn once, clear the target, and remount internally.
          if (hydrateModule && typeof hydrateModule.hydrateComponent === 'function') {
            currentComponent = hydrateModule.hydrateComponent(target, {}, delivery.state);
            return;
          }
        } catch {
          // Adoption is best-effort: anything that fails below falls through
          // to a fresh client mount.
        }
      }

      // Server markup that will not be hydrated must be dropped before the
      // client mounts, or the fresh root would appear beside it.
      if (delivery) {
        if (token !== renderSequence) return;
        clearTarget();
      }
    }

    const module = await loadComponent();
    if (token !== renderSequence) return;
    currentComponent = module.default(target);
  }

  async function navigate(pathname) {
    window.history.pushState({}, '', pathname);
    await render();
  }

  function onPopState() {
    void render();
  }

  window.addEventListener('popstate', onPopState);

  return {
    destroy() {
      window.removeEventListener('popstate', onPopState);
      clearCurrentView();
    },
    navigate,
    render
  };
}
