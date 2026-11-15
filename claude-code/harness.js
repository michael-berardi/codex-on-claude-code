/**
 * The adapter contract the claude-code module builds on: a base class and an error type.
 *
 * The bridge has no host harness, so these local definitions are the whole contract. `loadHarness` keeps its
 * original shape so the rest of the module is unchanged.
 */

/** The adapter contract defaults. */
class LocalAdapter {
  providerInfo(provider) { return { id: provider, name: provider }; }
  providerRetryPolicy() { return undefined; }
  imageRequestPricing() { return undefined; }
  imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes }; }
  listModels() { return Promise.resolve([]); }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
  }
}

class LocalError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "LlmError";
    this.code = code;
  }
}

/**
 * @returns {Promise<{LlmAdapter: Function, LlmError: Function, ReasoningEffortId: Function, ToolCallId: Function, libraryModel: undefined, source: string}>}
 */
export async function loadHarness() {
  return { LlmAdapter: LocalAdapter, LlmError: LocalError, ReasoningEffortId: (id) => id, ToolCallId: (id) => id, libraryModel: undefined, source: "local" };
}
