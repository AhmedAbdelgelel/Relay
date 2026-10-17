
import { join } from "node:path";

import { EMBEDDING_DIM, type EmbeddingProvider } from "./EmbeddingProvider.js";

export interface FeatureExtractor {
  (text: string, opts: { pooling: "mean"; normalize: true }): Promise<{
    data: ArrayLike<number>;
    dims: number[];
  }>;
}

export interface LocalEmbeddingOpts {
  model?: string;
  loadPipeline?: (model: string) => Promise<FeatureExtractor>;
}

export const DEFAULT_LOCAL_MODEL = "Xenova/all-mpnet-base-v2";

async function loadOnnxPipeline(model: string): Promise<FeatureExtractor> {
  const tf = await import("@huggingface/transformers");
  tf.env.cacheDir = join(process.cwd(), ".cache");
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

  private extractorOnce(): Promise<FeatureExtractor> {
    this.extractor ??= this.loadPipeline(this.model).catch((err: unknown) => {
      this.extractor = null;
      throw err;
    });
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
