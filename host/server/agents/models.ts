export enum ModelType {
  SONNET_4_8 = "claude-sonnet-4-8",
  OPUS_4_8 = "claude-opus-4-8",
  SONNET_5_0 = "claude-sonnet-5-0",
  OPUS_5_0 = "claude-opus-5-0",
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash",
  DEEPSEEK_V4_PRO = "deepseekk-v4-pro"
}

export const MODELS = {
  "deepseek": [ModelType.DEEPSEEK_V4_FLASH, ModelType.DEEPSEEK_V4_PRO],
  "anthropic": [ModelType.SONNET_4_8, ModelType.OPUS_4_8, ModelType.SONNET_5_0, ModelType.OPUS_5_0]
}
