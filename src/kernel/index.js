/**
 * The judgment kernel, host-free.
 *
 * Everything an adapter or an application needs to declare a decision point, ask
 * it, and read what happened — with no dependency on any agent runtime.
 *
 * @module dsh-jev-judge/kernel
 */

export {
  CAPABILITIES,
  ESCAPE_OPTIONS,
  MODES,
  QUESTION_TYPES,
  coerceAnswer,
  hasEscapeOption,
  isPlainObject,
  normalizeOptionName,
  probabilitiesOf,
  validateQuestion,
  validateQuestions,
} from './contract.js'

export {
  DEFAULT_UNCERTAINTY,
  isNo,
  isUncertain,
  isYes,
  normalizeBand,
  uncertainQuestionIds,
  within,
} from './policy.js'

export { JudgeError, JUDGE_ERROR_KINDS, errorKindForStatus, isJudgeError, toJudgeError } from './errors.js'

export { REDACTED, createRedactor, environmentSecrets, redactText, redactValue } from './redact.js'

export { decodeAnswers, normalizeUsage, validateAnswer } from './judge.js'

export { runCascade } from './cascade.js'

export { ABSTAIN, createEngine, defineDecision } from './decision.js'

export { FileLedger, MemoryLedger, createLedger, stateDigest } from './ledger.js'

export {
  ConfigError,
  DEFAULT_KERNEL_CONFIG_PATH,
  DEFAULT_PROVIDER_CONFIG_PATH,
  PROVIDER_CONFIG_ENV,
  discoverProviderConfigPath,
  isPlaceholderSecret,
  loadKernelConfig,
  loadProviderConfig,
  normalizeBaseUrl,
  readConfigFile,
  validateKernelConfig,
  validateProviderConfig,
} from './config.js'

export {
  DEFAULT_JUDGE_NAME,
  buildJudge,
  createJudgeRuntime,
  createJudges,
  expandHome,
} from './registry.js'

export { ChatJsonJudge, buildChatPrompt, extractJsonObject } from './judges/chat-json.js'
export {
  SYSTEM_ONE_PATH,
  SystemOneJudge,
  buildAuthorizationHeader,
  buildSystemOnePayload,
  resolveEndpoint,
  toWireQuestion,
} from './judges/typesafe.js'
export { MockJudge, alwaysJudge, silentJudge } from './judges/mock.js'
