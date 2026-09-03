import { FireflyProvider } from "./firefly.js";
import { GeminiImageProvider } from "./gemini.js";
import { OpenAIImageProvider } from "./openai.js";
import type { ImageProvider, ProviderId, ProviderOption, ProviderStatus } from "./types.js";

type ProviderEnvironment = NodeJS.ProcessEnv;
type ProviderFactory = (id: ProviderId, env: ProviderEnvironment) => ImageProvider | null;

const PROVIDERS: Array<Pick<ProviderOption, "id" | "label">> = [
  { id: "firefly", label: "Adobe Firefly" },
  { id: "openai", label: "OpenAI Images" },
  { id: "gemini", label: "Google Gemini" }
];

export function providerStatus(env: ProviderEnvironment = process.env): ProviderStatus {
  const fireflyConfigured = Boolean(env.FIREFLY_SERVICES_CLIENT_ID && env.FIREFLY_SERVICES_CLIENT_SECRET);
  const openAIConfigured = Boolean(env.OPENAI_API_KEY);
  const geminiConfigured = Boolean(env.GEMINI_API_KEY);
  // auto = first configured of firefly -> openai -> gemini. Only providers that pass their boot probe are offered to the UI.
  const requested = env.IMAGE_PROVIDER?.toLowerCase();
  const selected = requested === "firefly" && fireflyConfigured
    ? "firefly"
    : requested === "openai" && openAIConfigured
      ? "openai"
      : requested === "gemini" && geminiConfigured
        ? "gemini"
      : fireflyConfigured
        ? "firefly"
        : openAIConfigured
          ? "openai"
          : geminiConfigured
            ? "gemini"
            : null;
  return {
    selected,
    fireflyConfigured,
    openAIConfigured,
    geminiConfigured,
    options: PROVIDERS.map(({ id, label }) => ({
      id,
      label,
      configured: id === "firefly" ? fireflyConfigured : id === "openai" ? openAIConfigured : geminiConfigured,
      verified: false
    }))
  };
}

export function createProvider(id: ProviderId, env: ProviderEnvironment = process.env): ImageProvider | null {
  if (id === "firefly" && env.FIREFLY_SERVICES_CLIENT_ID && env.FIREFLY_SERVICES_CLIENT_SECRET) {
    return new FireflyProvider(env.FIREFLY_SERVICES_CLIENT_ID!, env.FIREFLY_SERVICES_CLIENT_SECRET!);
  }
  if (id === "openai" && env.OPENAI_API_KEY) {
    return new OpenAIImageProvider(env.OPENAI_API_KEY!, env.OPENAI_IMAGE_MODEL ?? "gpt-image-2");
  }
  if (id === "gemini" && env.GEMINI_API_KEY) {
    return new GeminiImageProvider(env.GEMINI_API_KEY!, env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image");
  }
  return null;
}

export function selectProvider(env: ProviderEnvironment = process.env): ImageProvider | null {
  const selected = providerStatus(env).selected;
  return selected ? createProvider(selected, env) : null;
}

export async function verifyProviders(
  env: ProviderEnvironment = process.env,
  factory: ProviderFactory = createProvider
): Promise<{
  providers: Partial<Record<ProviderId, ImageProvider>>;
  status: ProviderStatus;
}> {
  const status = providerStatus(env);
  const providers: Partial<Record<ProviderId, ImageProvider>> = {};
  const options = await Promise.all(status.options.map(async (option): Promise<ProviderOption> => {
    if (!option.configured) return option;
    const provider = factory(option.id, env);
    if (!provider) return option;
    try {
      await provider.probe?.();
      providers[option.id] = provider;
      return { ...option, verified: true, model: provider.model };
    } catch {
      return option;
    }
  }));
  const requested = env.IMAGE_PROVIDER?.toLowerCase();
  const explicitlyRequested = requested === "firefly" || requested === "openai" || requested === "gemini";
  const selected = explicitlyRequested
    ? (providers[requested] ? requested : null)
    : (status.selected && providers[status.selected] ? status.selected : PROVIDERS.find(({ id }) => providers[id])?.id ?? null);
  return {
    providers,
    status: {
      ...status,
      selected,
      options,
      verificationError: options.some((option) => option.configured && !option.verified)
        ? "One or more configured provider credentials could not be verified"
        : undefined
    }
  };
}

export async function verifyProvider(
  env: ProviderEnvironment = process.env,
  createProvider: (environment: ProviderEnvironment) => ImageProvider | null = selectProvider
): Promise<{
  provider: ImageProvider | null;
  status: ProviderStatus;
}> {
  const status = providerStatus(env);
  const provider = createProvider(env);
  if (!provider) return { provider: null, status };
  try {
    await provider.probe?.();
    return { provider, status };
  } catch {
    return {
      provider: null,
      status: {
        ...status,
        selected: null,
        verificationError: "Configured provider credentials could not be verified"
      }
    };
  }
}

export type { ImageProvider, ProviderId, ProviderOption, ProviderStatus } from "./types.js";
