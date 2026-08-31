import type { CampaignBrief, Product } from "../../shared/schema.js";

export type GeneratedAsset = {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";
  provider: string;
  model: string;
  prompt: string;
  requestId?: string;
};

export type GenerateRequest = {
  brief: CampaignBrief;
  product: Product;
};

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  probe?(): Promise<void>;
  generate(request: GenerateRequest): Promise<GeneratedAsset>;
}

export type ProviderStatus = {
  selected: "firefly" | "openai" | "gemini" | null;
  fireflyConfigured: boolean;
  openAIConfigured: boolean;
  geminiConfigured: boolean;
  verificationError?: string;
};
