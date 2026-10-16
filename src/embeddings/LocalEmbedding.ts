// Built-in local embedder: real sentence embeddings, in-process, zero services
// and zero keys. Runs a quantized ONNX sentence-transformer via
// @huggingface/transformers (onnxruntime) — the default model,
// all-mpnet-base-v2, is 768-d (matches EMBEDDING_DIM and the vector(768)
// schema) and was trained for symmetric similarity, so plain text on both
// sides needs no task prefixes.
// Fully lazy: nothing loads until the first embed(), so boot and the mock path
// stay instant. First use downloads the model (~109 MB q8) into the HF cache
// (./.cache by default; the Docker image ships it baked in — see Dockerfile);
// after that it is fully offline.

import { join } from "node:path";

import { EMBEDDING_DIM, type EmbeddingProvider } from "./EmbeddingProvider.js";

/** Structural slice of a feature-extraction pipeline. Keeps transformers.js
 * types confined to this file so the rest of the codebase stays independent. */
export interface FeatureExtractor {
  (text: string, opts: { pooling: "mean"; normalize: true }): Promise<{
    data: ArrayLike<number>;
    dims: number[];
  }>;
}

export interface LocalEmbeddingOpts {
  /** HF model id; default DEFAULT_LOCAL_MODEL. */
  model?: string;
  /** Test seam: replaces the real ONNX pipeline with a fake. */
  loadPipeline?: (model: string) => Promise<FeatureExtractor>;
}

export const DEFAULT_LOCAL_MODEL = "Xenova/all-mpnet-base-v2";

async function loadOnnxPipeline(model: string): Promise<FeatureExtractor> {
  const tf = await import("@huggingface/transformers");
  // Deterministic model cache: v4 otherwise defaults to a directory inside
  // node_modules, which any `npm ci` wipes. Keep it in ./.cache instead
  // (gitignored); the Docker build warms exactly this path so the image
  // ships the model baked in.
  tf.env.cacheDir = join(process.cwd(), ".cache");
  // q8 — the quantized ONNX export (~109 MB on disk); fp32 would be ~4x.
  const pipe = (await tf.pipeline("feature-extraction", model, {
    dtype: "q8",
  })) as unknown as FeatureExtractor;
  return pipe;
}

export class LocalEmbedding implements EmbeddingProvider {
  readonly name = "local";
  readonly dimension = EMBEDDING_DIM;
  private model: string;
  private loadPipeline: (model: string) => Promise<FeatureExtractor>;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(opts: LocalEmbeddingOpts = {}) {
    this.model = opts.model || DEFAULT_LOCAL_MODEL;
    this.loadPipeline = opts.loadPipeline ?? loadOnnxPipeline;
  }

  /** Load once and share the promise, so a burst of lookups triggers one load. */
  private extractorOnce(): Promise<FeatureExtractor> {
    this.extractor ??= this.loadPipeline(this.model);
    return this.extractor;
  }

  async embed(text: string, signal: AbortSignal): Promise<number[]> {
    if (signal.aborted) throw new Error("local embed: aborted");
    const extract = await this.extractorOnce();
    if (signal.aborted) throw new Error("local embed: aborted");
    const out = await extract(text, { pooling: "mean", normalize: true });
    const values = Array.from(out.data);
    if (values.length !== EMBEDDING_DIM) {
      throw new Error(`local embed: dim ${values.length} != ${EMBEDDING_DIM} (model ${this.model})`);
    }
    if (values.some((x) => !Number.isFinite(x))) throw new Error("local embed: non-finite value");
    return values;
  }
}
