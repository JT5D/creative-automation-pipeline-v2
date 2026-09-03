import { buildGenerationPrompt } from "./prompt.js";
import type { GenerateRequest, GeneratedAsset, ImageProvider } from "./types.js";

const TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";
// Firefly Image 5 is served by the v4 async route and requires the x-model-version header.
// Contract: https://developer.adobe.com/firefly-services/docs/firefly-api/api/ ("Generate images with Image5").
const GENERATE_URL = "https://firefly-api.adobe.io/v4/images/generate-async";
const MODEL_VERSION = "image5";
const TOKEN_SCOPE = "openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis";
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1_000;
const TERMINAL_FAILURES = new Set(["failed", "cancelled", "cancel_pending", "timeout"]);

// 200 from /v4/images/generate-async: links to the /v3/status and /v3/cancel job routes.
type FireflyAcceptedJob = {
  links?: { result?: { href?: string }; cancel?: { href?: string } };
  progress?: number;
};

// 200 from /v3/status/{jobId}: "succeeded" carries result.outputs; other states carry an error code.
type FireflyJobStatus = {
  status?: string;
  jobId?: string;
  result?: { outputs?: Array<{ seed?: number; image?: { url?: string } }> };
  error_code?: string;
  message?: string;
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
      headers: { ...this.authHeaders(token), "x-model-version": MODEL_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        aspectRatio: "1:1",
        modelId: this.model,
        numVariations: 1,
        modelSpecificPayload: { localeCode: "en-US", prompt_reasoner: "quality" }
      })
    });

    if (!response.ok) {
      throw new Error(`Firefly generation failed (${response.status}): ${await boundedText(response)}`);
    }

    const accepted = await response.json() as FireflyAcceptedJob;
    const statusUrl = accepted.links?.result?.href;
    if (!statusUrl) throw new Error("Firefly returned no result link for the generation job");

    const job = await this.poll(statusUrl, token);
    const generatedImageUrl = job.result?.outputs?.[0]?.image?.url;
    if (!generatedImageUrl) throw new Error("Firefly job succeeded without an image URL");

    const image = await this.fetcher(generatedImageUrl);
    if (!image.ok) throw new Error(`Firefly image download failed (${image.status})`);

    return {
      bytes: Buffer.from(await image.arrayBuffer()),
      mimeType: image.headers.get("content-type")?.includes("jpeg") ? "image/jpeg" : "image/png",
      provider: this.name,
      model: this.model,
      prompt,
      requestId: job.jobId
    };
  }

  private authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "x-api-key": this.clientId, Accept: "application/json" };
  }

  private async getAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: TOKEN_SCOPE
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

  private async poll(statusUrl: string, token: string): Promise<FireflyJobStatus> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const response = await this.fetcher(statusUrl, { headers: this.authHeaders(token) });
      if (!response.ok) throw new Error(`Firefly status check failed (${response.status})`);
      const job = await response.json() as FireflyJobStatus;
      const status = job.status?.toLowerCase();
      if (status === "succeeded") return job;
      if (status && TERMINAL_FAILURES.has(status)) {
        const detail = [job.error_code, job.message].filter(Boolean).join(": ");
        throw new Error(`Firefly job ${status}${detail ? ` (${detail})` : ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Firefly generation timed out after ${(POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000} seconds`);
  }
}

async function boundedText(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}
