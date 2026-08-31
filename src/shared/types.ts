import type { CampaignBrief, Ratio } from "./schema.js";

export type AssetSource = "approved" | "generated-live" | "generated-sample";

export type PipelineEvent = {
  at: string;
  stage: "brief" | "preflight" | "asset" | "generate" | "compose" | "compliance" | "complete";
  label: string;
  productId?: string;
  detail?: string;
};

export type ComplianceCheck = {
  id: "brand" | "palette" | "contrast" | "legal" | "dimensions" | "copy-fit" | "safe-zone" | "framing";
  label: string;
  passed: boolean;
  evidence: string;
};

export type CreativeRecord = {
  ratio: Ratio;
  locale: string;
  width: number;
  height: number;
  outputPath: string;
  publicUrl: string;
  bytes: number;
  checks: ComplianceCheck[];
};

export type ProductResult = {
  productId: string;
  productName: string;
  source: AssetSource;
  provider: string;
  model?: string;
  prompt?: string;
  heroPath: string;
  creatives: CreativeRecord[];
};

export type CampaignReport = {
  runId: string;
  campaign: Pick<CampaignBrief, "id" | "name" | "region" | "audience" | "message">;
  status: "completed";
  startedAt: string;
  completedAt: string;
  metrics: {
    campaigns: number;
    products: number;
    creatives: number;
    reused: number;
    generatedLive: number;
    generatedSample: number;
    elapsedMs: number;
    manualMinutesPerCreative: number;
    estimatedManualMinutes: number;
    timeSavedMinutes: number;
    creativesPerMinute: number;
  };
  products: ProductResult[];
  compliance: ComplianceCheck[];
  events: PipelineEvent[];
  verification: {
    twoProducts: boolean;
    threeRatios: boolean;
    messageRendered: boolean;
    organizedOutputs: boolean;
    imageGeneration: "live" | "sample" | "unavailable";
  };
  warnings: string[];
};
