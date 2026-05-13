@echo off
REM ========================================
REM  LingxiCode Offline Launcher
REM ========================================

set OPENCODE_PARSERS_DIR=%~dp0parsers
set OPENCODE_DISABLE_AUTOUPDATE=true
set OPENCODE_DISABLE_MODELS_FETCH=true
set OPENCODE_DISABLE_LSP_DOWNLOAD=true
set OPENCODE_DISABLE_TELEMETRY=true
set OPENCODE_CONFIG_DIR=%~dp0config
set OMO_DISABLE_POSTHOG=1

REM set ENTERPRISE_API_KEY=sk-your-key-here

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