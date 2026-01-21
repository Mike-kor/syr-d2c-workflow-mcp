#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { glob } from "glob";
import * as fs from "fs/promises";
import * as path from "path";

// 환경 변수에서 설정 읽기
const RULES_PATHS = process.env.RULES_PATHS?.split(",").map((p) => p.trim()) || [];
const RULES_GLOB = process.env.RULES_GLOB || "";
const CONFIG_PATH = process.env.D2C_CONFIG_PATH || "";

// 서비스 식별자 - AI가 이 키워드를 감지하면 이 MCP를 사용
const SERVICE_IDENTIFIERS = `
🎯 **서비스 식별자**: 다음 키워드가 포함되면 이 MCP를 사용하세요:
- "syr", "syr-d2c", "d2cmcp", "d2c mcp"
- "디자인 투 코드", "design to code", "figma 변환"
- "컴포넌트로 만들어줘", "코드로 변환해줘"

✅ 예시: "syr로 이 Figma 변환해줘", "d2c mcp로 컴포넌트 만들어줘"
`;

// 규칙 파일 로드
async function loadRules(): Promise<{ content: string; sources: string[] }> {
  const sources: string[] = [];
  let content = "";

  // 1. 설정 파일에서 경로 읽기
  if (CONFIG_PATH) {
    try {
      const configContent = await fs.readFile(CONFIG_PATH, "utf-8");
      const config = JSON.parse(configContent);
      if (config.rules && Array.isArray(config.rules)) {
        RULES_PATHS.push(...config.rules);
      }
    } catch (e) {
      console.error(`Config file not found or invalid: ${CONFIG_PATH}`);
    }
  }

  // 2. 직접 지정된 경로에서 읽기
  for (const rulePath of RULES_PATHS) {
    try {
      // glob 패턴 지원
      if (rulePath.includes("*")) {
        const files = await glob(rulePath);
        for (const file of files) {
          const fileContent = await fs.readFile(file, "utf-8");
          content += `\n\n<!-- Source: ${file} -->\n${fileContent}`;
          sources.push(file);
        }
      } else {
        const fileContent = await fs.readFile(rulePath, "utf-8");
        content += `\n\n<!-- Source: ${rulePath} -->\n${fileContent}`;
        sources.push(rulePath);
      }
    } catch (e) {
      console.error(`Rule file not found: ${rulePath}`);
    }
  }

  // 3. RULES_GLOB 패턴에서 읽기
  if (RULES_GLOB) {
    const patterns = RULES_GLOB.split(",").map((p) => p.trim());
    for (const pattern of patterns) {
      const files = await glob(pattern);
      for (const file of files) {
        if (!sources.includes(file)) {
          try {
            const fileContent = await fs.readFile(file, "utf-8");
            content += `\n\n<!-- Source: ${file} -->\n${fileContent}`;
            sources.push(file);
          } catch (e) {
            console.error(`Rule file not found: ${file}`);
          }
        }
      }
    }
  }

  return { content: content.trim(), sources };
}

// 기본 규칙 (내장)
const DEFAULT_RULES = `
# SYR D2C 기본 디자인 규칙

## 컴포넌트 구조
- 컴포넌트는 단일 책임 원칙을 따릅니다
- Props는 TypeScript 인터페이스로 정의합니다
- 스타일은 CSS Modules 또는 Tailwind CSS를 사용합니다

## 네이밍 컨벤션
- 컴포넌트: PascalCase (예: ButtonPrimary)
- 파일: kebab-case (예: button-primary.tsx)
- Props 인터페이스: ComponentNameProps

## 접근성
- 모든 인터랙티브 요소에 적절한 ARIA 속성 추가
- 키보드 네비게이션 지원
- 색상 대비 WCAG AA 기준 충족

## 반응형 디자인
- Mobile-first 접근법
- Breakpoints: sm(640px), md(768px), lg(1024px), xl(1280px)
`;

// MCP 서버 생성
const server = new Server(
  {
    name: "syr-d2c-workflow-mcp",
    version: "0.3.1",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  }
);

