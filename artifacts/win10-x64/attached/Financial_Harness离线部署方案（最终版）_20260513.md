好的，基于以上所有分析，假设 `OPENCODE_CONFIG_DIR` 指向的目录下 `plugins/` 中的插件会被自动加载（OmO 已验证），以下是最终方案。

## Financial Harness 离线部署方案

### 核心思路

仿照 OmO 的方式：在 `config/plugins/` 下放一个**单文件入口** `financial-harness.ts`，该文件 re-export 同目录下 `financial-harness/` 子目录中的完整插件。

### 目标目录结构

```
C:\lingxicode-offline-v1.4.6-win10-x64\
├── bin\opencode.exe
├── parsers\
├── lingxicode.bat                              ← 小改：自动部署 commands
├── config\
│   ├── opencode.json                           ← 不改
│   ├── oh-my-openagent.json
│   ├── plugins\
│   │   ├── superpowers.js                      ← 已有（单文件插件）
│   │   ├── oh-my-opencode\                     ← 已有（OmO 目录）
│   │   ├── financial-harness.ts                ← 【新增】入口文件
│   │   └── financial-harness\                  ← 【新增】插件目录
│   │       ├── index.ts
│   │       ├── tui.tsx
│   │       ├── package.json
│   │       ├── tsconfig.json
│   │       ├── lingxi_harness_config.json
│   │       ├── src\
│   │       ├── commands\
│   │       ├── pipeline_config\
│   │       └── node_modules\                   ← 精简后
│   └── skills\
└── README.txt
```

### 关键文件

**1. `config/plugins/financial-harness.ts`**（入口文件，被 OpenCode 自动扫描）

```typescript
export { default } from "./financial-harness/index.ts"
```

**2. `config/plugins/financial-harness/`**（完整插件目录）

从 `D:\0.Workspace\Coding_Agent\opencode-dev\opencode-dev\financial-harness` 复制，精简 node_modules。

### node_modules 精简

删除以下包（确定不需要 + 大概率不需要）：

| 包                                                | 大小  | 理由                                 |
| ------------------------------------------------- | ----- | ------------------------------------ |
| `typescript`                                      | 23MB  | devDep                               |
| `fast-check`                                      | 2MB   | devDep                               |
| `bun-types`                                       | 1MB   | devDep                               |
| `@types`                                          | 1MB   | devDep                               |
| `three`                                           | 29MB  | @opentui 间接依赖，TUI 终端不需要 3D |
| `@jimp` + `jimp` + `gifwrap`                      | 67MB  | 图像处理，终端不需要                 |
| `bun-webgpu-win32-x64` + `@webgpu` + `bun-webgpu` | 21MB+ | WebGPU，终端不需要                   |
| `planck` + `@dimforge` + `stage-js`               | 15MB+ | 物理引擎，终端不需要                 |

### lingxicode.bat 修改

```bat
@echo off
set OPENCODE_PARSERS_DIR=%~dp0parsers
set OPENCODE_DISABLE_AUTOUPDATE=true
set OPENCODE_DISABLE_MODELS_FETCH=true
set OPENCODE_DISABLE_LSP_DOWNLOAD=true
set OPENCODE_DISABLE_TELEMETRY=true
set OPENCODE_CONFIG_DIR=%~dp0config
set OMO_DISABLE_POSTHOG=1

REM 自动部署 Financial Harness commands 到工作目录
if not exist ".opencode\commands\lingxi_harness.md" (
    if not exist ".opencode\commands" mkdir ".opencode\commands"
    copy /Y "%~dp0config\plugins\financial-harness\commands\*.md" ".opencode\commands\" >nul 2>&1
)

REM 自动部署 tui.json（无 BOM）
if not exist ".opencode\tui.json" (
    if not exist ".opencode" mkdir ".opencode"
    >".opencode\tui.json" echo {"$schema":"https://opencode.ai/tui.json","plugin":["./financial-harness/tui.tsx"]}
)

"%~dp0bin/opencode.exe" %*
```

***注意：TUI 插件的路径问题需要验证。根据 postmortem 文档，`tui.json` 中的路径是相对于 `.opencode/` 目录解析的。如果 FH 插件在 `config/plugins/financial-harness/` 而不是 `.opencode/financial-harness/`，TUI 路径需要用绝对路径。这个在验证时确认。***

### `system-inject.ts` 中的 `harness-tools` 引用

代码中有：

```typescript
const TOOLS_DIR = path.join(import.meta.dir, "../../harness-tools")
```

这个路径在离线包中不存在 `harness-tools/` 目录（因为已经没有 Python 了）。但代码用 `try-catch` 包裹，不存在时静默跳过，**不影响运行**。

### 打包脚本（在开发机执行）

```powershell
$src = "D:\0.Workspace\Coding_Agent\opencode-dev\opencode-dev\financial-harness"
$deployRoot = "D:\0.Workspace\Coding_Agent\opencode-dev\opencode-dev\编译方案\lingxicode-offline-v1.4.6-win10-x64"
$target = "$deployRoot\config\plugins\financial-harness"
$noBom = New-Object System.Text.UTF8Encoding $false

# 1. 创建入口文件（无 BOM！）
[System.IO.File]::WriteAllText(
    "$deployRoot\config\plugins\financial-harness.ts",
    'export { default } from "./financial-harness/index.ts"',
    $noBom
)

# 2. 复制插件目录（排除开发文件）
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
robocopy $src $target /E /XD __tests__ .harness .tmp-test-progress .tmp-test-project docs bin .git /XF bun.lock INSTALL.md

# 3. 精简 node_modules
$removeDirs = @(
    "typescript", "fast-check", "bun-types", "@types",
    "three", "@jimp", "jimp", "gifwrap",
    "bun-webgpu-win32-x64", "bun-webgpu", "@webgpu",
    "planck", "@dimforge", "stage-js",
    "web-tree-sitter"
)
foreach ($d in $removeDirs) {
    $p = "$target\node_modules\$d"
    if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "  删除: $d" }
}

# 4. 统计
$size = (Get-ChildItem -Recurse $target -File -EA SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "`n完成！插件大小: $([math]::Round($size, 1)) MB"
```

### 验证步骤

在开发机上执行打包脚本后，进入任意项目目录运行：

```powershell
cd D:\某个测试项目
C:\lingxicode-offline-v1.4.6-win10-x64\lingxicode.bat
```

观察：

1. 启动日志中是否出现 `financial-harness` 相关加载信息
2. 输入 `/prd` 或 `/lingxi_harness` 看命令是否可用
3. 检查 TUI Worker 日志（`%USERPROFILE%\.local\share\opencode\log\` 下最小的文件）确认无报错

### 需要验证的假设

| #    | 假设                                                         | 验证方法         |
| ---- | ------------------------------------------------------------ | ---------------- |
| 1    | `config/plugins/financial-harness.ts` 会被自动扫描加载       | 启动后看日志     |
| 2    | 入口文件中 `./financial-harness/index.ts` 的相对路径能正确解析 | 同上             |
| 3    | 精简 node_modules 后 @opentui 仍能正常工作                   | TUI 面板是否显示 |
| 4    | TUI 插件的加载路径（需要确认是通过 Server Plugin 的 tui 导出还是独立 tui.json） | 看 TUI 日志      |

如果假设 1 失败（入口文件不被扫描），备选方案是在 `opencode.json` 中添加 `"plugin": ["./plugins/financial-harness"]`。