import { describe, expect, it } from "vitest";
import type { CampaignBrief } from "../src/shared/schema.js";
import { FireflyProvider } from "../src/server/providers/firefly.js";
import { GeminiImageProvider } from "../src/server/providers/gemini.js";
import { verifyProvider, verifyProviders } from "../src/server/providers/index.js";

const brief: CampaignBrief = {
  schemaVersion: "1.0",
  id: "test-campaign",
  name: "Test campaign",
  region: "Germany",
  audience: "Urban professionals",
  message: "Bright energy",
  manualMinutesPerCreative: 5,
  brand: { name: "NORTHLINE", primaryColor: "#073A9D", secondaryColor: "#FF8A1E", prohibitedWords: [] },
  products: [
    { id: "citrus", name: "Citrus Lift", description: "Citrus sparkling energy", approvedHeroPath: "samples/a.png" },
    { id: "berry", name: "Berry Charge", description: "Berry sparkling energy", referenceAssetPath: "samples/b.png" }
  ],
  markets: [{ locale: "en-DE", label: "Germany", message: "Bright energy", callToAction: "Discover" }],
  ratios: ["1x1", "9x16", "16x9"]
};

describe("Adobe Firefly provider", () => {
  const acceptedJob = (jobId: string) => Response.json({
    links: {
      result: { href: `https://firefly.example/v3/status/${jobId}` },
      cancel: { href: `https://firefly.example/v3/cancel/${jobId}` }
    },
    progress: 0
  });

  it("authenticates server-side, submits an Image 5 job, and downloads the generated image", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("ims/token")) return Response.json({ access_token: "test-token" });
      if (url.includes("/v4/images/generate-async")) return acceptedJob("job-123");
      if (url.includes("/v3/status/")) return Response.json({
        status: "succeeded",
        jobId: "job-123",
        result: { outputs: [{ seed: 333, image: { url: "https://assets.example/hero.png" } }] }
      });
      return new Response(Buffer.from("png-bytes"), { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const provider = new FireflyProvider("client-id", "client-secret", fetcher);

    const result = await provider.generate({ brief, product: brief.products[1] });

    expect(result.provider).toBe("adobe-firefly");
    expect(result.model).toBe("firefly_image");
    expect(result.bytes.toString()).toBe("png-bytes");
    expect(result.requestId).toBe("job-123");
    expect(calls.map((call) => call.url)).toEqual([
      "https://ims-na1.adobelogin.com/ims/token/v3",
      "https://firefly-api.adobe.io/v4/images/generate-async",
      "https://firefly.example/v3/status/job-123",
      "https://assets.example/hero.png"
    ]);
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["x-api-key"]).toBe("client-id");
    expect(headers["x-model-version"]).toBe("image5");
    const generationBody = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
    expect(generationBody.modelId).toBe("firefly_image");
    expect(generationBody.aspectRatio).toBe("1:1");
    expect(generationBody.numVariations).toBe(1);
    expect(generationBody.modelSpecificPayload).toEqual({ localeCode: "en-US", prompt_reasoner: "quality" });
    expect(generationBody).not.toHaveProperty("referenceBlobs");
    expect(generationBody.prompt).toContain("Berry Charge");
    expect(generationBody.prompt).toContain("approved packshot");
    expect(generationBody.prompt).toContain("checkerboards");
    expect(generationBody.prompt).toContain("edge to edge");
    const tokenBody = String(calls[0].init?.body);
    expect(tokenBody).toContain("grant_type=client_credentials");
    expect(tokenBody).toContain("firefly_api");
  });

  it("keeps polling a running job until it succeeds", async () => {
    let statusChecks = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ims/token")) return Response.json({ access_token: "test-token" });
      if (url.includes("/v4/images/generate-async")) return acceptedJob("job-789");
      if (url.includes("/v3/status/")) {
        statusChecks += 1;
        return statusChecks === 1
          ? Response.json({ status: "running", jobId: "job-789" })
          : Response.json({ status: "succeeded", jobId: "job-789", result: { outputs: [{ image: { url: "https://assets.example/late.png" } }] } });
      }
      return new Response(Buffer.from("late-bytes"), { headers: { "content-type": "image/png" } });
    }) as typeof fetch;

    const provider = new FireflyProvider("client-id", "client-secret", fetcher);
    const result = await provider.generate({ brief, product: brief.products[1] });

    expect(statusChecks).toBe(2);
    expect(result.bytes.toString()).toBe("late-bytes");
  });

  it("surfaces a failed async job without attempting an image download", async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ims/token")) return Response.json({ access_token: "test-token" });
      if (url.includes("/v4/images/generate-async")) return acceptedJob("job-456");
      return Response.json({ status: "failed", jobId: "job-456", error_code: "content_filtered", message: "Prompt rejected" });
    }) as typeof fetch;

    const provider = new FireflyProvider("client-id", "client-secret", fetcher);
    await expect(provider.generate({ brief, product: brief.products[1] })).rejects.toThrow("Firefly job failed (content_filtered: Prompt rejected)");
  });
});

