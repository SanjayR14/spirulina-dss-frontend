import api from "../lib/axios";

export interface LoginPayload {
  email: string;
  password: string;
}

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
}

export const loginUser = (data: LoginPayload) =>
  api.post("/auth/login", data);

export const registerUser = (data: RegisterPayload) =>
  api.post("/auth/register", data);
