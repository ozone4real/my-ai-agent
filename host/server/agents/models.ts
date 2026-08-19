import { ChatAnthropic } from "@langchain/anthropic";
import { ChatDeepSeek } from "@langchain/deepseek";

export enum ModelType {
  SONNET_4_8 = "claude-sonnet-4-8",
  OPUS_4_8 = "claude-opus-4-8",
  SONNET_5_0 = "claude-sonnet-5-0",
  OPUS_5_0 = "claude-opus-5-0",
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash",
  DEEPSEEK_V4_PRO = "deepseekk-v4-pro"
}

export const MODELS = {
  [ModelType.DEEPSEEK_V4_FLASH]: ChatDeepSeek,
  [ModelType.DEEPSEEK_V4_PRO]: ChatDeepSeek,
  [ModelType.SONNET_4_8]: ChatAnthropic,
  [ModelType.OPUS_4_8]: ChatAnthropic,
  [ModelType.SONNET_5_0]: ChatAnthropic,
  [ModelType.OPUS_5_0]: ChatAnthropic
}
