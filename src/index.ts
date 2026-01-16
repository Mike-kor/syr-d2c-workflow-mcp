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
    version: "0.2.0",
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

      // compare_with_design - 디자인 비교
      {
        name: "d2c_compare_with_design",
        description: `Figma 디자인 스크린샷과 렌더링 결과를 비교 분석합니다.
${SERVICE_IDENTIFIERS}

📊 **비교 항목 (각 0-100점)**:
- 레이아웃 일치도
- 색상/타이포그래피 일치도
- 간격/여백 일치도
- 누락된 요소

💡 **사용법**:
1. figma-mcp.get_screenshot으로 원본 이미지 획득
2. playwright-mcp로 렌더링 결과 스크린샷
3. 이 도구로 비교 분석 (scores 필수 입력)`,
        inputSchema: {
          type: "object",
          properties: {
            designDescription: {
              type: "string",
              description: "Figma 디자인 설명 (get_design_context 결과)",
            },
            renderedDescription: {
              type: "string",
              description: "렌더링된 결과 설명",
            },
            differences: {
              type: "array",
              items: { type: "string" },
              description: "발견된 차이점 목록",
            },
            iteration: {
              type: "number",
              description: "현재 반복 횟수",
            },
            maxIterations: {
              type: "number",
              description: "최대 반복 횟수 (기본: 5)",
            },
            scores: {
              type: "object",
              properties: {
                layout: { type: "number", description: "레이아웃 점수 (0-100)" },
                colors: { type: "number", description: "색상 점수 (0-100)" },
                typography: { type: "number", description: "타이포그래피 점수 (0-100)" },
                spacing: { type: "number", description: "간격 점수 (0-100)" },
              },
              description: "항목별 점수 (0-100)",
            },
          },
          required: ["designDescription", "renderedDescription", "scores"],
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

      // iteration_check - 반복 제어
      {
        name: "d2c_iteration_check",
        description: `반복 계속 여부를 판단합니다.
${SERVICE_IDENTIFIERS}

📊 **판단 기준**:
- 70점 미만: 자동으로 계속 진행
- 70점 이상: 사용자 확인 필요
- 최대 반복 도달 또는 점수 하락: 중단 권장`,
        inputSchema: {
          type: "object",
          properties: {
            currentScore: {
              type: "number",
              description: "현재 종합 점수 (0-100)",
            },
            targetScore: {
              type: "number",
              description: "목표 점수 (기본: 70)",
            },
            iteration: {
              type: "number",
              description: "현재 반복 횟수",
            },
            maxIterations: {
              type: "number",
              description: "최대 반복 횟수 (기본: 5)",
            },
            previousScores: {
              type: "array",
              items: { type: "number" },
              description: "이전 반복의 점수들",
            },
          },
          required: ["currentScore", "iteration"],
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

      case "d2c_iteration_check": {
        const input = z
          .object({
            currentScore: z.number(),
            targetScore: z.number().optional().default(70),
            iteration: z.number(),
            maxIterations: z.number().optional().default(5),
            previousScores: z.array(z.number()).optional(),
          })
          .parse(args);

        const { currentScore, targetScore, iteration, maxIterations, previousScores } = input;

        // 점수 변화 계산
        const lastScore = previousScores?.length ? previousScores[previousScores.length - 1] : null;
        const scoreDiff = lastScore !== null ? currentScore - lastScore : null;
        const isImproving = scoreDiff === null || scoreDiff >= 0;

        // 판단 로직
        let recommendation: "continue" | "user_confirm" | "stop";
        let reason: string;

        if (iteration >= maxIterations) {
          recommendation = "stop";
          reason = `최대 반복 횟수(${maxIterations}회) 도달`;
        } else if (!isImproving && scoreDiff !== null && scoreDiff < -10) {
          recommendation = "stop";
          reason = `점수 하락 감지 (${scoreDiff}점)`;
        } else if (currentScore >= targetScore) {
          recommendation = "user_confirm";
          reason = `목표 점수(${targetScore}점) 달성! 사용자 확인 필요`;
        } else {
          recommendation = "continue";
          reason = `목표 점수(${targetScore}점) 미달, 자동 계속`;
        }

        const statusEmoji = recommendation === "continue" ? "🔄" : recommendation === "user_confirm" ? "✋" : "🛑";
        const diffText = scoreDiff !== null ? ` (${scoreDiff >= 0 ? "+" : ""}${scoreDiff})` : "";

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${statusEmoji} **반복 ${iteration}/${maxIterations} 판단 결과**

📊 현재 점수: **${currentScore}점**${diffText}
🎯 목표 점수: ${targetScore}점

**권장**: ${recommendation === "continue" ? "계속 진행" : recommendation === "user_confirm" ? "사용자 확인" : "중단"}
**이유**: ${reason}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_compare_with_design": {
        const input = z
          .object({
            designDescription: z.string(),
            renderedDescription: z.string(),
            differences: z.array(z.string()).optional(),
            iteration: z.number().optional(),
            maxIterations: z.number().optional().default(5),
            scores: z.object({
              layout: z.number(),
              colors: z.number(),
              typography: z.number(),
              spacing: z.number(),
            }),
          })
          .parse(args);

        const { scores, iteration, maxIterations } = input;
        const avgScore = Math.round((scores.layout + scores.colors + scores.typography + scores.spacing) / 4);

        // 점수 바 생성 함수
        const scoreBar = (score: number) => {
          const filled = Math.round(score / 10);
          return "█".repeat(filled) + "░".repeat(10 - filled);
        };

        const checkMark = (score: number) => score >= 70 ? "✓" : "✗";
        const iterationHeader = iteration ? `반복 ${iteration}/${maxIterations}` : "";

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **디자인 비교 결과** ${iterationHeader}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌────────────┬────────────┬──────┬──────┐
│ 항목       │ 점수바     │ 점수 │ 상태 │
├────────────┼────────────┼──────┼──────┤
│ 레이아웃   │ ${scoreBar(scores.layout)} │ ${String(scores.layout).padStart(3)}  │  ${checkMark(scores.layout)}   │
│ 색상       │ ${scoreBar(scores.colors)} │ ${String(scores.colors).padStart(3)}  │  ${checkMark(scores.colors)}   │
│ 타이포     │ ${scoreBar(scores.typography)} │ ${String(scores.typography).padStart(3)}  │  ${checkMark(scores.typography)}   │
│ 간격       │ ${scoreBar(scores.spacing)} │ ${String(scores.spacing).padStart(3)}  │  ${checkMark(scores.spacing)}   │
├────────────┼────────────┼──────┼──────┤
│ **종합**   │ ${scoreBar(avgScore)} │ **${String(avgScore).padStart(3)}** │  ${checkMark(avgScore)}   │
└────────────┴────────────┴──────┴──────┘

${input.differences?.length ? `
## 발견된 차이점
${input.differences.map((d) => `- ${d}`).join("\n")}
` : ""}
## 다음 단계
→ \`d2c_iteration_check\` 호출하여 계속 여부 판단`,
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
            text: `## SYR D2C 워크플로우 실행

### 입력 정보
- Figma: ${figmaUrl}
- 컴포넌트명: ${componentName}
- 프레임워크: ${framework}

### ⚠️ 중요: 매 단계마다 \`d2c_log_step\` 호출하여 진행 상황 출력!

### 워크플로우 단계

**Step 1: 사전 검사**
1. \`d2c_log_step(step:1, stepName:"사전 검사", status:"start")\` 호출
2. \`d2c_preflight_check\` 호출
3. figma-mcp 확인: \`get_design_context\` 호출 시도
4. playwright-mcp 확인: \`browser_snapshot\` 호출 시도
5. \`d2c_log_step(step:1, stepName:"사전 검사", status:"done")\` 호출

**Step 2: 규칙 수집**
1. \`d2c_log_step(step:2, stepName:"규칙 수집", status:"start")\` 호출
2. \`d2c_get_design_rules\` 호출
3. \`d2c_log_step(step:2, stepName:"규칙 수집", status:"done")\` 호출

**Step 3: Figma 디자인 가져오기**
1. \`d2c_log_step(step:3, stepName:"Figma 디자인 가져오기", status:"start")\` 호출
2. \`figma-mcp.get_design_context\` 호출
3. 디자인 구조, 색상, 타이포그래피, 간격 분석
4. \`d2c_log_step(step:3, stepName:"Figma 디자인 가져오기", status:"done")\` 호출

**Step 4: 컴포넌트 생성 및 반복 개선** (핵심!)
1. \`d2c_log_step(step:4, stepName:"컴포넌트 생성", status:"start", iteration:1)\` 호출
2. \`d2c_get_component_template\`로 보일러플레이트 생성
3. Figma 디자인 정보를 기반으로 코드 작성
4. \`d2c_validate_component\`로 검증
5. \`playwright-mcp.browser_navigate\`로 페이지 열기
6. \`playwright-mcp.browser_snapshot\`으로 스크린샷
7. **\`d2c_compare_with_design\`** 호출 (scores 필수 입력!)
   - layout, colors, typography, spacing 각각 0-100점 평가
8. **\`d2c_iteration_check\`** 호출하여 계속 여부 판단
   - 70점 미만: 자동으로 수정 후 반복
   - 70점 이상: 사용자에게 확인 요청
   - 최대 5회 반복
9. \`d2c_log_step(step:4, stepName:"컴포넌트 생성", status:"done", iteration:N)\` 호출

**Step 5: 최종 검증**
1. \`d2c_log_step(step:5, stepName:"최종 검증", status:"start")\` 호출
2. \`d2c_validate_component\`로 최종 검증
3. \`d2c_log_step(step:5, stepName:"최종 검증", status:"done")\` 호출

**Step 6: 완료**
1. \`d2c_log_step(step:6, stepName:"완료", status:"done")\` 호출
2. 최종 코드와 파일 경로 보고
3. 반복 히스토리 요약 (점수 변화)

---
위 워크플로우대로 진행해주세요. **매 단계마다 d2c_log_step 호출 필수!**`,
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
