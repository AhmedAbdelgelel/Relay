import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "../../src/embeddings/EmbeddingProvider.js";
import { DEFAULT_LOCAL_MODEL, LocalEmbedding, type FeatureExtractor } from "../../src/embeddings/LocalEmbedding.js";

const SIGNAL = new AbortController().signal;
const UNIT: number[] = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();

function fakeLoader(handler: (text: string) => number[] = () => UNIT) {
  const stats = { loads: 0, models: [] as string[], texts: [] as string[] };
  const loadPipeline = async (model: string): Promise<FeatureExtractor> => {
    stats.loads++;
    stats.models.push(model);
    return async (text: string) => {
      stats.texts.push(text);
      const data = handler(text);
      return { data, dims: [1, data.length] };
    };
  };
  return { stats, loadPipeline };
}

describe("LocalEmbedding (built-in ONNX embedder, injected pipeline)", () => {
  it("loads the pipeline once, shares it across concurrent embeds, 768-d out", async () => {
    const { stats, loadPipeline } = fakeLoader();
    const e = new LocalEmbedding({ loadPipeline });
    expect(e.name).toBe("local");
    expect(e.dimension).toBe(EMBEDDING_DIM);
    const [a, b] = await Promise.all([e.embed("one", SIGNAL), e.embed("two", SIGNAL)]);
    expect(a).toEqual(UNIT);
    expect(b).toEqual(UNIT);
    expect(stats.loads).toBe(1); // one load for the burst, not one per call
    expect(stats.models).toEqual([DEFAULT_LOCAL_MODEL]);
    expect(stats.texts).toEqual(["one", "two"]);
  });

  it("passes an EMBEDDING_MODEL override through to the loader", async () => {
    const { stats, loadPipeline } = fakeLoader();
    const e = new LocalEmbedding({ model: "custom/model", loadPipeline });
    await e.embed("x", SIGNAL);
    expect(stats.models).toEqual(["custom/model"]);
  });

  it("wrong dimension fails loudly (protects the vector(768) schema)", async () => {
    const { loadPipeline } = fakeLoader(() => new Array<number>(384).fill(0));
    const e = new LocalEmbedding({ loadPipeline });
    await expect(e.embed("x", SIGNAL)).rejects.toThrow(/dim 384 != 768/);
  });

  it("non-finite values fail loudly", async () => {
    const { loadPipeline } = fakeLoader(() => {
      const v = [...UNIT];
      v[3] = Number.NaN;
      return v;
    });
    const e = new LocalEmbedding({ loadPipeline });
    await expect(e.embed("x", SIGNAL)).rejects.toThrow(/non-finite/);
  });

  it("pre-aborted signal never loads the model", async () => {
    const { stats, loadPipeline } = fakeLoader();
    const e = new LocalEmbedding({ loadPipeline });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(e.embed("x", ctrl.signal)).rejects.toThrow(/aborted/);
    expect(stats.loads).toBe(0);
  });
});
