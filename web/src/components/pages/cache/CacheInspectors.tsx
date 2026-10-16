import { InspectorDisclosure } from "@/components/pages/shared/InspectorDisclosure";
import { JsonBlock } from "@/components/pages/shared/JsonBlock";
import type { HealthInfo } from "@/lib/types";

/**
 * The two inspector panels from inventory §2.4: the exact-cache key shape and
 * the semantic-cache configuration. Every value is either live from /health or
 * an honest "server configured" placeholder (legacy viewCache copy).
 */
export function CacheInspectors({ health }: { health: HealthInfo | null }) {
  const cfg = health?.config ?? null;
  const threshold = cfg ? cfg.semanticThreshold : null;

  const exactJson = JSON.stringify(
    {
      key: "llm:exact:v1:<provider>:<sha256(canonical)>",
      identity_fields: ["model", "messages", "temperature", "max_tokens"],
      normalization: "trim whitespace, sort keys, stable JSON",
      verdicts: ["HIT", "MISS", "BYPASS (stream:true)", "DISABLED"],
      ttl_s: cfg ? cfg.cacheTtlSec : "server configured",
      store: health?.cache || "unknown",
    },
    null,
    2,
  );

  const semanticJson = JSON.stringify(
    {
      store: health?.semantic || "unknown",
      embedder: health?.embedder || "unknown",
      threshold: threshold === null ? "server configured" : threshold,
      top_k: cfg ? cfg.semanticTopK : "server configured",
      ttl_s: cfg ? cfg.semanticTtlSec : "server configured",
      hard_filter: ["tenant", "provider", "model"],
      policy_rejections: [
        "provider-mismatch",
        "model-mismatch",
        "temperature-mismatch",
        "max-tokens-mismatch",
        "below-threshold",
        "empty-content",
      ],
      reuse_verdict: "SEMANTIC_HIT",
      similarity_header: "x-semantic-similarity",
    },
    null,
    2,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InspectorDisclosure title="Exact cache · sha256 of the canonical request">
        <JsonBlock text={exactJson} />
      </InspectorDisclosure>
      <InspectorDisclosure
        title={
          threshold === null
            ? "Semantic cache · server configured"
            : `Semantic cache · cosine ≥ ${threshold}`
        }
      >
        <JsonBlock text={semanticJson} />
      </InspectorDisclosure>
    </div>
  );
}
