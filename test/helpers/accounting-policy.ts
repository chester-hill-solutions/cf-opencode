import {
  ACCOUNTING_POLICY_CONFIG,
  ACCOUNTING_POLICY_ID,
} from "../../src/accounting-policy"

export const accountingPolicyStart = {
  ok: true,
  accountingPolicy: ACCOUNTING_POLICY_ID,
  opencodeGeneration: "test-opencode-generation",
  eventPersistence: true,
}

export const accountingPolicyConfig = [
  {
    type: "document",
    info: ACCOUNTING_POLICY_CONFIG,
  },
]
