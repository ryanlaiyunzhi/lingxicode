// update-step.ts — 更新 Lingxi Harness Step 级进度
import { tool } from "@opencode-ai/plugin"
import { UnifiedProgressManager } from "../progress/unified-progress-manager.js"
import { pluginDirectory, pluginClient } from "../../index.js"
import { sessions, getState } from "../state.js"
import { lingxiTrackers } from "../lingxi/progress-tracker.js"
import type { PhaseId } from "../lingxi/config-loader.js"

function isPhaseId(value: string): value is PhaseId {
  return value === "prd" || value === "design" || value === "code" || value === "test"
}

export const updateStepTool = tool({
  description: "更新 Lingxi Harness Step 级进度（写入 .harness/progress.json）",
  args: {
    feature: tool.schema.string().describe("Feature ID"),
    module: tool.schema.enum(["prd", "design", "code", "test"]).describe("当前模块"),
    step: tool.schema.enum([
      "Step_0", "Step_1", "Step_2", "Step_3", "Step_4",
      "Step_5", "Step_6", "Step_7", "Step_8", "Step_9",
    ]).describe("Step 名称，必须为 Step_N 格式（如 Step_0、Step_4）"),
    status: tool.schema.enum(["done", "in_progress", "failed", "skipped"]).describe("状态"),
    session_id: tool.schema.string().optional().describe("Session ID（可选，用于 Step 渐进注入）"),
  },
  async execute(args, ctx) {
    const dir = pluginDirectory || process.cwd()
    const pm = new UnifiedProgressManager(dir)

    // ── Step 渐进注入：status=done 时自动注入下一个 Step ──
    if (args.status !== "done" || !isPhaseId(args.module)) {
      // 非 done 状态或非法 module，仅写入磁盘后返回
      await pm.updateStage(args.feature, args.module, args.step, mapStatus(args.status))
      return ""
    }

    // 从所有 session 中找到匹配的 lingxi_harness session
    // 优先用 args.session_id，其次搜索已知 session，最后用 ctx 当前 session 兜底
    const sessionId = args.session_id ?? findSessionByFeature(args.feature) ?? ctx?.session?.id
    if (!sessionId) {
      // 无 session 上下文，仅写入磁盘
      await pm.updateStage(args.feature, args.module, args.step, mapStatus(args.status))
      return ""
    }

    const state = getState(sessionId)

    // ── 容错：session 重启后 isLingxiHarness / lingxiCurrentPhase 可能丢失，从 args 重建 ──
    if (!state.isLingxiHarness) {
      console.warn(`[financial-harness] session ${sessionId} 状态丢失，从 args 重建 lingxi 状态`)
      state.isLingxiHarness = true
      state.lingxiFeatureId = args.feature
      state.lingxiCurrentPhase = args.module
      state.lingxiClient = pluginClient
    }

    // ── 容错：lingxiConfig 丢失时从磁盘重新加载 ──
    if (!state.lingxiConfig) {
      try {
        const { ConfigLoader } = await import("../lingxi/config-loader.js")
        const loader = new ConfigLoader()
        state.lingxiConfig = await loader.load(dir)
        console.warn(`[financial-harness] lingxiConfig 已从磁盘重新加载`)
      } catch (err) {
        const { ConfigLoader } = await import("../lingxi/config-loader.js")
        const loader = new ConfigLoader()
        state.lingxiConfig = await loader.loadDefault()
        console.warn(`[financial-harness] lingxiConfig 加载失败，使用默认配置: ${err}`)
      }
    }

    if (args.module !== state.lingxiCurrentPhase) {
      // 阶段不匹配时也尝试修正
      console.warn(`[financial-harness] lingxiCurrentPhase 不匹配，从 args.module 修正: ${state.lingxiCurrentPhase} → ${args.module}`)
      state.lingxiCurrentPhase = args.module
    }

    // ── 容错：session 重启/compaction 后 lingxiCurrentStep 可能丢失 ──
    // 如果 currentStep 为空，用 args.step 恢复（信任 Agent 上报的值）
    if (!state.lingxiCurrentStep) {
      console.warn(`[financial-harness] lingxiCurrentStep 为空，从 args.step 恢复: ${args.module}/${args.step}`)
      state.lingxiCurrentStep = args.step
    }

    if (args.step !== state.lingxiCurrentStep) {
      const msg = `[financial-harness] update-step 与当前状态不匹配: module=${args.module}, step=${args.step}, current=${state.lingxiCurrentPhase}/${state.lingxiCurrentStep}`
      console.warn(msg)
      // 返回纠正提示，给 Agent 自我修正的机会
      return `⚠️ step 名称错误。当前应为 "${state.lingxiCurrentStep}"，你传入了 "${args.step}"。请重新调用：update-step(feature="${args.feature}", module="${args.module}", step="${state.lingxiCurrentStep}", status="${args.status}")`
    }

    const tracker = lingxiTrackers.get(sessionId)
    if (tracker) {
      // tracker 存在时由它统一写入磁盘（内部有 progressManager），避免双实例竞争
      tracker.updateStage(args.module, args.step, "completed")
    } else {
      // tracker 不存在时用独立 pm 兜底写入
      await pm.updateStage(args.feature, args.module, args.step, "completed")
    }

    // ── 容错：lingxiStepQueue 在 session 重启后可能丢失，从 pipeline 重建 ──
    if (!state.lingxiStepQueue) {
      try {
        const { LingxiOrchestrator } = await import("../lingxi/orchestrator.js")
        const orchestrator = new LingxiOrchestrator(
          state.lingxiConfig,
          state.lingxiFeatureId!,
          dir,
        )
        const allSteps = await orchestrator.getStepNames(args.module)
        const currentIdx = allSteps.indexOf(args.step)
        state.lingxiStepQueue = currentIdx >= 0 ? allSteps.slice(currentIdx + 1) : []
        console.warn(`[financial-harness] lingxiStepQueue 已从 pipeline 重建: [${state.lingxiStepQueue.join(", ")}]`)
      } catch (err) {
        console.error(`[financial-harness] lingxiStepQueue 重建失败:`, err)
        state.lingxiStepQueue = []
      }
    }

    const nextStep = state.lingxiStepQueue?.shift()

    if (nextStep) {
      // 还有下一个 Step，注入它（延迟到 session idle 后）
      state.lingxiCurrentStep = nextStep
      if (tracker) {
        tracker.updateStage(args.module, nextStep, "running")
      } else {
        await pm.updateStage(args.feature, args.module, nextStep, "running")
      }

      try {
        const { LingxiOrchestrator } = await import("../lingxi/orchestrator.js")
        const orchestrator = new LingxiOrchestrator(
          state.lingxiConfig,
          state.lingxiFeatureId!,
          dir,
          {
            title: state.lingxiFeatureTitle,
            request: "",
            requirementSource: state.lingxiRequirementSource,
          },
        )
        const stepText = await orchestrator.buildStepPrompt(args.module, nextStep)
        // 存入 pendingInjection，由 session.idle 事件触发注入
        state.pendingInjection = { type: "step", sessionId, text: stepText }
        console.warn(`[financial-harness] Step 注入已排队，等待 session idle: ${args.module}/${nextStep}`)
      } catch (err) {
        console.error(`[financial-harness] Step 注入准备失败 (${args.module}/${nextStep}):`, err)
      }
    } else {
      // 当前阶段所有 Step 已完成
      state.lingxiCurrentStep = undefined

      // ★ P0-1：直接写入 Phase 完成状态，不再依赖 Agent 调用 update-progress
      if (tracker) {
        tracker.updatePhase(args.module as PhaseId, "completed")
      } else {
        await pm.updatePhase(args.feature, args.module, "completed")
      }
      console.warn(`[financial-harness] 阶段 ${args.module} 所有 Step 完成，已自动标记 Phase completed`)

      // 仍然注入提示触发阶段切换（file-tracker 中的 phase-transition 逻辑依赖 update-progress 调用）
      const phaseCompleteText = `${args.module} 阶段所有 Step 已完成，阶段状态已自动标记为完成。请调用 update-progress(feature="${state.lingxiFeatureId}", featureName="${state.lingxiFeatureTitle ?? state.lingxiFeatureId}", module="${args.module}", status="done") 触发下一阶段切换。`
      state.pendingInjection = { type: "phase-complete", sessionId, text: phaseCompleteText }
      console.warn(`[financial-harness] 阶段完成提示已排队，等待 session idle: ${args.module}`)
    }

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

function mapStatus(status: "done" | "in_progress" | "failed" | "skipped") {
  if (status === "done") return "completed"
  if (status === "in_progress") return "running"
  return status
}
