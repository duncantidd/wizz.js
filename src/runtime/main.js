import mountComponent from '../App.js';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Wizz could not find mount target "#app".');
}

mountComponent(target);