/**
 * Canonical recommendation engine exports.
 *
 * The previous matcher has been replaced by the compact, declarative rule-based engine. Keeping
 * this module as the public entry point avoids coupling callers to the implementation filename.
 */
export {
  COMPATIBILITY_RULES,
  CPU_WEIGHT,
  RAM_WEIGHT,
  SimpleRecommendationEngine as RecommendationEngine,
  representativeSkus,
  sizePenalty,
} from './simple-recommendation-engine';
export type {
  CompatibilityRule,
  SimpleOutcome,
  SimpleRecommendation as Recommendation,
} from './simple-recommendation-engine';