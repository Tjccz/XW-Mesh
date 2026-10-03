import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from './api.js'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('./views/Layout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('./views/Dashboard.vue') },
      { path: 'networks', name: 'networks', component: () => import('./views/Networks.vue') },
      { path: 'subnets', name: 'subnets', component: () => import('./views/Subnets.vue') },
      { path: 'acl', name: 'acl', component: () => import('./views/Acl.vue') },
      { path: 'nodes', name: 'nodes', component: () => import('./views/Nodes.vue') },
      { path: 'nodes/:id', name: 'node-detail', component: () => import('./views/NodeDetail.vue') },
      {
        path: 'access-keys',
        name: 'access-keys',
        component: () => import('./views/AccessKeys.vue'),
      },
      { path: 'metrics', name: 'metrics', component: () => import('./views/Metrics.vue') },
      { path: 'usage', name: 'usage', component: () => import('./views/Usage.vue') },
      { path: 'alerts', name: 'alerts', component: () => import('./views/Alerts.vue') },
      { path: 'audit', name: 'audit', component: () => import('./views/Audit.vue') },
      { path: 'workspace', name: 'workspace', component: () => import('./views/Workspace.vue') },
      { path: 'members', name: 'members', component: () => import('./views/Members.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  if (to.meta.public) return true
  if (!getToken()) return { name: 'login' }
  return true
})

export default router