// ============ TOOLS ============

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // preflight_check - 의존성 확인
      {
        name: "d2c_preflight_check",
        description: `워크플로우 실행 전 필요한 의존성을 확인합니다.
${SERVICE_IDENTIFIERS}

🔍 **확인 항목**:
- figma-mcp 설치 여부
- playwright-mcp 설치 여부
- 규칙 파일 존재 여부

💡 **사용법**: 
1. 이 도구를 먼저 호출
2. 반환된 check_method로 각 MCP 확인
3. 누락된 것이 있으면 install_guide 안내`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // get_design_rules - 규칙 수집
      {
        name: "d2c_get_design_rules",
        description: `프로젝트의 디자인 규칙을 수집하여 반환합니다.
${SERVICE_IDENTIFIERS}

📋 **규칙 소스**:
1. 환경변수 RULES_PATHS로 지정된 파일들
2. 환경변수 RULES_GLOB 패턴에 매칭되는 파일들
3. D2C_CONFIG_PATH 설정 파일에 지정된 경로들
4. 직접 입력한 커스텀 규칙

💡 규칙이 없으면 기본 내장 규칙을 반환합니다.`,
        inputSchema: {
          type: "object",
          properties: {
            customRules: {
              type: "string",
              description: "추가할 커스텀 규칙 (선택)",
            },
            includeDefaults: {
              type: "boolean",
              description: "기본 규칙 포함 여부 (기본: true)",
            },
          },
        },
      },

      // validate_component - 컴포넌트 검증
      {
        name: "d2c_validate_component",
        description: `생성된 컴포넌트 코드가 규칙에 맞는지 검증합니다.
${SERVICE_IDENTIFIERS}

🔍 **검증 항목**:
- 네이밍 컨벤션 준수
- TypeScript Props 정의 여부
- 접근성 속성 포함 여부
- 반응형 스타일 적용 여부`,
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "검증할 컴포넌트 코드",
            },
            componentName: {
              type: "string",
              description: "컴포넌트 이름",
            },
            rules: {
              type: "string",
              description: "적용할 규칙 (없으면 로드된 규칙 사용)",
            },
          },
          required: ["code", "componentName"],
        },
      },

      // log_step - 실시간 진행 로그
      {
        name: "d2c_log_step",
        description: `워크플로우 진행 상황을 실시간으로 출력합니다.
${SERVICE_IDENTIFIERS}

📋 **각 단계 완료 시 호출하여 진행 상황을 사용자에게 알립니다.**`,
        inputSchema: {
          type: "object",
          properties: {
            step: {
              type: "number",
              description: "현재 단계 번호 (1-6)",
            },
            stepName: {
              type: "string",
              description: "단계 이름",
            },
            status: {
              type: "string",
              enum: ["start", "done", "error"],
              description: "상태",
            },
            message: {
              type: "string",
              description: "추가 메시지",
            },
            iteration: {
              type: "number",
              description: "반복 중인 경우 현재 반복 횟수",
            },
          },
          required: ["step", "stepName", "status"],
        },
      },

      // ============ 3단계 PHASE 도구들 ============

      // Phase 1: Figma MCP 기반 스크린샷 비교
      {
        name: "d2c_phase1_compare",
        description: `[Phase 1] Figma MCP로 추출한 코드의 스크린샷을 원본과 비교합니다.
${SERVICE_IDENTIFIERS}

📊 **Phase 1 - 목표 성공률: 60% (설정 가능)**
- 비교 방법: Playwright toHaveScreenshot() 픽셀 비교
- 수정 주체: Figma MCP (코드 재추출)
- HITL: 매 반복마다 사용자 확인`,
        inputSchema: {
          type: "object",
          properties: {
            successRate: {
              type: "number",
              description: "현재 성공률 (0-100, Playwright 비교 결과)",
            },
            targetRate: {
              type: "number",
              description: "목표 성공률 (기본: 60)",
            },
            iteration: {
              type: "number",
              description: "현재 반복 횟수",
            },
            maxIterations: {
              type: "number",
              description: "최대 반복 횟수 (기본: 5)",
            },
            diffDetails: {
              type: "string",
              description: "Playwright 비교에서 발견된 차이점 설명",
            },
            previousRates: {
              type: "array",
              items: { type: "number" },
              description: "이전 반복의 성공률들",
            },
          },
          required: ["successRate", "iteration"],
        },
      },

      // Phase 2: LLM 기반 이미지 Diff 수정
      {
        name: "d2c_phase2_image_diff",
        description: `[Phase 2] 이미지 diff를 분석하고 LLM이 코드를 수정합니다.
${SERVICE_IDENTIFIERS}

📊 **Phase 2 - 목표 성공률: 70% (설정 가능)**
- 비교 방법: Playwright toHaveScreenshot() 픽셀 비교
- 수정 주체: LLM (코드 직접 수정)
- HITL: 매 반복마다 사용자 확인`,
        inputSchema: {
          type: "object",
          properties: {
            successRate: {
              type: "number",
              description: "현재 성공률 (0-100, Playwright 비교 결과)",
            },
            targetRate: {
              type: "number",
              description: "목표 성공률 (기본: 70)",
            },
            iteration: {
              type: "number",
              description: "현재 반복 횟수",
            },
            maxIterations: {
              type: "number",
              description: "최대 반복 횟수 (기본: 5)",
            },
            diffAreas: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  area: { type: "string", description: "차이 영역 (예: header, button)" },
                  type: { type: "string", description: "차이 유형 (color, layout, spacing)" },
                  severity: { type: "string", enum: ["high", "medium", "low"] },
                },
              },
              description: "이미지 diff에서 발견된 차이 영역들",
            },
            previousRates: {
              type: "array",
              items: { type: "number" },
              description: "이전 반복의 성공률들",
            },
          },
          required: ["successRate", "iteration"],
        },
      },

      // Phase 3: DOM 비교 기반 수정
      {
        name: "d2c_phase3_dom_compare",
        description: `[Phase 3] DOM 구조를 비교하고 LLM이 코드를 수정합니다.
${SERVICE_IDENTIFIERS}

📊 **Phase 3 - 목표 성공률: 90% (설정 가능)**
- 비교 방법: Playwright DOM 스냅샷 비교
- 수정 주체: LLM (코드 직접 수정)
- HITL: 매 반복마다 사용자 확인`,
        inputSchema: {
          type: "object",
          properties: {
            successRate: {
              type: "number",
              description: "현재 성공률 (0-100, DOM 비교 결과)",
            },
            targetRate: {
              type: "number",
              description: "목표 성공률 (기본: 90)",
            },
            iteration: {
              type: "number",
              description: "현재 반복 횟수",
            },
            maxIterations: {
              type: "number",
              description: "최대 반복 횟수 (기본: 5)",
            },
            domDiffs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  selector: { type: "string", description: "차이가 있는 요소 선택자" },
                  expected: { type: "string", description: "예상 값" },
                  actual: { type: "string", description: "실제 값" },
                  type: { type: "string", description: "차이 유형 (missing, extra, attribute, text)" },
                },
              },
              description: "DOM 비교에서 발견된 차이점들",
            },
            previousRates: {
              type: "array",
              items: { type: "number" },
              description: "이전 반복의 성공률들",
            },
          },
          required: ["successRate", "iteration"],
        },
      },

      // 워크플로우 전체 상태 표시
      {
        name: "d2c_workflow_status",
        description: `전체 3단계 워크플로우 진행 상황을 표시합니다.
${SERVICE_IDENTIFIERS}

📊 **3단계 Phase 시스템**:
- Phase 1: Figma MCP 추출 (60%)
- Phase 2: LLM 이미지 Diff (70%)
- Phase 3: LLM DOM 비교 (90%)`,
        inputSchema: {
          type: "object",
          properties: {
            currentPhase: {
              type: "number",
              enum: [1, 2, 3],
              description: "현재 Phase (1, 2, 3)",
            },
            phase1: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] },
                successRate: { type: "number" },
                iterations: { type: "number" },
              },
            },
            phase2: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] },
                successRate: { type: "number" },
                iterations: { type: "number" },
              },
            },
            phase3: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] },
                successRate: { type: "number" },
                iterations: { type: "number" },
              },
            },
          },
          required: ["currentPhase"],
        },
      },

      // get_component_template - 템플릿 생성
      {
        name: "d2c_get_component_template",
        description: `규칙에 맞는 컴포넌트 보일러플레이트를 생성합니다.
${SERVICE_IDENTIFIERS}

🎨 **지원 프레임워크**:
- React (TSX)
- Vue (SFC)
- Svelte

📦 **포함 내용**:
- TypeScript Props 인터페이스
- 기본 스타일 구조
- 접근성 기본 속성`,
        inputSchema: {
          type: "object",
          properties: {
            componentName: {
              type: "string",
              description: "컴포넌트 이름 (PascalCase)",
            },
            framework: {
              type: "string",
              enum: ["react", "vue", "svelte"],
              description: "프레임워크 (기본: react)",
            },
            props: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                  required: { type: "boolean" },
                  description: { type: "string" },
                },
              },
              description: "Props 정의",
            },
            hasChildren: {
              type: "boolean",
              description: "children prop 포함 여부",
            },
          },
          required: ["componentName"],
        },
      },
    ],
  };
});

