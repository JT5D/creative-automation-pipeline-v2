import type { CampaignBrief } from "../shared/schema.js";

export type LegalResult = { passed: boolean; matches: Array<{ term: string; field: string }> };

export function scanLegal(brief: CampaignBrief): LegalResult {
  const fields: Array<[string, string]> = [
    ["campaign.message", brief.message],
    ...brief.markets.flatMap((market) => [
      [`markets.${market.locale}.message`, market.message] as [string, string],
      [`markets.${market.locale}.callToAction`, market.callToAction] as [string, string],
      [`markets.${market.locale}.disclaimer`, market.disclaimer ?? ""] as [string, string]
    ]),
    ...brief.products.flatMap((product) => [
      [`products.${product.id}.name`, product.name] as [string, string],
      [`products.${product.id}.description`, product.description] as [string, string]
    ])
  ];
  const matches = brief.brand.prohibitedWords.flatMap((term) => {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    return fields.filter(([, value]) => pattern.test(value)).map(([field]) => ({ term, field }));
  });
  return { passed: matches.length === 0, matches };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
