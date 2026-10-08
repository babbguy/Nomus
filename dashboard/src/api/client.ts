import axios from 'axios';

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
      // Session expired — redirect to login (avoid import cycle by using window)
      const path = window.location.pathname;
      if (path !== '/login' && path !== '/forgot-password' && path !== '/reset-password') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  },
);

export default api;
