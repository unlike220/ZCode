/**
 * Reserved input headroom for heuristic tokenizer error, provider framing, and
 * model/provider tokenizer differences. This is separate from compaction's
 * conversation buffer policy.
 */
export const MODEL_REQUEST_SAFETY_MARGIN_TOKENS = 1_000;
