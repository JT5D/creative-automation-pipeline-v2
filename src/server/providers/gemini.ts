import { buildGenerationPrompt } from "./prompt.js";
import type { GenerateRequest, GeneratedAsset, ImageProvider } from "./types.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";

export class GeminiImageProvider implements ImageProvider {
  readonly name = "google-gemini";

  constructor(
    private readonly apiKey: string,
    readonly model = "gemini-3-pro-image",
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async probe(): Promise<void> {
    const response = await this.fetcher(MODELS_ENDPOINT, {
      headers: { "x-goog-api-key": this.apiKey },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Gemini authentication failed (${response.status})`);
  }

  async generate(request: GenerateRequest): Promise<GeneratedAsset> {
    const prompt = buildGenerationPrompt(request);
    const response = await this.fetcher(ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: [{ type: "text", text: prompt }],
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "1:1",
          image_size: "2K"
        }
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) {
      throw new Error(`Gemini image generation failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const image = findFirstImage(payload);
    if (!image) throw new Error("Gemini returned no image data");
    return {
      bytes: Buffer.from(image.data, "base64"),
      mimeType: image.mimeType,
      provider: this.name,
      model: this.model,
      prompt,
      requestId: typeof payload.id === "string" ? payload.id : undefined
    };
  }
}

function findFirstImage(node: unknown): { data: string; mimeType: "image/png" | "image/jpeg" } | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstImage(item);
      if (found) return found;
    }
    return null;
  }
  const value = node as Record<string, unknown>;
  const mimeType = value.mime_type ?? value.mimeType;
  if (typeof value.data === "string" && (mimeType === "image/png" || mimeType === "image/jpeg")) {
    return { data: value.data, mimeType };
  }
  if (value.inlineData && typeof value.inlineData === "object") {
    const inline = value.inlineData as Record<string, unknown>;
    if (typeof inline.data === "string" && (inline.mimeType === "image/png" || inline.mimeType === "image/jpeg")) {
      return { data: inline.data, mimeType: inline.mimeType };
    }
  }
  for (const child of Object.values(value)) {
    const found = findFirstImage(child);
    if (found) return found;
  }
  return null;
}
