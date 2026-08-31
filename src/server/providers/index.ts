import { FireflyProvider } from "./firefly.js";
import { GeminiImageProvider } from "./gemini.js";
import { OpenAIImageProvider } from "./openai.js";
import type { ImageProvider, ProviderStatus } from "./types.js";

type ProviderEnvironment = NodeJS.ProcessEnv;

export function providerStatus(env: ProviderEnvironment = process.env): ProviderStatus {
  const fireflyConfigured = Boolean(env.FIREFLY_SERVICES_CLIENT_ID && env.FIREFLY_SERVICES_CLIENT_SECRET);
  const openAIConfigured = Boolean(env.OPENAI_API_KEY);
  const geminiConfigured = Boolean(env.GEMINI_API_KEY);
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
  return { selected, fireflyConfigured, openAIConfigured, geminiConfigured };
}

export function selectProvider(env: ProviderEnvironment = process.env): ImageProvider | null {
  const status = providerStatus(env);
  if (status.selected === "firefly") {
    return new FireflyProvider(env.FIREFLY_SERVICES_CLIENT_ID!, env.FIREFLY_SERVICES_CLIENT_SECRET!);
  }
  if (status.selected === "openai") {
    return new OpenAIImageProvider(env.OPENAI_API_KEY!, env.OPENAI_IMAGE_MODEL ?? "gpt-image-2");
  }
  if (status.selected === "gemini") {
    return new GeminiImageProvider(env.GEMINI_API_KEY!, env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image");
  }
  return null;
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

export type { ImageProvider, ProviderStatus } from "./types.js";