describe("Google Gemini provider", () => {
  it("exposes verified providers for safe per-run selection", async () => {
    const runtime = await verifyProviders(
      { IMAGE_PROVIDER: "auto", GEMINI_API_KEY: "valid-key" },
      (id) => id === "gemini" ? {
        name: "google-gemini",
        model: "gemini-3-pro-image",
        async probe() {},
        async generate() { throw new Error("Not called"); }
      } : null
    );

    expect(runtime.status.selected).toBe("gemini");
    expect(runtime.status.options.find((option) => option.id === "gemini")?.verified).toBe(true);
    expect(runtime.providers.gemini?.model).toBe("gemini-3-pro-image");
  });

  it("does not report a configured provider as verified when its credential probe fails", async () => {
    const runtime = await verifyProvider(
      { IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "dead-key" },
      () => ({
        name: "google-gemini",
        model: "gemini-3-pro-image",
        async probe() { throw new Error("Unauthorized"); },
        async generate() { throw new Error("Not called"); }
      })
    );

    expect(runtime.provider).toBeNull();
    expect(runtime.status.selected).toBeNull();
    expect(runtime.status.geminiConfigured).toBe(true);
    expect(runtime.status.verificationError).toContain("could not be verified");
  });

  it("verifies credentials without requesting an image", async () => {
    let requestUrl = "";
    let requestMethod = "";
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestMethod = init?.method ?? "GET";
      return Response.json({ models: [] });
    }) as typeof fetch;
    const provider = new GeminiImageProvider("gemini-key", "gemini-3-pro-image", fetcher);

    await provider.probe();

    expect(requestUrl).toContain("/v1beta/models");
    expect(requestMethod).toBe("GET");
  });

  it("requests one scene and reads image bytes from the Interactions response", async () => {
    const imageBytes = Buffer.from("gemini-image-bytes");
    let generationBody: Record<string, unknown> | undefined;
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      generationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "interaction-123",
        output: [{ type: "image", mime_type: "image/jpeg", data: imageBytes.toString("base64") }]
      });
    }) as typeof fetch;
    const provider = new GeminiImageProvider("gemini-key", "gemini-3-pro-image", fetcher);

    const result = await provider.generate({ brief, product: brief.products[1] });

    expect(result.provider).toBe("google-gemini");
    expect(result.model).toBe("gemini-3-pro-image");
    expect(result.bytes).toEqual(imageBytes);
    expect(result.requestId).toBe("interaction-123");
    expect(generationBody?.model).toBe("gemini-3-pro-image");
    expect(generationBody?.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text" })]));
    expect(generationBody?.response_format).toEqual(expect.objectContaining({ aspect_ratio: "1:1", image_size: "2K" }));
  });
});
