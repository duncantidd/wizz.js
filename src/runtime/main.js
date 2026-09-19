import { createRouter } from './router.js';
import { pageModules } from './routes.js';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Wizz could not find mount target "#app".');
}

const routes = Object.fromEntries(
  pageModules.map(({ routePath, modulePath }) => [routePath, () => import(modulePath)])
);

// Server-renderable pages ship a hydratable client build; the router uses it
// on the first render to adopt the markup the dev server delivered instead
// of mounting a second root beside it.
const hydratableRoutes = Object.fromEntries(
  pageModules
    .filter(({ hydratableModulePath }) => hydratableModulePath)
    .map(({ routePath, hydratableModulePath }) => [routePath, () => import(hydratableModulePath)])
);

const router = createRouter({ routes, hydratableRoutes, target, window, document });
void router.render();