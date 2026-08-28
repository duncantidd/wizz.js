export function createRouter({ routes, target, window, document }) {
  let currentComponent = null;
  let notFoundNode = null;

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

  function renderNotFound() {
    notFoundNode = document.createElement('main');
    notFoundNode.textContent = 'Not found';
    target.appendChild(notFoundNode);
  }

  async function render() {
    clearCurrentView();

    const loadComponent = routes[window.location.pathname];
    if (!loadComponent) {
      renderNotFound();
      return;
    }

    const module = await loadComponent();
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