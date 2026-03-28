import type { RealtimeProvider } from "@/lib/realtime-config";

export function normalizeRealtimeProvider(value: unknown): RealtimeProvider | null {
  return value === "openai" || value === "gemini" ? value : null;
}

export function getAvailableRealtimeProviders(): RealtimeProvider[] {
  const providers: RealtimeProvider[] = [];

  if (process.env.OPENAI_API_KEY) {
    providers.push("openai");
  }

  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    providers.push("gemini");
  }

  return providers;
}

export function getRealtimeProviderErrorMessage() {
  return "No supported realtime API key is configured on the server. Set OPENAI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.";
}

export function resolveConfiguredRealtimeProvider(requested?: unknown): RealtimeProvider | null {
  const availableProviders = getAvailableRealtimeProviders();
  const requestedProvider = normalizeRealtimeProvider(requested);

  if (requestedProvider && availableProviders.includes(requestedProvider)) {
    return requestedProvider;
  }

  const envProvider = normalizeRealtimeProvider(process.env.REALTIME_PROVIDER);
  if (envProvider && availableProviders.includes(envProvider)) {
    return envProvider;
  }

  if (availableProviders.length === 0) {
    return null;
  }

  if (availableProviders.length === 1) {
    return availableProviders[0];
  }

  return availableProviders.includes("openai") ? "openai" : availableProviders[0];
}