// 도구 실행 핸들러
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "d2c_preflight_check": {
        return {
          content: [
            {
              type: "text",
              text: `🔍 **D2C 워크플로우 사전 검사**

## 필수 의존성

### 1. Figma MCP
- **목적**: Figma 디자인 가져오기
- **확인 방법**: \`get_design_context\` 도구 호출 시도
- **설치 가이드**:
\`\`\`json
// .vscode/mcp.json
{
  "servers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--stdio"]
    }
  }
}
\`\`\`
- ⚠️ Figma Desktop 앱 설치 및 Dev Mode 활성화 필요

### 2. Playwright MCP
- **목적**: 렌더링 결과 스크린샷 확인
- **확인 방법**: \`browser_snapshot\` 도구 호출 시도
- **설치 가이드**:
\`\`\`json
// .vscode/mcp.json
{
  "servers": {
    "playwright": {
      "command": "npx",
      "args": ["@anthropic/mcp-playwright"]
    }
  }
}
\`\`\`

## 선택 의존성

### 규칙 파일
- **현재 설정된 경로**: ${RULES_PATHS.length > 0 ? RULES_PATHS.join(", ") : "(없음)"}
- **Glob 패턴**: ${RULES_GLOB || "(없음)"}
- **설정 파일**: ${CONFIG_PATH || "(없음)"}

## 다음 단계
1. 위 MCP들이 설치되어 있는지 확인하세요
2. 누락된 MCP가 있다면 설치 가이드를 따라 설치하세요
3. 모든 준비가 완료되면 \`d2c_get_design_rules\`로 규칙을 확인하세요`,
            },
          ],
        };
      }

      case "d2c_get_design_rules": {
        const input = z
          .object({
            customRules: z.string().optional(),
            includeDefaults: z.boolean().optional().default(true),
          })
          .parse(args);

        const { content, sources } = await loadRules();

        let finalRules = "";

        // 기본 규칙 추가
        if (input.includeDefaults && !content) {
          finalRules += DEFAULT_RULES;
        }

        // 로드된 규칙 추가
        if (content) {
          finalRules += "\n\n" + content;
        }

        // 커스텀 규칙 추가
        if (input.customRules) {
          finalRules += `\n\n<!-- Custom Rules -->\n${input.customRules}`;
        }

        return {
          content: [
            {
              type: "text",
              text: `📋 **디자인 규칙**

## 규칙 소스
${sources.length > 0 ? sources.map((s) => `- ${s}`).join("\n") : "- 기본 내장 규칙 사용"}

## 규칙 내용

${finalRules || DEFAULT_RULES}`,
            },
          ],
        };
      }

      case "d2c_validate_component": {
        const input = z
          .object({
            code: z.string(),
            componentName: z.string(),
            rules: z.string().optional(),
          })
          .parse(args);

        const issues: string[] = [];
        const passed: string[] = [];

        // 기본 검증
        // 1. PascalCase 체크
        if (!/^[A-Z][a-zA-Z0-9]*$/.test(input.componentName)) {
          issues.push("❌ 컴포넌트 이름이 PascalCase가 아닙니다");
        } else {
          passed.push("✅ 컴포넌트 이름 PascalCase 준수");
        }

        // 2. Props 인터페이스 체크
        if (input.code.includes("Props") && input.code.includes("interface")) {
          passed.push("✅ TypeScript Props 인터페이스 정의됨");
        } else if (input.code.includes(": {") || input.code.includes("Props")) {
          passed.push("✅ Props 타입 정의됨");
        } else {
          issues.push("⚠️ Props 인터페이스가 명시적으로 정의되지 않음");
        }

        // 3. 접근성 속성 체크
        const a11yPatterns = ["aria-", "role=", "tabIndex", "alt=", "title="];
        const hasA11y = a11yPatterns.some((p) => input.code.includes(p));
        if (hasA11y) {
          passed.push("✅ 접근성 속성 포함됨");
        } else {
          issues.push("⚠️ 접근성 속성(aria-*, role 등)이 없습니다");
        }

        // 4. 반응형 체크
        const responsivePatterns = ["@media", "sm:", "md:", "lg:", "xl:", "responsive"];
        const hasResponsive = responsivePatterns.some((p) => input.code.includes(p));
        if (hasResponsive) {
          passed.push("✅ 반응형 스타일 적용됨");
        } else {
          issues.push("💡 반응형 스타일이 감지되지 않음 (필요시 추가)");
        }

        const isValid = issues.filter((i) => i.startsWith("❌")).length === 0;

        return {
          content: [
            {
              type: "text",
              text: `🔍 **컴포넌트 검증 결과**: ${input.componentName}

## 결과: ${isValid ? "✅ 통과" : "❌ 수정 필요"}

### 통과 항목
${passed.join("\n")}

### 이슈/권장사항
${issues.length > 0 ? issues.join("\n") : "없음"}

### 검증된 코드 길이
${input.code.length} 문자`,
            },
          ],
        };
      }

      case "d2c_log_step": {
        const input = z
          .object({
            step: z.number(),
            stepName: z.string(),
            status: z.enum(["start", "done", "error"]),
            message: z.string().optional(),
            iteration: z.number().optional(),
          })
          .parse(args);

        const statusIcon = input.status === "start" ? "🚀" : input.status === "done" ? "✅" : "❌";
        const iterationText = input.iteration ? ` (반복 ${input.iteration})` : "";

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${statusIcon} [${input.step}/6] ${input.stepName}${iterationText}
${input.message ? `   → ${input.message}` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      // ============ 3단계 PHASE 핸들러 ============

      case "d2c_phase1_compare": {
        const input = z
          .object({
            successRate: z.number(),
            targetRate: z.number().optional().default(60),
            iteration: z.number(),
            maxIterations: z.number().optional().default(5),
            diffDetails: z.string().optional(),
            previousRates: z.array(z.number()).optional(),
          })
          .parse(args);

        const { successRate, targetRate, iteration, maxIterations, diffDetails, previousRates } = input;

        // 성공률 변화 계산
        const lastRate = previousRates?.length ? previousRates[previousRates.length - 1] : null;
        const rateDiff = lastRate !== null ? successRate - lastRate : null;

        // 판단 로직
        let recommendation: "continue" | "user_confirm" | "next_phase" | "stop";
        let reason: string;

        if (iteration >= maxIterations) {
          recommendation = "user_confirm";
          reason = `최대 반복 횟수(${maxIterations}회) 도달 - 사용자 결정 필요`;
        } else if (rateDiff !== null && rateDiff < -10) {
          recommendation = "stop";
          reason = `성공률 하락 감지 (${rateDiff.toFixed(1)}%)`;
        } else if (successRate >= targetRate) {
          recommendation = "next_phase";
          reason = `Phase 1 목표(${targetRate}%) 달성! Phase 2로 진행`;
        } else {
          recommendation = "continue";
          reason = `목표(${targetRate}%) 미달 - Figma MCP로 재추출`;
        }

        const statusEmoji = recommendation === "continue" ? "🔄" : 
                           recommendation === "next_phase" ? "✅" : 
                           recommendation === "user_confirm" ? "✋" : "🛑";
        const diffText = rateDiff !== null ? ` (${rateDiff >= 0 ? "+" : ""}${rateDiff.toFixed(1)}%)` : "";
        const progressBar = "█".repeat(Math.round(successRate / 10)) + "░".repeat(10 - Math.round(successRate / 10));

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Phase 1: Figma MCP 스크린샷 비교**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌────────────────────────────────────────┐
│ 반복: ${iteration}/${maxIterations}                              │
├────────────────────────────────────────┤
│ 현재 성공률: ${progressBar} ${successRate.toFixed(1)}%${diffText}  │
│ 목표 성공률: ${"█".repeat(Math.round(targetRate / 10))}${"░".repeat(10 - Math.round(targetRate / 10))} ${targetRate}%     │
├────────────────────────────────────────┤
│ 수정 주체: Figma MCP (코드 재추출)      │
└────────────────────────────────────────┘

${diffDetails ? `## 발견된 차이점\n${diffDetails}\n` : ""}
${statusEmoji} **권장**: ${recommendation === "continue" ? "Figma MCP로 재추출 후 반복" : 
                         recommendation === "next_phase" ? "Phase 2로 진행" :
                         recommendation === "user_confirm" ? "사용자 결정 필요" : "중단 권장"}

**이유**: ${reason}

## HITL 옵션
- [Y] 계속 (${recommendation === "next_phase" ? "Phase 2 진행" : "반복"})
- [N] 현재 상태로 완료
- [M] 수동 수정 후 재비교
- [S] 워크플로우 중단
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_phase2_image_diff": {
        const input = z
          .object({
            successRate: z.number(),
            targetRate: z.number().optional().default(70),
            iteration: z.number(),
            maxIterations: z.number().optional().default(5),
            diffAreas: z.array(z.object({
              area: z.string(),
              type: z.string(),
              severity: z.enum(["high", "medium", "low"]).optional(),
            })).optional(),
            previousRates: z.array(z.number()).optional(),
          })
          .parse(args);

        const { successRate, targetRate, iteration, maxIterations, diffAreas, previousRates } = input;

        const lastRate = previousRates?.length ? previousRates[previousRates.length - 1] : null;
        const rateDiff = lastRate !== null ? successRate - lastRate : null;

        let recommendation: "continue" | "user_confirm" | "next_phase" | "stop";
        let reason: string;

        if (iteration >= maxIterations) {
          recommendation = "user_confirm";
          reason = `최대 반복 횟수(${maxIterations}회) 도달 - 사용자 결정 필요`;
        } else if (rateDiff !== null && rateDiff < -10) {
          recommendation = "stop";
          reason = `성공률 하락 감지 (${rateDiff.toFixed(1)}%)`;
        } else if (successRate >= targetRate) {
          recommendation = "next_phase";
          reason = `Phase 2 목표(${targetRate}%) 달성! Phase 3로 진행`;
        } else {
          recommendation = "continue";
          reason = `목표(${targetRate}%) 미달 - LLM이 코드 수정`;
        }

        const statusEmoji = recommendation === "continue" ? "🔄" : 
                           recommendation === "next_phase" ? "✅" : 
                           recommendation === "user_confirm" ? "✋" : "🛑";
        const diffText = rateDiff !== null ? ` (${rateDiff >= 0 ? "+" : ""}${rateDiff.toFixed(1)}%)` : "";
        const progressBar = "█".repeat(Math.round(successRate / 10)) + "░".repeat(10 - Math.round(successRate / 10));

        // diff 영역 표시
        const diffAreasText = diffAreas?.length ? diffAreas.map(d => {
          const severityIcon = d.severity === "high" ? "🔴" : d.severity === "medium" ? "🟡" : "🟢";
          return `${severityIcon} ${d.area}: ${d.type}`;
        }).join("\n") : "";

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Phase 2: LLM 이미지 Diff 수정**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌────────────────────────────────────────┐
│ 반복: ${iteration}/${maxIterations}                              │
├────────────────────────────────────────┤
│ 현재 성공률: ${progressBar} ${successRate.toFixed(1)}%${diffText}  │
│ 목표 성공률: ${"█".repeat(Math.round(targetRate / 10))}${"░".repeat(10 - Math.round(targetRate / 10))} ${targetRate}%     │
├────────────────────────────────────────┤
│ 수정 주체: LLM (코드 직접 수정)          │
└────────────────────────────────────────┘

${diffAreasText ? `## 이미지 Diff 분석\n${diffAreasText}\n` : ""}
${statusEmoji} **권장**: ${recommendation === "continue" ? "LLM이 코드 수정 후 반복" : 
                         recommendation === "next_phase" ? "Phase 3로 진행" :
                         recommendation === "user_confirm" ? "사용자 결정 필요" : "중단 권장"}

**이유**: ${reason}

## LLM 수정 가이드
${diffAreas?.filter(d => d.severity === "high").map(d => `- 우선 수정: ${d.area}의 ${d.type} 문제`).join("\n") || "- 이미지 diff 결과를 기반으로 수정"}

## HITL 옵션
- [Y] 계속 (${recommendation === "next_phase" ? "Phase 3 진행" : "LLM 수정 반복"})
- [N] 현재 상태로 완료
- [M] 수동 수정 후 재비교
- [S] 워크플로우 중단
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_phase3_dom_compare": {
        const input = z
          .object({
            successRate: z.number(),
            targetRate: z.number().optional().default(90),
            iteration: z.number(),
            maxIterations: z.number().optional().default(5),
            domDiffs: z.array(z.object({
              selector: z.string(),
              expected: z.string().optional(),
              actual: z.string().optional(),
              type: z.string(),
            })).optional(),
            previousRates: z.array(z.number()).optional(),
          })
          .parse(args);

        const { successRate, targetRate, iteration, maxIterations, domDiffs, previousRates } = input;

        const lastRate = previousRates?.length ? previousRates[previousRates.length - 1] : null;
        const rateDiff = lastRate !== null ? successRate - lastRate : null;

        let recommendation: "continue" | "user_confirm" | "complete" | "stop";
        let reason: string;

        if (iteration >= maxIterations) {
          recommendation = "user_confirm";
          reason = `최대 반복 횟수(${maxIterations}회) 도달 - 사용자 결정 필요`;
        } else if (rateDiff !== null && rateDiff < -10) {
          recommendation = "stop";
          reason = `성공률 하락 감지 (${rateDiff.toFixed(1)}%)`;
        } else if (successRate >= targetRate) {
          recommendation = "complete";
          reason = `Phase 3 목표(${targetRate}%) 달성! 워크플로우 완료`;
        } else {
          recommendation = "continue";
          reason = `목표(${targetRate}%) 미달 - LLM이 DOM 기반 수정`;
        }

        const statusEmoji = recommendation === "continue" ? "🔄" : 
                           recommendation === "complete" ? "🎉" : 
                           recommendation === "user_confirm" ? "✋" : "🛑";
        const diffText = rateDiff !== null ? ` (${rateDiff >= 0 ? "+" : ""}${rateDiff.toFixed(1)}%)` : "";
        const progressBar = "█".repeat(Math.round(successRate / 10)) + "░".repeat(10 - Math.round(successRate / 10));

        // DOM diff 표시
        const domDiffsText = domDiffs?.length ? domDiffs.slice(0, 5).map(d => {
          const typeIcon = d.type === "missing" ? "❌" : d.type === "extra" ? "➕" : "🔄";
          return `${typeIcon} ${d.selector}: ${d.type}${d.expected ? ` (예상: ${d.expected})` : ""}`;
        }).join("\n") : "";

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Phase 3: LLM DOM 비교 수정**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌────────────────────────────────────────┐
│ 반복: ${iteration}/${maxIterations}                              │
├────────────────────────────────────────┤
│ 현재 성공률: ${progressBar} ${successRate.toFixed(1)}%${diffText}  │
│ 목표 성공률: ${"█".repeat(Math.round(targetRate / 10))}${"░".repeat(10 - Math.round(targetRate / 10))} ${targetRate}%     │
├────────────────────────────────────────┤
│ 수정 주체: LLM (DOM 기반 수정)           │
└────────────────────────────────────────┘

${domDiffsText ? `## DOM 차이점 (상위 5개)\n${domDiffsText}\n` : ""}
${statusEmoji} **권장**: ${recommendation === "continue" ? "LLM이 DOM 기반 수정 후 반복" : 
                         recommendation === "complete" ? "워크플로우 완료!" :
                         recommendation === "user_confirm" ? "사용자 결정 필요" : "중단 권장"}

**이유**: ${reason}

## HITL 옵션
- [Y] 계속 (${recommendation === "complete" ? "완료" : "LLM 수정 반복"})
- [N] 현재 상태로 완료
- [M] 수동 수정 후 재비교
- [S] 워크플로우 중단
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_workflow_status": {
        const input = z
          .object({
            currentPhase: z.number(),
            phase1: z.object({
              status: z.enum(["pending", "in_progress", "completed", "skipped"]).optional(),
              successRate: z.number().optional(),
              iterations: z.number().optional(),
            }).optional(),
            phase2: z.object({
              status: z.enum(["pending", "in_progress", "completed", "skipped"]).optional(),
              successRate: z.number().optional(),
              iterations: z.number().optional(),
            }).optional(),
            phase3: z.object({
              status: z.enum(["pending", "in_progress", "completed", "skipped"]).optional(),
              successRate: z.number().optional(),
              iterations: z.number().optional(),
            }).optional(),
          })
          .parse(args);

        const getStatusIcon = (status?: string) => {
          switch (status) {
            case "completed": return "✅";
            case "in_progress": return "🔄";
            case "skipped": return "⏭️";
            default: return "⬜";
          }
        };

        const formatPhase = (phase: typeof input.phase1, num: number, target: number, name: string) => {
          const icon = getStatusIcon(phase?.status);
          const rate = phase?.successRate !== undefined ? `${phase.successRate.toFixed(1)}%` : "--%";
          const iter = phase?.iterations !== undefined ? `${phase.iterations}회` : "--";
          return `│ ${icon} Phase ${num}: ${name.padEnd(20)} │ ${rate.padStart(6)} │ ${target}% │ ${iter.padStart(4)} │`;
        };

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **D2C 3단계 워크플로우 상태**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌────────────────────────────────┬────────┬─────┬──────┐
│ Phase                          │ 성공률 │ 목표│ 반복 │
├────────────────────────────────┼────────┼─────┼──────┤
${formatPhase(input.phase1, 1, 60, "Figma MCP 추출")}
${formatPhase(input.phase2, 2, 70, "LLM 이미지 Diff")}
${formatPhase(input.phase3, 3, 90, "LLM DOM 비교")}
└────────────────────────────────┴────────┴─────┴──────┘

🎯 현재 Phase: **${input.currentPhase}**

## Phase 흐름
Phase 1 (60%) → Phase 2 (70%) → Phase 3 (90%) → 완료
${input.currentPhase === 1 ? "    ↑ 현재" : input.currentPhase === 2 ? "                  ↑ 현재" : "                                    ↑ 현재"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_get_component_template": {
        const input = z
          .object({
            componentName: z.string(),
            framework: z.enum(["react", "vue", "svelte"]).optional().default("react"),
            props: z
              .array(
                z.object({
                  name: z.string(),
                  type: z.string(),
                  required: z.boolean().optional(),
                  description: z.string().optional(),
                })
              )
              .optional(),
            hasChildren: z.boolean().optional().default(false),
          })
          .parse(args);

        let template = "";

        if (input.framework === "react") {
          const propsInterface =
            input.props?.length || input.hasChildren
              ? `
interface ${input.componentName}Props {
${input.props?.map((p) => `  /** ${p.description || p.name} */\n  ${p.name}${p.required ? "" : "?"}: ${p.type};`).join("\n") || ""}
${input.hasChildren ? "  /** Children elements */\n  children?: React.ReactNode;" : ""}
}
`
              : "";

          template = `import React from 'react';

${propsInterface}
/**
 * ${input.componentName} 컴포넌트
 * 
 * @description Figma 디자인에서 생성된 컴포넌트
 */
export const ${input.componentName}: React.FC<${input.componentName}Props> = ({
${input.props?.map((p) => `  ${p.name},`).join("\n") || ""}
${input.hasChildren ? "  children," : ""}
}) => {
  return (
    <div
      className="${input.componentName.toLowerCase()}"
      role="region"
      aria-label="${input.componentName}"
    >
      {/* TODO: Figma 디자인에 맞게 구현 */}
${input.hasChildren ? "      {children}" : ""}
    </div>
  );
};

export default ${input.componentName};
`;
        } else if (input.framework === "vue") {
          template = `<script setup lang="ts">
${input.props?.length ? `defineProps<{\n${input.props.map((p) => `  ${p.name}${p.required ? "" : "?"}: ${p.type}`).join("\n")}\n}>()` : ""}
</script>

<template>
  <div
    class="${input.componentName.toLowerCase()}"
    role="region"
    :aria-label="'${input.componentName}'"
  >
    <!-- TODO: Figma 디자인에 맞게 구현 -->
${input.hasChildren ? "    <slot />" : ""}
  </div>
</template>

<style scoped>
.${input.componentName.toLowerCase()} {
  /* TODO: 스타일 추가 */
}
</style>
`;
        } else if (input.framework === "svelte") {
          template = `<script lang="ts">
${input.props?.map((p) => `  export let ${p.name}: ${p.type}${p.required ? "" : " | undefined"};`).join("\n") || ""}
</script>

<div
  class="${input.componentName.toLowerCase()}"
  role="region"
  aria-label="${input.componentName}"
>
  <!-- TODO: Figma 디자인에 맞게 구현 -->
${input.hasChildren ? "  <slot />" : ""}
</div>

<style>
  .${input.componentName.toLowerCase()} {
    /* TODO: 스타일 추가 */
  }
</style>
`;
        }

        return {
          content: [
            {
              type: "text",
              text: `🎨 **컴포넌트 템플릿**: ${input.componentName}

## 프레임워크
${input.framework}

## 생성된 템플릿

\`\`\`${input.framework === "react" ? "tsx" : input.framework === "vue" ? "vue" : "svelte"}
${template}
\`\`\`

## 다음 단계
1. Figma 디자인 컨텍스트를 가져오세요 (figma-mcp)
2. 템플릿을 디자인에 맞게 수정하세요
3. \`d2c_validate_component\`로 검증하세요`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text", text: `❌ 오류: ${message}` }],
      isError: true,
    };
  }
});

// ============ PROMPTS ============

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "design_to_code",
        description: `Figma 디자인을 규칙에 맞는 컴포넌트로 변환하는 전체 워크플로우 가이드.
${SERVICE_IDENTIFIERS}`,
        arguments: [
          {
            name: "figmaUrl",
            description: "Figma 디자인 URL (선택, 없으면 현재 선택된 노드 사용)",
            required: false,
          },
          {
            name: "componentName",
            description: "생성할 컴포넌트 이름",
            required: false,
          },
          {
            name: "framework",
            description: "프레임워크 (react/vue/svelte)",
            required: false,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "design_to_code") {
    const figmaUrl = args?.figmaUrl || "(현재 선택된 Figma 노드)";
    const componentName = args?.componentName || "(디자인에서 추출)";
    const framework = args?.framework || "react";

    return {
      description: "Figma 디자인을 컴포넌트로 변환하는 워크플로우",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `## SYR D2C 3단계 워크플로우 실행

### 입력 정보
- Figma: ${figmaUrl}
- 컴포넌트명: ${componentName}
- 프레임워크: ${framework}

### 📊 3단계 Phase 시스템
| Phase | 목표 | 비교 방법 | 수정 주체 |
|-------|------|----------|----------|
| **1** | 60%  | Playwright 스크린샷 | Figma MCP 재추출 |
| **2** | 70%  | Playwright 이미지 diff | LLM 코드 수정 |
| **3** | 90%  | Playwright DOM 비교 | LLM 코드 수정 |

---

### Step 1: 사전 검사
1. \`d2c_log_step(step:1, stepName:"사전 검사", status:"start")\`
2. \`d2c_preflight_check\` 호출
3. figma-mcp, playwright-mcp 확인
4. \`d2c_log_step(step:1, stepName:"사전 검사", status:"done")\`

### Step 2: Figma 디자인 가져오기
1. \`d2c_log_step(step:2, stepName:"Figma 디자인", status:"start")\`
2. \`figma-mcp.get_design_context\` 호출
3. \`figma-mcp.get_screenshot\` 으로 원본 스크린샷 저장
4. \`d2c_log_step(step:2, stepName:"Figma 디자인", status:"done")\`

---

### 🔄 Phase 1: Figma MCP 추출 (목표 60%)
1. \`d2c_log_step(step:3, stepName:"Phase 1", status:"start", iteration:1)\`
2. \`d2c_get_component_template\`로 템플릿 생성
3. **Figma MCP로 코드 추출/수정**
4. \`playwright-mcp.browser_navigate\`로 렌더링
5. \`playwright-mcp.browser_screenshot\`으로 스크린샷
6. **Playwright toHaveScreenshot()으로 비교하여 성공률 계산**
7. **\`d2c_phase1_compare\`** 호출 (successRate, iteration 필수!)
8. **HITL 확인**: 사용자 응답에 따라:
   - [Y] → 60% 미달이면 반복, 달성이면 Phase 2로
   - [M] → 수동 수정 후 재비교
   - [N] → 현재 상태로 다음 단계
9. \`d2c_log_step(step:3, stepName:"Phase 1", status:"done")\`

---

### 🔄 Phase 2: LLM 이미지 Diff (목표 70%)
1. \`d2c_log_step(step:4, stepName:"Phase 2", status:"start", iteration:1)\`
2. **Playwright 이미지 diff 분석**
3. diff 결과 기반으로 **LLM이 코드 수정**
4. 렌더링 후 스크린샷 비교
5. **\`d2c_phase2_image_diff\`** 호출 (successRate, diffAreas 포함!)
6. **HITL 확인**: 사용자 응답에 따라:
   - [Y] → 70% 미달이면 LLM 수정 반복, 달성이면 Phase 3로
   - [M] → 수동 수정 후 재비교
   - [N] → 현재 상태로 다음 단계
7. \`d2c_log_step(step:4, stepName:"Phase 2", status:"done")\`

---

### 🔄 Phase 3: LLM DOM 비교 (목표 90%)
1. \`d2c_log_step(step:5, stepName:"Phase 3", status:"start", iteration:1)\`
2. **Playwright DOM 스냅샷 비교**
3. DOM 차이 기반으로 **LLM이 코드 수정**
4. 렌더링 후 DOM 비교
5. **\`d2c_phase3_dom_compare\`** 호출 (successRate, domDiffs 포함!)
6. **HITL 확인**: 사용자 응답에 따라:
   - [Y] → 90% 미달이면 LLM 수정 반복, 달성이면 완료
   - [M] → 수동 수정 후 재비교
   - [N] → 현재 상태로 완료
7. \`d2c_log_step(step:5, stepName:"Phase 3", status:"done")\`

---

### Step 6: 완료
1. \`d2c_log_step(step:6, stepName:"완료", status:"done")\`
2. \`d2c_workflow_status\` 호출하여 최종 상태 표시
3. 최종 코드와 파일 경로 보고
4. 각 Phase별 성공률 변화 히스토리 요약

---

**⚠️ 중요 규칙**:
- 매 Phase마다 **반드시 HITL 확인** (사용자에게 계속 여부 질문)
- 모든 Phase에서 사용자가 수동 수정 가능 ([M] 옵션)
- 성공률은 Playwright 비교 결과를 기반으로 객관적으로 측정
- \`d2c_workflow_status\`로 언제든 전체 진행 상황 확인 가능`,
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});

// ============ RESOURCES ============

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "d2c://rules/default",
        name: "기본 디자인 규칙",
        description: "SYR D2C 기본 디자인 규칙 문서",
        mimeType: "text/markdown",
      },
      {
        uri: "d2c://templates/react",
        name: "React 컴포넌트 템플릿",
        description: "React TSX 컴포넌트 기본 템플릿",
        mimeType: "text/plain",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "d2c://rules/default") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: DEFAULT_RULES,
        },
      ],
    };
  }

  if (uri === "d2c://templates/react") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: `import React from 'react';

interface ComponentProps {
  // Props here
}

export const Component: React.FC<ComponentProps> = (props) => {
  return (
    <div role="region" aria-label="Component">
      {/* Content */}
    </div>
  );
};

export default Component;
`,
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// 서버 시작
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SYR D2C Workflow MCP server running on stdio (v0.1.0)");
  console.error(`  Rules paths: ${RULES_PATHS.join(", ") || "(none)"}`);
  console.error(`  Rules glob: ${RULES_GLOB || "(none)"}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
