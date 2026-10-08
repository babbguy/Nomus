import axios from 'axios';
import { shouldRedirectToLogin } from './auth-redirect';

const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Global error interceptor — handles session expiry and rate limiting
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Session expired on a protected page: go to login (window, not the
      // router, to avoid an import cycle). Public pages and the app's
      // session probe never redirect; see auth-redirect.ts.
      if (shouldRedirectToLogin(window.location.pathname, err.config?.url)) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  },
);

export default api;
