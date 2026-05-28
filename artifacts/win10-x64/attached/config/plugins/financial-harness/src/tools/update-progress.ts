// update-progress.ts — 更新项目进度
import { tool } from "@opencode-ai/plugin"
import { UnifiedProgressManager, type UnifiedProgressData } from "../progress/unified-progress-manager.js"
import { pluginDirectory } from "../../index.js"
import { sessions } from "../state.js"

export const updateProgressTool = tool({
  description: "更新项目进度（写入 .harness/progress.json）",
  args: {
    feature: tool.schema.string().describe("Feature ID"),
    featureName: tool.schema.string().optional().describe("Feature 名称"),
    module: tool.schema.enum(["prd", "design", "code", "test"]).describe("完成的模块"),
    status: tool.schema.enum(["done", "in_progress", "failed"]).describe("状态"),
    review_round: tool.schema.number().optional().describe("当前审查轮次（Ralph Loop，从 1 开始）"),
    max_rounds: tool.schema.number().optional().describe("最大审查轮次"),
    review_passed: tool.schema.boolean().optional().describe("审查是否通过（true=通过，false=不通过）"),
    session_id: tool.schema.string().optional().describe("Session ID（可选）"),
  },
  async execute(args, ctx) {
    const dir = pluginDirectory || process.cwd()
    const pm = new UnifiedProgressManager(dir)
    const data = await pm.query()
    const featureId = resolveFeatureId(args.feature, data)

    // P1-1：使用实际 sessionId，而非空字符串
    const sessionId = args.session_id ?? findSessionByFeature(featureId) ?? ctx?.session?.id ?? ""

    if (!data.features.some((feature) => feature.id === featureId)) {
      await pm.initFeature({
        id: featureId,
        title: args.featureName ?? args.feature,
        request: args.feature,
        requirementText: args.featureName ?? args.feature,
        requirementSource: {
          type: "fallback",
          contentHash: `sha256:${featureId}`,
        },
      }, sessionId)
    }

    await pm.updatePhase(featureId, args.module, mapStatus(args.status))
    return ""
  },
})

/** 从所有 session 中找到匹配 featureId 的 lingxi_harness session */
function findSessionByFeature(featureId: string): string | undefined {
  for (const [sid, state] of sessions) {
    if (state.isLingxiHarness && state.lingxiFeatureId === featureId) {
      return sid
    }
  }
  return undefined
}

function resolveFeatureId(requestedFeature: string, data: UnifiedProgressData): string {
  if (data.features.some((feature) => feature.id === requestedFeature)) return requestedFeature
  const active = data.features.filter((feature) => feature.summary.status !== "completed")
  if (active.length === 1) return active[0].id
  return requestedFeature
}

function mapStatus(status: "done" | "in_progress" | "failed") {
  if (status === "done") return "completed"
  if (status === "failed") return "failed"
  return "running"
}
