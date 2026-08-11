// The model catalogue, deliberately free of imports.
//
// Settings and its serializer only need these names. Taking them from
// `agents/index.ts` would drag the whole agent runtime — LangChain, MCPClient,
// and the module-level read of instructions.md — into every process that
// touches Settings, including the app MCP server, which runs no agent.

export enum ModelType {
  SONNET_4_8 = "claude-sonnet-4-8",
  OPUS_4_8 = "claude-opus-4-8",
  SONNET_5_0 = "claude-sonnet-5-0",
  OPUS_5_0 = "claude-opus-5-0",
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash"
}

export const MODELS = {
  "deepseek": [ModelType.DEEPSEEK_V4_FLASH],
  "anthropic": [ModelType.SONNET_4_8, ModelType.OPUS_4_8, ModelType.SONNET_5_0, ModelType.OPUS_5_0]
}
