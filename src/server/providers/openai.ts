import { buildGenerationPrompt } from "./prompt.js";
import type { GenerateRequest, GeneratedAsset, ImageProvider } from "./types.js";

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai-images";

  constructor(
    private readonly apiKey: string,
    readonly model = "gpt-image-2",
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async probe(): Promise<void> {
    const response = await this.fetcher("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`OpenAI authentication failed (${response.status})`);
  }

  async generate(request: GenerateRequest): Promise<GeneratedAsset> {
    const prompt = buildGenerationPrompt(request);
    const response = await this.fetcher("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: this.model, prompt, size: "1024x1024", n: 1 })
    });
    if (!response.ok) {
      throw new Error(`OpenAI image generation failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    const payload = await response.json() as {
      data?: Array<{ b64_json?: string; url?: string }>;
      id?: string;
    };
    const item = payload.data?.[0];
    if (!item) throw new Error("OpenAI returned no image");
    let bytes: Buffer;
    if (item.b64_json) {
      bytes = Buffer.from(item.b64_json, "base64");
    } else if (item.url) {
      const image = await this.fetcher(item.url);
      if (!image.ok) throw new Error(`OpenAI image download failed (${image.status})`);
      bytes = Buffer.from(await image.arrayBuffer());
    } else {
      throw new Error("OpenAI returned neither image bytes nor a URL");
    }
    return { bytes, mimeType: "image/png", provider: this.name, model: this.model, prompt, requestId: payload.id };
  }
}
