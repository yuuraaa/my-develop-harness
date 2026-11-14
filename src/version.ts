import metadata from "../package.json" with { type: "json" };

// Bun compile embeds this static import; dist resolves it relative to this module.
export const harnessVersion = metadata.version;
