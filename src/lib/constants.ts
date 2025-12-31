export const isProd = import.meta.env.PROD;

const devApiBase = import.meta.env.VITE_API_BASE || "http://localhost:8000";
export const API_BASE = isProd ? "" : devApiBase; // blank in production (same-origin)
