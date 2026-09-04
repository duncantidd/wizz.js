import { createRouter } from './router.js';
import { pageModules } from './routes.js';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Wizz could not find mount target "#app".');
}

const routes = Object.fromEntries(
  pageModules.map(({ routePath, modulePath }) => [routePath, () => import(modulePath)])
);

const router = createRouter({ routes, target, window, document });
void router.render();