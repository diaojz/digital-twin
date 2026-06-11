/**
 * 路由地基（区域 H）
 * 三条路由：
 *   /        —— 入口分流：吸收 URL ?code= → localStorage，再按已存角色重定向
 *   /child   —— 子女端控制台（C1-C5）
 *   /parent  —— 父母端流（P1-P4）
 *
 * 角色记忆走 localStorage.twin_role；口令走 localStorage.twin_code。
 * 进 /child 写 child、进 /parent 写 parent，刷新后回到同一端。
 */
import { createRouter, createWebHashHistory } from 'vue-router';

const STORAGE_ROLE = 'twin_role';
const STORAGE_CODE = 'twin_code';

/**
 * 从当前 URL 吸收 ?code= 存进 localStorage（线上口令模式）。
 * hash 路由下 code 可能落在 location.search（http://host/?code=x#/child）
 * 也可能落在 hash 段的 query（http://host/#/child?code=x），两处都扫。
 * 存完不主动清 URL，交由后续请求层透传；幂等。
 */
function absorbCodeFromUrl() {
  try {
    let code = new URLSearchParams(window.location.search).get('code');
    if (!code) {
      const h = window.location.hash || '';
      const qi = h.indexOf('?');
      if (qi !== -1) code = new URLSearchParams(h.slice(qi + 1)).get('code');
    }
    if (code) localStorage.setItem(STORAGE_CODE, code);
  } catch (_) {}
}

const routes = [
  {
    path: '/',
    name: 'entry',
    // 入口本身不渲染组件，beforeEnter 里决定去向
    redirect: () => {
      absorbCodeFromUrl();
      let role = null;
      try { role = localStorage.getItem(STORAGE_ROLE); } catch (_) {}
      return role === 'parent' ? '/parent' : '/child';
    },
  },
  {
    path: '/child',
    name: 'child',
    component: () => import('./views/child/ChildHome.vue'),
    meta: { role: 'child' },
  },
  {
    path: '/parent',
    name: 'parent',
    component: () => import('./views/parent/ParentHome.vue'),
    meta: { role: 'parent' },
  },
  // 兜底：未知路径回入口分流
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

// 用 hash 历史：/#/child、/#/parent 可直接深链 + 刷新稳定，
// 不依赖后端 SPA fallback（server.js 由区域 E 接管，不在本区域职责内）。
const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 进任意一端时，把角色写回 localStorage，供请求层带 X-Twin-Role 头 + 刷新记忆
router.beforeEach((to) => {
  // 每次导航都顺手吸一次 code（直接落在 /child?code= 这种链接也兼容）
  absorbCodeFromUrl();
  const role = to.meta && to.meta.role;
  if (role) {
    try { localStorage.setItem(STORAGE_ROLE, role); } catch (_) {}
  }
  return true;
});

export default router;
