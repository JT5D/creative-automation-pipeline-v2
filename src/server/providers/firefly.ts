import { buildGenerationPrompt } from "./prompt.js";
import type { GenerateRequest, GeneratedAsset, ImageProvider } from "./types.js";

const TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";
const GENERATE_URL = "https://firefly-api.adobe.io/v3/images/generate-async";

type FireflyPayload = {
  outputs?: Array<{ image?: { url?: string } }>;
  result?: { outputs?: Array<{ image?: { url?: string } }> };
  jobId?: string;
  statusUrl?: string;
  status?: string;
};

export class FireflyProvider implements ImageProvider {
  readonly name = "adobe-firefly";
  readonly model = "firefly_image";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async probe(): Promise<void> {
    await this.getAccessToken();
  }

  async generate(request: GenerateRequest): Promise<GeneratedAsset> {
    const prompt = buildGenerationPrompt(request);
    const token = await this.getAccessToken();
    const response = await this.fetcher(GENERATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": this.clientId,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        prompt,
        aspectRatio: "1:1",
        modelId: this.model,
        numVariations: 1,
        referenceBlobs: [],
        modelSpecificPayload: { localeCode: "en-US", prompt_reasoner: "quality" }
      })
    });

    if (!response.ok) {
      throw new Error(`Firefly generation failed (${response.status}): ${await boundedText(response)}`);
    }

    let payload = await response.json() as FireflyPayload;
    const requestId = payload.jobId;
    if (!imageUrl(payload) && payload.statusUrl) {
      payload = await this.poll(payload.statusUrl, token);
    }

    const generatedImageUrl = imageUrl(payload);
    if (!generatedImageUrl) throw new Error("Firefly returned no image URL");

    const image = await this.fetcher(generatedImageUrl);
    if (!image.ok) throw new Error(`Firefly image download failed (${image.status})`);

    return {
      bytes: Buffer.from(await image.arrayBuffer()),
      mimeType: image.headers.get("content-type")?.includes("jpeg") ? "image/jpeg" : "image/png",
      provider: this.name,
      model: this.model,
      prompt,
      requestId: requestId ?? payload.jobId
    };
  }

  private async getAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "openid,AdobeID,read_organizations,firefly_enterprise,firefly_api,ff_apis"
    });
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) throw new Error(`Firefly authentication failed (${response.status})`);
    const payload = await response.json() as { access_token?: string };
    if (!payload.access_token) throw new Error("Firefly authentication returned no access token");
    return payload.access_token;
  }

  private async poll(statusUrl: string, token: string): Promise<FireflyPayload> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await this.fetcher(statusUrl, {
        headers: { Authorization: `Bearer ${token}`, "x-api-key": this.clientId, Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`Firefly status check failed (${response.status})`);
      const payload = await response.json() as FireflyPayload;
      if (imageUrl(payload)) return payload;
      if (payload.status && ["failed", "cancelled"].includes(payload.status.toLowerCase())) {
        throw new Error(`Firefly job ${payload.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("Firefly generation timed out after 30 seconds");
  }
}

function imageUrl(payload: FireflyPayload): string | undefined {
  return payload.result?.outputs?.[0]?.image?.url ?? payload.outputs?.[0]?.image?.url;
}

async function boundedText(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}
