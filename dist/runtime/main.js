import { createRouter } from './router.js';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Wizz could not find mount target "#app".');
}

const routes = {
  '/': () => import('../App.js'),
  '/Home': () => import('../pages/Home.js')
};

const router = createRouter({ routes, target, window, document });
void router.render();