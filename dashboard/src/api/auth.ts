import api from './client';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'platform_admin' | 'member';
  mustChangePassword: boolean;
}

export interface Org {
  id: string;
  name: string;
  slug: string;
}

export interface AuthResponse {
  user: User;
  org: Org | null;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const { data } = await api.post<AuthResponse>('/auth/login', { email, password });
  return data;
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout');
}

export async function getMe(): Promise<AuthResponse> {
  const { data } = await api.get<AuthResponse>('/auth/me');
  return data;
}

export async function forceChangePassword(password: string): Promise<void> {
  await api.post('/auth/force-change-password', { password });
}
