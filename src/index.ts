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
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// 환경 변수에서 설정 읽기
const RULES_PATHS = process.env.RULES_PATHS?.split(",").map((p) => p.trim()) || [];
const RULES_GLOB = process.env.RULES_GLOB || "";
const CONFIG_PATH = process.env.D2C_CONFIG_PATH || "";
const PROJECT_ROOT = process.env.D2C_PROJECT_ROOT || process.cwd();

// Figma 설정 (필수)
const FIGMA_TOKEN = process.env.FIGMA_TOKEN || "";
const FIGMA_URL_PATH = path.join(PROJECT_ROOT, "d2c-baseline", "figma-url.txt");

// Baseline 스크린샷 경로
const BASELINE_PATH = path.join(PROJECT_ROOT, "d2c-baseline", "design.png");

// Playwright 스크린샷 설정
const VIEWPORT_WIDTH = parseInt(process.env.D2C_VIEWPORT_WIDTH || "360", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.D2C_VIEWPORT_HEIGHT || "800", 10);
const DEVICE_SCALE_FACTOR = parseInt(process.env.D2C_DEVICE_SCALE_FACTOR || "2", 10);

// 비교 스크린샷 저장 경로 (기본: .d2c-screenshots/ - .gitignore에 추가 권장)
const SCREENSHOT_DIR = process.env.D2C_SCREENSHOT_DIR || path.join(PROJECT_ROOT, ".d2c-screenshots");

// 타임스탬프 형식 파일명 생성 헬퍼
function generateScreenshotFilename(phase: number, iteration: number, type: "baseline" | "code" | "compare"): string {
  const now = new Date();
  const timestamp = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, "0") +
    now.getDate().toString().padStart(2, "0") +
    now.getHours().toString().padStart(2, "0") +
    now.getMinutes().toString().padStart(2, "0") +
    now.getSeconds().toString().padStart(2, "0");
  return `phase${phase}-v${iteration}-${type}-${timestamp}.png`;
}

// Phase별 참고 기준 (일반적 달성 수준) - 환경변수로 오버라이드 가능
// ⚠️ 이 값은 "목표"가 아닌 "참고 기준"으로만 표시됨
// 모든 판단은 사용자가 HITL에서 직접 수행
const PHASE_TARGETS = {
  phase1: parseInt(process.env.D2C_PHASE1_TARGET || "60", 10),  // Phase 1 참고 기준
  phase2: parseInt(process.env.D2C_PHASE2_TARGET || "70", 10),  // Phase 2 참고 기준
  phase3: parseInt(process.env.D2C_PHASE3_TARGET || "90", 10),  // Phase 3 참고 기준
};

// ============================================
// 세션 상태 관리 (메모리 내)
// ============================================

interface PhaseExecutionRecord {
  phase: number;
  iteration: number;
  successRate: number;
  timestamp: Date;
}

interface D2CSessionState {
  phase1Executed: boolean;
  phase2Executed: boolean;
  phase3Executed: boolean;
  currentPhase: number | null;
  phaseHistory: PhaseExecutionRecord[];
  workflowStarted: boolean;
  workflowCompleted: boolean;
}

// 세션 상태 (MCP 서버 인스턴스당 하나)
let sessionState: D2CSessionState = {
  phase1Executed: false,
  phase2Executed: false,
  phase3Executed: false,
  currentPhase: null,
  phaseHistory: [],
  workflowStarted: false,
  workflowCompleted: false,
};

// 세션 상태 초기화
function resetSessionState(): void {
  sessionState = {
    phase1Executed: false,
    phase2Executed: false,
    phase3Executed: false,
    currentPhase: null,
    phaseHistory: [],
    workflowStarted: false,
    workflowCompleted: false,
  };
}

// Phase 실행 기록
function recordPhaseExecution(phase: number, iteration: number, successRate: number): void {
  sessionState.phaseHistory.push({
    phase,
    iteration,
    successRate,
    timestamp: new Date(),
  });
  
  if (phase === 1) sessionState.phase1Executed = true;
  if (phase === 2) sessionState.phase2Executed = true;
  if (phase === 3) sessionState.phase3Executed = true;
  
  sessionState.currentPhase = phase;
  sessionState.workflowStarted = true;
}

// 세션 요약 생성
function generateSessionSummary(): string {
  if (sessionState.phaseHistory.length === 0) {
    return "세션 이력이 없습니다.";
  }
  
  const summary = sessionState.phaseHistory.map((record, index) => {
    const time = record.timestamp.toLocaleTimeString("ko-KR");
    return `${index + 1}. Phase ${record.phase} (v${record.iteration}) - ${record.successRate.toFixed(1)}% @ ${time}`;
  }).join("\n");
  
  const lastRecord = sessionState.phaseHistory[sessionState.phaseHistory.length - 1];
  const totalIterations = sessionState.phaseHistory.length;
  
  return `## 📊 세션 요약

### 실행 이력
${summary}

### 통계
- 총 Phase 실행: ${totalIterations}회
- 최종 Phase: Phase ${lastRecord.phase}
- 최종 성공률: ${lastRecord.successRate.toFixed(1)}%
- Phase 1 실행: ${sessionState.phase1Executed ? "✅" : "❌"}
- Phase 2 실행: ${sessionState.phase2Executed ? "✅" : "❌"}
- Phase 3 실행: ${sessionState.phase3Executed ? "✅" : "❌"}`;
}

// OpenSpec 규칙 탐지 경로
const OPENSPEC_SEARCH_PATHS = [
  "openspec/specs/*/spec.md",
  ".cursor/openspec/specs/*/spec.md",
  "docs/openspec/specs/*/spec.md",
];

// AI 어시스턴트 설정 파일 경로
const AI_SETUP_PATHS = {
  cursor: {
    rules: [".cursor/rules", ".cursorrules"],
    description: "Cursor AI Rules",
  },
  copilot: {
    rules: [".github/copilot-instructions.md"],
    description: "GitHub Copilot Instructions",
  },
};

// D2C 워크플로우용 추천 Cursor Rules
const RECOMMENDED_CURSOR_RULES = `# SYR D2C 워크플로우 규칙

## 서비스 식별
다음 키워드가 포함된 요청에서 syr-d2c-workflow-mcp를 사용하세요:
- "syr", "d2c", "디자인 투 코드", "Figma 변환"
- "컴포넌트로 만들어줘", "코드로 변환해줘"

## 워크플로우 규칙

### Phase 시스템
1. **Phase 1** (목표 60%): Figma MCP로 코드 추출 → Playwright 스크린샷 비교
2. **Phase 2** (목표 70%): 이미지 diff 분석 → LLM 코드 수정
3. **Phase 3** (목표 90%): DOM 비교 → LLM 코드 수정

### 필수 도구 사용 순서
1. \`d2c_preflight_check\` - 의존성 확인
2. \`d2c_check_ai_setup\` - AI 설정 확인
3. \`d2c_load_openspec_rules\` - 규칙 로드
4. \`d2c_get_workflow_tasks\` - 체크리스트 확인
5. Phase별 도구 (\`d2c_phase1_compare\`, \`d2c_phase2_image_diff\`, \`d2c_phase3_dom_compare\`)
6. \`d2c_validate_against_spec\` - 규칙 검증
7. \`d2c_workflow_status\` - 진행 상황 확인

### HITL (Human-in-the-Loop)
- 매 Phase 반복마다 사용자 확인 필수
- [Y] 계속, [N] 완료, [M] 수동 수정, [S] 중단

### 코드 품질 규칙
- 컴포넌트: PascalCase
- Props: TypeScript interface 정의
- 접근성: aria-*, role 속성 포함
- 반응형: Mobile-first 접근

## 상태 관리
- \`d2c_workflow_status\`로 언제든 현재 Phase 확인 가능
- Phase 전환 시 이전 Phase 결과 요약 제공
`;

// D2C 워크플로우용 추천 Copilot Instructions
const RECOMMENDED_COPILOT_INSTRUCTIONS = `# SYR D2C 워크플로우 가이드

## 개요
이 프로젝트는 Figma 디자인을 코드로 변환하는 D2C(Design-to-Code) 워크플로우를 사용합니다.

## MCP 서버
- **syr-d2c-workflow-mcp**: 3단계 Phase 시스템으로 디자인-코드 변환 품질 관리
- **figma-mcp**: Figma 디자인 컨텍스트 및 코드 추출
- **playwright-mcp**: 렌더링 결과 스크린샷/DOM 비교

## 3단계 Phase 시스템
| Phase | 목표 성공률 | 비교 방법 | 수정 주체 |
|-------|------------|----------|----------|
| 1 | 60% | Playwright 스크린샷 | Figma MCP 재추출 |
| 2 | 70% | 이미지 diff | LLM 코드 수정 |
| 3 | 90% | DOM 비교 | LLM 코드 수정 |

## 코드 컨벤션
- React 컴포넌트: PascalCase (예: ButtonPrimary)
- 파일명: kebab-case (예: button-primary.tsx)
- Props: \`interface ComponentNameProps\` 형식
- 접근성: 모든 인터랙티브 요소에 ARIA 속성

## 워크플로우 트리거 키워드
다음 키워드가 포함되면 D2C 워크플로우 실행:
- "syr", "d2c", "디자인 투 코드"
- "Figma 변환", "컴포넌트로 만들어줘"
`;

// AI 설정 상태 타입
interface AISetupStatus {
  cursor: {
    found: boolean;
    path?: string;
    type?: "folder" | "file";
  };
  copilot: {
    found: boolean;
    path?: string;
  };
}

// Playwright Test Runner 결과 타입
interface PlaywrightTestResult {
  success: boolean;
  passed: number;
  failed: number;
  total: number;
  successRate: number;
  details: string;
  diffPixels?: number;
  maxDiffPixels?: number;
  snapshotPath?: string;
  diffPath?: string;
}

// Playwright 테스트 디렉토리
const PLAYWRIGHT_TEST_DIR = path.join(PROJECT_ROOT, ".d2c-tests");

// Playwright 시각적 비교 테스트 생성 (Phase 1, 2용)
async function generateVisualTest(
  testName: string,
  targetUrl: string,
  baselineImagePath: string,
  maxDiffPixels: number = 100,
  threshold: number = 0.1,
  phase: number = 1,
  iteration: number = 1
): Promise<string> {
  const testDir = PLAYWRIGHT_TEST_DIR;
  await fs.mkdir(testDir, { recursive: true });
  
  // 스크린샷 저장 디렉토리 생성
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  
  // baseline 이미지를 스냅샷 디렉토리에 복사
  const snapshotDir = path.join(testDir, `${testName}.spec.ts-snapshots`);
  await fs.mkdir(snapshotDir, { recursive: true });
  
  const baselineDest = path.join(snapshotDir, `${testName}-baseline-1-chromium-darwin.png`);
  await fs.copyFile(baselineImagePath, baselineDest);
  
  // 스크린샷 파일명 생성
  const baselineFilename = generateScreenshotFilename(phase, iteration, "baseline");
  const codeFilename = generateScreenshotFilename(phase, iteration, "code");
  const compareFilename = generateScreenshotFilename(phase, iteration, "compare");
  
  const testContent = `import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test('${testName}', async ({ page }) => {
  // Viewport 및 Scale 설정 (MCP 환경변수 반영)
  await page.setViewportSize({ width: ${VIEWPORT_WIDTH}, height: ${VIEWPORT_HEIGHT} });
  
  await page.goto('${targetUrl}');
  await page.waitForLoadState('networkidle');
  
  // 타겟(구현체) 스크린샷 저장
  const screenshotDir = '${SCREENSHOT_DIR}';
  await page.screenshot({ 
    path: path.join(screenshotDir, '${codeFilename}'),
    scale: 'device'
  });
  
  // Baseline 스크린샷 복사
  fs.copyFileSync('${baselineImagePath}', path.join(screenshotDir, '${baselineFilename}'));
  
  await expect(page).toHaveScreenshot('${testName}-baseline.png', {
    maxDiffPixels: ${maxDiffPixels},
    threshold: ${threshold},
  });
});
`;

  const testPath = path.join(testDir, `${testName}.spec.ts`);
  await fs.writeFile(testPath, testContent, "utf-8");
  
  return testPath;
}

// Playwright DOM golden 비교 테스트 생성 (Phase 3용)
async function generateDomGoldenTest(
  testName: string,
  targetUrl: string,
  goldenDomPath: string,
  selectors: string[] = ["body"]
): Promise<string> {
  const testDir = PLAYWRIGHT_TEST_DIR;
  await fs.mkdir(testDir, { recursive: true });
  
  // golden DOM 파일 읽기
  const goldenDom = await fs.readFile(goldenDomPath, "utf-8");
  
  const testContent = `import { test, expect } from '@playwright/test';

const goldenDom = ${JSON.stringify(JSON.parse(goldenDom), null, 2)};

test('${testName} - DOM comparison', async ({ page }) => {
  await page.goto('${targetUrl}');
  await page.waitForLoadState('networkidle');
  
  const selectors = ${JSON.stringify(selectors)};
  const results = [];
  
  for (const selector of selectors) {
    const elements = await page.locator(selector).all();
    
    for (const element of elements) {
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const id = await element.getAttribute('id');
      const className = await element.getAttribute('class');
      const textContent = await element.evaluate(el => el.textContent?.trim().substring(0, 100));
      
      results.push({
        selector,
        tagName,
        id,
        className,
        textContent
      });
    }
  }
  
  // golden과 비교
  const matched = results.filter((r, i) => {
    const golden = goldenDom[i];
    if (!golden) return false;
    return r.tagName === golden.tagName && 
           r.id === golden.id &&
           r.className === golden.className;
  });
  
  const successRate = (matched.length / Math.max(results.length, goldenDom.length)) * 100;
  
  console.log('DOM_COMPARISON_RESULT:', JSON.stringify({
    total: Math.max(results.length, goldenDom.length),
    matched: matched.length,
    successRate: successRate.toFixed(2)
  }));
  
  // 90% 이상 일치해야 통과
  expect(successRate).toBeGreaterThanOrEqual(90);
});
`;

  const testPath = path.join(testDir, `${testName}-dom.spec.ts`);
  await fs.writeFile(testPath, testContent, "utf-8");
  
  return testPath;
}

// Playwright config 생성
async function ensurePlaywrightConfig(): Promise<void> {
  const configPath = path.join(PLAYWRIGHT_TEST_DIR, "playwright.config.ts");
  
  try {
    await fs.access(configPath);
    return; // 이미 존재
  } catch {
    // 생성
  }
  
  const configContent = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30000,
  expect: {
    timeout: 10000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.1,
    },
  },
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['json', { outputFile: 'test-results.json' }],
    ['line']
  ],
  outputDir: './test-results',
});
`;

  await fs.writeFile(configPath, configContent, "utf-8");
}

// Playwright 테스트 실행 및 결과 파싱
async function runPlaywrightTest(testPath: string): Promise<PlaywrightTestResult> {
  await ensurePlaywrightConfig();
  
  const testDir = path.dirname(testPath);
  const testFile = path.basename(testPath);
  
  try {
    const { stdout, stderr } = await execAsync(
      `npx playwright test ${testFile} --reporter=json`,
      { 
        cwd: testDir,
        timeout: 60000,
        env: { ...process.env, CI: "true" }
      }
    );
    
    // JSON 결과 파싱
    const resultsPath = path.join(testDir, "test-results.json");
    try {
      const resultsJson = await fs.readFile(resultsPath, "utf-8");
      const results = JSON.parse(resultsJson);
      
      const passed = results.stats?.expected || 0;
      const failed = results.stats?.unexpected || 0;
      const total = passed + failed;
      
      return {
        success: failed === 0,
        passed,
        failed,
        total,
        successRate: total > 0 ? (passed / total) * 100 : 0,
        details: stdout + stderr,
      };
    } catch {
      // JSON 파싱 실패 시 stdout에서 파싱
      return parsePlaywrightOutput(stdout + stderr);
    }
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    // 테스트 실패해도 결과 파싱 시도
    const output = (execError.stdout || "") + (execError.stderr || "");
    
    // DOM 비교 결과 파싱 시도
    const domMatch = output.match(/DOM_COMPARISON_RESULT:\s*(\{[^}]+\})/);
    if (domMatch) {
      try {
        const domResult = JSON.parse(domMatch[1]);
        return {
          success: parseFloat(domResult.successRate) >= 90,
          passed: domResult.matched,
          failed: domResult.total - domResult.matched,
          total: domResult.total,
          successRate: parseFloat(domResult.successRate),
          details: output,
        };
      } catch {
        // 파싱 실패
      }
    }
    
    return parsePlaywrightOutput(output);
  }
}

// Playwright 출력에서 결과 파싱
function parsePlaywrightOutput(output: string): PlaywrightTestResult {
  // "1 passed" 또는 "1 failed" 패턴 찾기
  const passedMatch = output.match(/(\d+)\s+passed/);
  const failedMatch = output.match(/(\d+)\s+failed/);
  
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const total = passed + failed;
  
  // diff 픽셀 수 파싱
  const diffMatch = output.match(/(\d+)\s+pixels.*differ/i);
  const diffPixels = diffMatch ? parseInt(diffMatch[1], 10) : undefined;
  
  // maxDiffPixels 파싱
  const maxDiffMatch = output.match(/maxDiffPixels:\s*(\d+)/);
  const maxDiffPixels = maxDiffMatch ? parseInt(maxDiffMatch[1], 10) : undefined;
  
  // 스냅샷 경로 파싱
  const snapshotMatch = output.match(/Screenshot comparison failed:?\s*([^\n]+)/i);
  const diffPathMatch = output.match(/diff:\s*([^\n]+\.png)/i);
  
  let successRate = 0;
  if (total > 0) {
    successRate = (passed / total) * 100;
  } else if (diffPixels !== undefined && maxDiffPixels !== undefined) {
    // 픽셀 기반 성공률 계산
    successRate = Math.max(0, 100 - (diffPixels / maxDiffPixels) * 100);
  }
  
  return {
    success: failed === 0 && passed > 0,
    passed,
    failed,
    total: total || 1,
    successRate,
    details: output,
    diffPixels,
    maxDiffPixels,
    snapshotPath: snapshotMatch?.[1],
    diffPath: diffPathMatch?.[1],
  };
}

// 스크린샷 비교 결과 타입
interface CompareResult {
  successRate: number;
  totalPixels: number;
  diffPixels: number;
  width: number;
  height: number;
  diffImage?: string; // base64 PNG
}

// DOM 비교 결과 타입
interface DomCompareResult {
  successRate: number;
  totalElements: number;
  matchedElements: number;
  missingElements: string[];
  extraElements: string[];
  attributeDiffs: Array<{
    selector: string;
    attribute: string;
    expected: string;
    actual: string;
  }>;
  textDiffs: Array<{
    selector: string;
    expected: string;
    actual: string;
  }>;
}

// DOM 요소 정보 타입
interface DomElementInfo {
  tag: string;
  id?: string;
  classes: string[];
  attributes: Record<string, string>;
  textContent?: string;
  children: DomElementInfo[];
}

// DOM 구조 비교 함수
function compareDomStructures(
  expected: DomElementInfo[],
  actual: DomElementInfo[],
  parentSelector: string = ""
): DomCompareResult {
  const result: DomCompareResult = {
    successRate: 0,
    totalElements: 0,
    matchedElements: 0,
    missingElements: [],
    extraElements: [],
    attributeDiffs: [],
    textDiffs: [],
  };

  // 요소를 selector로 매핑
  const getSelector = (el: DomElementInfo, index: number): string => {
    if (el.id) return `#${el.id}`;
    const classStr = el.classes.length > 0 ? `.${el.classes.join(".")}` : "";
    return `${parentSelector} ${el.tag}${classStr}:nth-child(${index + 1})`.trim();
  };

  const expectedMap = new Map<string, DomElementInfo>();
  const actualMap = new Map<string, DomElementInfo>();

  expected.forEach((el, i) => {
    const sel = getSelector(el, i);
    expectedMap.set(sel, el);
    result.totalElements++;
  });

  actual.forEach((el, i) => {
    const sel = getSelector(el, i);
    actualMap.set(sel, el);
  });

  // 비교
  for (const [selector, expectedEl] of expectedMap) {
    const actualEl = actualMap.get(selector);
    
    if (!actualEl) {
      result.missingElements.push(selector);
      continue;
    }

    let elementMatched = true;

    // 태그 비교
    if (expectedEl.tag !== actualEl.tag) {
      elementMatched = false;
    }

    // 주요 속성 비교 (class, style 등)
    const importantAttrs = ["class", "style", "href", "src", "alt", "role", "aria-label"];
    for (const attr of importantAttrs) {
      const expVal = expectedEl.attributes[attr] || "";
      const actVal = actualEl.attributes[attr] || "";
      if (expVal !== actVal && expVal !== "") {
        result.attributeDiffs.push({
          selector,
          attribute: attr,
          expected: expVal,
          actual: actVal,
        });
        elementMatched = false;
      }
    }

    // 텍스트 비교 (리프 노드만)
    if (expectedEl.children.length === 0 && actualEl.children.length === 0) {
      const expText = (expectedEl.textContent || "").trim();
      const actText = (actualEl.textContent || "").trim();
      if (expText !== actText && expText !== "") {
        result.textDiffs.push({
          selector,
          expected: expText,
          actual: actText,
        });
        elementMatched = false;
      }
    }

    if (elementMatched) {
      result.matchedElements++;
    }

    // 자식 요소 재귀 비교
    if (expectedEl.children.length > 0 || actualEl.children.length > 0) {
      const childResult = compareDomStructures(
        expectedEl.children,
        actualEl.children,
        selector
      );
      result.totalElements += childResult.totalElements;
      result.matchedElements += childResult.matchedElements;
      result.missingElements.push(...childResult.missingElements);
      result.extraElements.push(...childResult.extraElements);
      result.attributeDiffs.push(...childResult.attributeDiffs);
      result.textDiffs.push(...childResult.textDiffs);
    }

    actualMap.delete(selector);
  }

  // 예상에 없는 추가 요소
  for (const selector of actualMap.keys()) {
    result.extraElements.push(selector);
  }

  // 성공률 계산
  if (result.totalElements > 0) {
    result.successRate = Math.round((result.matchedElements / result.totalElements) * 10000) / 100;
  } else {
    result.successRate = 100;
  }

  return result;
}

// 이미지 로드 함수 (base64 또는 파일 경로)
async function loadImage(input: string): Promise<PNG> {
  let buffer: Buffer;
  
  if (input.startsWith("data:image/png;base64,")) {
    // data URL 형식
    buffer = Buffer.from(input.replace("data:image/png;base64,", ""), "base64");
  } else if (input.match(/^[A-Za-z0-9+/=]+$/)) {
    // 순수 base64
    buffer = Buffer.from(input, "base64");
  } else {
    // 파일 경로
    const filePath = path.isAbsolute(input) ? input : path.join(PROJECT_ROOT, input);
    buffer = await fs.readFile(filePath);
  }
  
  return new Promise((resolve, reject) => {
    new PNG().parse(buffer, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

// pixelmatch를 사용한 이미지 비교
async function compareImages(
  originalInput: string,
  renderedInput: string,
  threshold: number = 0.1,
  generateDiff: boolean = false
): Promise<CompareResult> {
  const original = await loadImage(originalInput);
  const rendered = await loadImage(renderedInput);
  
  // 이미지 크기가 다른 경우 처리
  if (original.width !== rendered.width || original.height !== rendered.height) {
    // 더 큰 크기로 맞추고 나머지는 빈 공간으로 처리
    const width = Math.max(original.width, rendered.width);
    const height = Math.max(original.height, rendered.height);
    
    const resizeImage = (img: PNG, w: number, h: number): PNG => {
      const resized = new PNG({ width: w, height: h });
      // 투명 배경으로 채움
      for (let i = 0; i < w * h * 4; i += 4) {
        resized.data[i] = 0;
        resized.data[i + 1] = 0;
        resized.data[i + 2] = 0;
        resized.data[i + 3] = 0;
      }
      // 원본 이미지 복사
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const srcIdx = (y * img.width + x) * 4;
          const dstIdx = (y * w + x) * 4;
          resized.data[dstIdx] = img.data[srcIdx];
          resized.data[dstIdx + 1] = img.data[srcIdx + 1];
          resized.data[dstIdx + 2] = img.data[srcIdx + 2];
          resized.data[dstIdx + 3] = img.data[srcIdx + 3];
        }
      }
      return resized;
    };
    
    const resizedOriginal = resizeImage(original, width, height);
    const resizedRendered = resizeImage(rendered, width, height);
    
    const diff = generateDiff ? new PNG({ width, height }) : null;
    const diffPixels = pixelmatch(
      resizedOriginal.data,
      resizedRendered.data,
      diff?.data || null,
      width,
      height,
      { threshold }
    );
    
    const totalPixels = width * height;
    const successRate = Math.round((1 - diffPixels / totalPixels) * 10000) / 100;
    
    let diffImage: string | undefined;
    if (diff) {
      const diffBuffer = PNG.sync.write(diff);
      diffImage = `data:image/png;base64,${diffBuffer.toString("base64")}`;
    }
    
    return {
      successRate,
      totalPixels,
      diffPixels,
      width,
      height,
      diffImage,
    };
  }
  
  const { width, height } = original;
  const diff = generateDiff ? new PNG({ width, height }) : null;
  
  const diffPixels = pixelmatch(
    original.data,
    rendered.data,
    diff?.data || null,
    width,
    height,
    { threshold }
  );
  
  const totalPixels = width * height;
  const successRate = Math.round((1 - diffPixels / totalPixels) * 10000) / 100;
  
  let diffImage: string | undefined;
  if (diff) {
    const diffBuffer = PNG.sync.write(diff);
    diffImage = `data:image/png;base64,${diffBuffer.toString("base64")}`;
  }
  
  return {
    successRate,
    totalPixels,
    diffPixels,
    width,
    height,
    diffImage,
  };
}

// OpenSpec 규칙 파싱 결과 타입
interface OpenSpecRequirement {
  name: string;
  description: string;
  scenarios: Array<{
    name: string;
    given: string;
    when: string;
    then: string;
  }>;
}

interface OpenSpecRule {
  specName: string;
  filePath: string;
  requirements: OpenSpecRequirement[];
}

// OpenSpec 규칙 캐시
let cachedOpenSpecRules: OpenSpecRule[] | null = null;

// AI 설정 확인 함수
async function checkAISetup(): Promise<AISetupStatus> {
  const status: AISetupStatus = {
    cursor: { found: false },
    copilot: { found: false },
  };

  // Cursor rules 확인
  for (const rulePath of AI_SETUP_PATHS.cursor.rules) {
    const fullPath = path.join(PROJECT_ROOT, rulePath);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        // .cursor/rules 폴더인 경우 내부에 .mdc 파일이 있는지 확인
        const files = await glob(path.join(fullPath, "*.mdc"));
        if (files.length > 0) {
          status.cursor = { found: true, path: rulePath, type: "folder" };
          break;
        }
      } else if (stat.isFile()) {
        // .cursorrules 파일인 경우
        status.cursor = { found: true, path: rulePath, type: "file" };
        break;
      }
    } catch {
      // 파일/폴더 없음
    }
  }

  // Copilot instructions 확인
  for (const rulePath of AI_SETUP_PATHS.copilot.rules) {
    const fullPath = path.join(PROJECT_ROOT, rulePath);
    try {
      await fs.access(fullPath);
      status.copilot = { found: true, path: rulePath };
      break;
    } catch {
      // 파일 없음
    }
  }

  return status;
}

// 규칙 파일 상태 타입
interface RulesFileStatus {
  found: boolean;
  files: string[];
  sources: {
    rulesPath: boolean;
    rulesGlob: boolean;
    configPath: boolean;
    openSpec: boolean;
  };
  message: string;
}

// Figma URL 저장/불러오기 함수
async function saveFigmaUrl(url: string): Promise<void> {
  const dir = path.dirname(FIGMA_URL_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(FIGMA_URL_PATH, url, "utf-8");
}

async function loadFigmaUrl(): Promise<string | null> {
  try {
    const url = await fs.readFile(FIGMA_URL_PATH, "utf-8");
    return url.trim() || null;
  } catch {
    return null;
  }
}

// Figma 설정 상태 확인
interface FigmaStatus {
  tokenSet: boolean;
  urlSet: boolean;
  url: string | null;
}

async function checkFigmaSetup(): Promise<FigmaStatus> {
  const url = await loadFigmaUrl();
  return {
    tokenSet: !!FIGMA_TOKEN,
    urlSet: !!url,
    url,
  };
}

// 규칙 파일 존재 여부 확인 함수
async function checkRulesFiles(): Promise<RulesFileStatus> {
  const status: RulesFileStatus = {
    found: false,
    files: [],
    sources: {
      rulesPath: false,
      rulesGlob: false,
      configPath: false,
      openSpec: false,
    },
    message: "",
  };

  // 1. RULES_PATHS에서 확인
  if (RULES_PATHS.length > 0) {
    for (const rulePath of RULES_PATHS) {
      try {
        if (rulePath.includes("*")) {
          const files = await glob(rulePath);
          const mdFiles = files.filter(f => f.endsWith(".md"));
          if (mdFiles.length > 0) {
            status.files.push(...mdFiles);
            status.sources.rulesPath = true;
          }
        } else {
          const fullPath = path.isAbsolute(rulePath) ? rulePath : path.join(PROJECT_ROOT, rulePath);
          await fs.access(fullPath);
          if (fullPath.endsWith(".md")) {
            status.files.push(fullPath);
            status.sources.rulesPath = true;
          }
        }
      } catch {
        // 파일 없음
      }
    }
  }

  // 2. RULES_GLOB에서 확인
  if (RULES_GLOB) {
    const patterns = RULES_GLOB.split(",").map(p => p.trim());
    for (const pattern of patterns) {
      try {
        const files = await glob(pattern);
        const mdFiles = files.filter(f => f.endsWith(".md"));
        if (mdFiles.length > 0) {
          status.files.push(...mdFiles.filter(f => !status.files.includes(f)));
          status.sources.rulesGlob = true;
        }
      } catch {
        // 패턴 매칭 실패
      }
    }
  }

  // 3. CONFIG_PATH에서 확인
  if (CONFIG_PATH) {
    try {
      const configContent = await fs.readFile(CONFIG_PATH, "utf-8");
      const config = JSON.parse(configContent);
      if (config.rules && Array.isArray(config.rules) && config.rules.length > 0) {
        for (const rulePath of config.rules) {
          const fullPath = path.isAbsolute(rulePath) ? rulePath : path.join(PROJECT_ROOT, rulePath);
          try {
            await fs.access(fullPath);
            if (fullPath.endsWith(".md") && !status.files.includes(fullPath)) {
              status.files.push(fullPath);
              status.sources.configPath = true;
            }
          } catch {
            // 파일 없음
          }
        }
      }
    } catch {
      // 설정 파일 없음
    }
  }

  // 4. OpenSpec에서 확인
  for (const searchPath of OPENSPEC_SEARCH_PATHS) {
    const specsDir = path.join(PROJECT_ROOT, searchPath);
    try {
      const specPattern = path.join(specsDir, "*/spec.md");
      const specFiles = await glob(specPattern);
      if (specFiles.length > 0) {
        status.files.push(...specFiles.filter(f => !status.files.includes(f)));
        status.sources.openSpec = true;
      }
    } catch {
      // OpenSpec 없음
    }
  }

  // 결과 집계
  status.found = status.files.length > 0;

  if (!status.found) {
    status.message = `❌ **규칙 파일이 없습니다!**

Phase를 시작하려면 디자인 규칙 파일(.md)이 필요합니다.

## 규칙 파일 설정 방법

### 방법 1: 환경변수 RULES_PATHS 설정
\`\`\`bash
export RULES_PATHS="./rules/design-rules.md,./rules/component-rules.md"
\`\`\`

### 방법 2: 환경변수 RULES_GLOB 설정
\`\`\`bash
export RULES_GLOB="./rules/**/*.md"
\`\`\`

### 방법 3: OpenSpec 규칙 생성
\`\`\`bash
mkdir -p openspec/specs/design-rules
touch openspec/specs/design-rules/spec.md
\`\`\`

### 방법 4: 설정 파일 사용
\`\`\`bash
export D2C_CONFIG_PATH="./d2c-config.json"
\`\`\`
\`\`\`json
// d2c-config.json
{
  "rules": ["./rules/design-rules.md"]
}
\`\`\`

⚠️ **규칙 파일 경로를 알려주세요** 또는 위 방법 중 하나로 설정해주세요.`;
  } else {
    const sourceList = [];
    if (status.sources.rulesPath) sourceList.push("RULES_PATHS");
    if (status.sources.rulesGlob) sourceList.push("RULES_GLOB");
    if (status.sources.configPath) sourceList.push("D2C_CONFIG_PATH");
    if (status.sources.openSpec) sourceList.push("OpenSpec");

    status.message = `✅ **규칙 파일 발견** (${status.files.length}개)

**소스**: ${sourceList.join(", ")}

**파일 목록**:
${status.files.slice(0, 10).map(f => `- \`${path.relative(PROJECT_ROOT, f)}\``).join("\n")}${status.files.length > 10 ? `\n... 외 ${status.files.length - 10}개` : ""}`;
  }

  return status;
}

// OpenSpec spec.md 파싱
async function parseOpenSpecFile(filePath: string): Promise<OpenSpecRule | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const specName = path.basename(path.dirname(filePath));
    
    const requirements: OpenSpecRequirement[] = [];
    
    // Requirement 섹션 파싱
    const reqRegex = /### Requirement: (.+?)\n\n([\s\S]*?)(?=### Requirement:|---|\n## |$)/g;
    let reqMatch;
    
    while ((reqMatch = reqRegex.exec(content)) !== null) {
      const reqName = reqMatch[1].trim();
      const reqContent = reqMatch[2];
      
      // Scenario 파싱
      const scenarios: OpenSpecRequirement["scenarios"] = [];
      const scenarioRegex = /#### Scenario: (.+?)\n\n([\s\S]*?)(?=#### Scenario:|### Requirement:|---|\n## |$)/g;
      let scenarioMatch;
      
      while ((scenarioMatch = scenarioRegex.exec(reqContent)) !== null) {
        const scenarioName = scenarioMatch[1].trim();
        const scenarioContent = scenarioMatch[2];
        
        const givenMatch = scenarioContent.match(/- \*\*GIVEN\*\* (.+)/);
        const whenMatch = scenarioContent.match(/- \*\*WHEN\*\* (.+)/);
        const thenMatch = scenarioContent.match(/- \*\*THEN\*\* (.+)/);
        
        scenarios.push({
          name: scenarioName,
          given: givenMatch?.[1] || "",
          when: whenMatch?.[1] || "",
          then: thenMatch?.[1] || "",
        });
      }
      
      // 설명 추출 (첫 번째 문단)
      const descMatch = reqContent.match(/^(.+?)(?:\n\n|$)/);
      
      requirements.push({
        name: reqName,
        description: descMatch?.[1]?.trim() || "",
        scenarios,
      });
    }
    
    return {
      specName,
      filePath,
      requirements,
    };
  } catch (e) {
    console.error(`Failed to parse OpenSpec file: ${filePath}`, e);
    return null;
  }
}

// OpenSpec 규칙 탐지 및 로드
async function loadOpenSpecRules(forceReload = false): Promise<OpenSpecRule[]> {
  if (cachedOpenSpecRules && !forceReload) {
    return cachedOpenSpecRules;
  }
  
  const rules: OpenSpecRule[] = [];
  
  for (const searchPath of OPENSPEC_SEARCH_PATHS) {
    const fullPattern = path.join(PROJECT_ROOT, searchPath);
    const files = await glob(fullPattern);
    
    for (const file of files) {
      const rule = await parseOpenSpecFile(file);
      if (rule) {
        rules.push(rule);
      }
    }
  }
  
  cachedOpenSpecRules = rules;
  return rules;
}

// Phase별 Tasks 정의 (PHASE_TARGETS 참조)
const PHASE_TASKS = {
  1: {
    name: "Phase 1: Figma MCP 추출",
    target: PHASE_TARGETS.phase1,
    tasks: [
      { id: "1.1", content: "Figma 디자인 컨텍스트 가져오기" },
      { id: "1.2", content: "Figma MCP로 코드 추출" },
      { id: "1.3", content: "Playwright 렌더링" },
      { id: "1.4", content: "스크린샷 비교 (toHaveScreenshot)" },
      { id: "1.5", content: "d2c_phase1_compare 호출" },
      { id: "1.6", content: "HITL 확인" },
    ],
  },
  2: {
    name: "Phase 2: LLM 이미지 Diff",
    target: PHASE_TARGETS.phase2,
    tasks: [
      { id: "2.1", content: "Playwright 이미지 diff 분석" },
      { id: "2.2", content: "diff 영역 식별" },
      { id: "2.3", content: "LLM이 코드 수정" },
      { id: "2.4", content: "렌더링 후 스크린샷 비교" },
      { id: "2.5", content: "d2c_phase2_image_diff 호출" },
      { id: "2.6", content: "HITL 확인" },
    ],
  },
  3: {
    name: "Phase 3: LLM DOM 비교",
    target: PHASE_TARGETS.phase3,
    tasks: [
      { id: "3.1", content: "Playwright DOM 스냅샷 추출" },
      { id: "3.2", content: "DOM 구조 비교" },
      { id: "3.3", content: "LLM이 DOM 기반 수정" },
      { id: "3.4", content: "렌더링 후 DOM 비교" },
      { id: "3.5", content: "d2c_phase3_dom_compare 호출" },
      { id: "3.6", content: "HITL 확인" },
    ],
  },
};

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
    version: "1.3.0",
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
- AI 어시스턴트 설정 (Cursor Rules, Copilot Instructions)

💡 **사용법**: 
1. 이 도구를 먼저 호출
2. 반환된 check_method로 각 MCP 확인
3. 누락된 것이 있으면 install_guide 안내
4. AI 설정이 없으면 추천 설정 제안`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // check_ai_setup - AI 어시스턴트 설정 확인
      {
        name: "d2c_check_ai_setup",
        description: `Cursor Rules와 GitHub Copilot Instructions 설정 여부를 확인합니다.
${SERVICE_IDENTIFIERS}

🔍 **확인 항목**:
- Cursor Rules (.cursor/rules/*.mdc 또는 .cursorrules)
- GitHub Copilot Instructions (.github/copilot-instructions.md)

💡 **기능**:
- 설정이 없으면 D2C 워크플로우에 최적화된 추천 설정 제안
- 추천 설정 내용을 파일로 저장하는 명령어 제공

⚠️ **Phase 시작 전 이 도구로 AI 설정을 확인하세요!**`,
        inputSchema: {
          type: "object",
          properties: {
            showRecommendations: {
              type: "boolean",
              description: "추천 설정 내용 전체 표시 (기본: true)",
            },
          },
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

      // compare_screenshots - pixelmatch 기반 스크린샷 비교
      {
        name: "d2c_compare_screenshots",
        description: `두 스크린샷을 픽셀 단위로 비교하여 객관적인 성공률을 계산합니다.
${SERVICE_IDENTIFIERS}

📊 **pixelmatch 기반 객관적 비교**:
- 원본 이미지와 렌더링 결과를 픽셀 단위로 비교
- 차이 픽셀 수 기반 성공률 자동 계산
- diff 이미지 생성 (옵션)

🔢 **성공률 계산**:
\`성공률 = (1 - diffPixels / totalPixels) * 100\`

💡 **사용법**:
1. \`d2c_capture_figma_baseline\`으로 Figma 스크린샷 캡처
2. 구현체 렌더링 후 스크린샷 획득
3. 이 도구로 두 이미지 비교
4. 반환된 successRate를 Phase 도구에 전달`,
        inputSchema: {
          type: "object",
          properties: {
            originalImage: {
              type: "string",
              description: "원본 이미지 (base64 PNG 또는 파일 경로)",
            },
            renderedImage: {
              type: "string",
              description: "렌더링 결과 이미지 (base64 PNG 또는 파일 경로)",
            },
            threshold: {
              type: "number",
              description: "픽셀 차이 임계값 (0-1, 기본 0.1). 낮을수록 엄격",
            },
            generateDiff: {
              type: "boolean",
              description: "diff 이미지 생성 여부 (기본: false)",
            },
          },
          required: ["originalImage", "renderedImage"],
        },
      },

      // set_figma_url - Figma URL 설정
      {
        name: "d2c_set_figma_url",
        description: `변환할 Figma 디자인 URL을 설정합니다.
${SERVICE_IDENTIFIERS}

📌 **필수**: Phase 시작 전에 반드시 설정해야 합니다.

💡 **사용법**:
1. Figma에서 변환할 프레임/컴포넌트 선택
2. 우클릭 → "Copy link" 또는 주소창에서 URL 복사
3. 이 도구로 URL 설정

설정된 URL은 \`d2c_capture_figma_baseline\`에서 자동으로 사용됩니다.`,
        inputSchema: {
          type: "object",
          properties: {
            figmaUrl: {
              type: "string",
              description: "Figma 디자인 URL (프레임 또는 컴포넌트 링크)",
            },
          },
          required: ["figmaUrl"],
        },
      },

      // capture_figma_baseline - Playwright로 Figma 스크린샷 캡처
      {
        name: "d2c_capture_figma_baseline",
        description: `Playwright로 Figma 페이지 스크린샷을 캡처하여 baseline으로 저장합니다.
${SERVICE_IDENTIFIERS}

📸 **Figma Baseline 캡처**:
- \`d2c_set_figma_url\`로 설정된 URL 사용 (또는 직접 입력)
- \`./d2c-baseline/design.png\`에 저장
- pixel 비교의 baseline으로 사용

💡 **사용법**:
1. \`d2c_set_figma_url\`로 URL 설정 (필수)
2. 이 도구 호출 (URL 자동 사용)
3. \`d2c_run_visual_test\`로 구현체와 비교

⚠️ **필수 조건**:
- \`FIGMA_TOKEN\` 환경변수 설정
- \`d2c_set_figma_url\`로 URL 설정`,
        inputSchema: {
          type: "object",
          properties: {
            figmaUrl: {
              type: "string",
              description: "Figma URL (선택, 미입력 시 저장된 URL 사용)",
            },
            selector: {
              type: "string",
              description: "캡처할 요소 선택자 (기본: 캔버스 영역)",
            },
            waitTime: {
              type: "number",
              description: "페이지 로드 대기 시간 ms (기본: 3000)",
            },
          },
          required: [],
        },
      },

      // run_visual_test - Playwright Test Runner 시각적 비교 (Phase 1, 2)
      {
        name: "d2c_run_visual_test",
        description: `Playwright Test Runner로 시각적 비교 테스트를 실행합니다. (Phase 1, 2용)
${SERVICE_IDENTIFIERS}

📊 **Playwright toHaveScreenshot() 사용**:
- baseline 이미지와 렌더링 결과를 Playwright가 비교
- 픽셀 단위 차이 감지 및 diff 이미지 생성
- 성공률 자동 계산
- **스크린샷 저장**: \`D2C_SCREENSHOT_DIR\` 경로에 자동 저장

💡 **사용법**:
1. \`d2c_capture_figma_baseline\`으로 Figma baseline 캡처
2. 렌더링할 URL 지정 (구현체 URL)
3. 이 도구로 Playwright 테스트 실행
4. 반환된 successRate를 Phase 도구에 전달

⚠️ **필수 조건**: \`npx playwright install\` 실행 필요`,
        inputSchema: {
          type: "object",
          properties: {
            testName: {
              type: "string",
              description: "테스트 이름 (예: 'button-component')",
            },
            targetUrl: {
              type: "string",
              description: "렌더링 결과 URL (예: 'http://localhost:3000')",
            },
            baselineImagePath: {
              type: "string",
              description: "baseline 이미지 파일 경로 (PNG)",
            },
            maxDiffPixels: {
              type: "number",
              description: "허용 최대 차이 픽셀 수 (기본: 100)",
            },
            threshold: {
              type: "number",
              description: "픽셀 차이 임계값 (0-1, 기본: 0.1)",
            },
            phase: {
              type: "number",
              description: "현재 Phase 번호 (1-3, 기본: 1) - 스크린샷 파일명에 사용",
            },
            iteration: {
              type: "number",
              description: "현재 반복 횟수 (기본: 1) - 스크린샷 파일명에 사용",
            },
          },
          required: ["testName", "targetUrl", "baselineImagePath"],
        },
      },

      // run_dom_golden_test - Playwright DOM golden 비교 (Phase 3)
      {
        name: "d2c_run_dom_golden_test",
        description: `Playwright로 DOM golden 비교 테스트를 실행합니다. (Phase 3용)
${SERVICE_IDENTIFIERS}

📊 **DOM 구조 비교**:
- golden DOM 파일과 렌더링 결과의 DOM 구조 비교
- 요소, 속성, 텍스트 일치도 검사
- 성공률 자동 계산

💡 **사용법**:
1. \`d2c_create_dom_golden\`으로 golden DOM 파일 생성
2. 렌더링할 URL 지정
3. 이 도구로 DOM 비교 테스트 실행
4. 반환된 successRate를 Phase 3 도구에 전달

⚠️ **필수 조건**: \`npx playwright install\` 실행 필요`,
        inputSchema: {
          type: "object",
          properties: {
            testName: {
              type: "string",
              description: "테스트 이름 (예: 'button-component-dom')",
            },
            targetUrl: {
              type: "string",
              description: "렌더링 결과 URL (예: 'http://localhost:3000')",
            },
            goldenDomPath: {
              type: "string",
              description: "golden DOM JSON 파일 경로",
            },
            selectors: {
              type: "array",
              items: { type: "string" },
              description: "비교할 CSS 선택자들 (기본: ['body'])",
            },
          },
          required: ["testName", "targetUrl", "goldenDomPath"],
        },
      },

      // create_dom_golden - DOM golden 파일 생성
      {
        name: "d2c_create_dom_golden",
        description: `현재 페이지의 DOM 구조를 golden 파일로 저장합니다.
${SERVICE_IDENTIFIERS}

📊 **DOM golden 파일 생성**:
- 지정된 URL의 DOM 구조를 JSON으로 추출
- Phase 3 DOM 비교의 기준 파일로 사용

💡 **사용법**:
1. Figma 디자인을 렌더링한 "정답" 페이지 URL 지정
2. 이 도구로 DOM golden 파일 생성
3. \`d2c_run_dom_golden_test\`에서 사용`,
        inputSchema: {
          type: "object",
          properties: {
            targetUrl: {
              type: "string",
              description: "golden으로 저장할 페이지 URL",
            },
            outputPath: {
              type: "string",
              description: "출력 JSON 파일 경로 (기본: .d2c-tests/golden-dom.json)",
            },
            selectors: {
              type: "array",
              items: { type: "string" },
              description: "추출할 CSS 선택자들 (기본: ['body'])",
            },
          },
          required: ["targetUrl"],
        },
      },

      // compare_dom - DOM 구조 비교
      {
        name: "d2c_compare_dom",
        description: `두 DOM 구조를 비교하여 객관적인 성공률을 계산합니다.
${SERVICE_IDENTIFIERS}

📊 **DOM 구조 비교** (Phase 3 전용):
- 요소 존재 여부 비교
- 속성 값 비교 (class, style, role, aria-* 등)
- 텍스트 내용 비교
- 누락/추가 요소 감지

🔢 **성공률 계산**:
\`성공률 = (matchedElements / totalElements) * 100\`

💡 **사용법**:
1. playwright-mcp로 원본 페이지의 DOM 스냅샷 획득
2. playwright-mcp로 렌더링 결과의 DOM 스냅샷 획득
3. 이 도구로 두 DOM 구조 비교
4. 픽셀 성공률과 DOM 성공률이 다르면 HITL로 선택

⚠️ **Phase 3에서 pixelmatch와 함께 사용**:
- 픽셀 비교: 시각적 유사도
- DOM 비교: 구조적 유사도
- 두 값이 다르면 사용자가 기준 선택`,
        inputSchema: {
          type: "object",
          properties: {
            expectedDom: {
              type: "array",
              description: "예상 DOM 구조 (DomElementInfo 배열)",
              items: {
                type: "object",
                properties: {
                  tag: { type: "string" },
                  id: { type: "string" },
                  classes: { type: "array", items: { type: "string" } },
                  attributes: { type: "object" },
                  textContent: { type: "string" },
                  children: { type: "array" },
                },
              },
            },
            actualDom: {
              type: "array",
              description: "실제 DOM 구조 (DomElementInfo 배열)",
              items: {
                type: "object",
                properties: {
                  tag: { type: "string" },
                  id: { type: "string" },
                  classes: { type: "array", items: { type: "string" } },
                  attributes: { type: "object" },
                  textContent: { type: "string" },
                  children: { type: "array" },
                },
              },
            },
          },
          required: ["expectedDom", "actualDom"],
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

📊 **Phase 1 - 목표 성공률: ${PHASE_TARGETS.phase1}% (설정 가능)**
- 비교 방법: **Playwright Test Runner** (toHaveScreenshot)
- 수정 주체: Figma MCP (코드 재추출)
- HITL: 매 반복마다 사용자 확인

⚠️ **successRate는 \`d2c_run_visual_test\` 결과를 사용하세요!**
1. \`d2c_capture_figma_baseline\`으로 Figma baseline 캡처 (./d2c-baseline/design.png)
2. \`d2c_run_visual_test(testName, targetUrl, baselineImagePath)\` 호출
3. Playwright가 toHaveScreenshot()으로 비교
4. 반환된 successRate를 이 도구에 전달`,
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
            rulesPath: {
              type: "string",
              description: "규칙 파일 경로 (.md) - RULES_PATHS/RULES_GLOB가 없을 때 직접 지정",
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

📊 **Phase 2 - 목표 성공률: ${PHASE_TARGETS.phase2}% (설정 가능)**
- 비교 방법: **Playwright Test Runner** (toHaveScreenshot + diff 분석)
- 수정 주체: LLM (코드 직접 수정)
- HITL: 매 반복마다 사용자 확인

⚠️ **successRate는 \`d2c_run_visual_test\` 결과를 사용하세요!**
1. \`d2c_run_visual_test(testName, targetUrl, baselineImagePath)\` 호출
2. Playwright가 생성한 diff 이미지에서 차이점 분석
3. LLM이 해당 영역 코드 수정
4. 재렌더링 후 다시 비교`,
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
            rulesPath: {
              type: "string",
              description: "규칙 파일 경로 (.md) - RULES_PATHS/RULES_GLOB가 없을 때 직접 지정",
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

📊 **Phase 3 - 목표 성공률: ${PHASE_TARGETS.phase3}% (설정 가능)**
- 비교 방법: **Playwright Browser API** (DOM golden 비교)
- 수정 주체: LLM (코드 직접 수정)
- HITL: 매 반복마다 사용자 확인

⚠️ **두 가지 성공률을 함께 전달하세요!**
1. \`d2c_run_visual_test\`로 **픽셀 성공률** 획득
2. \`d2c_run_dom_golden_test\`로 **DOM 성공률** 획득
3. 두 값이 다르면 HITL에서 기준 선택
4. LLM이 선택된 기준으로 코드 수정

💡 **DOM golden 파일 생성**: \`d2c_create_dom_golden\` 먼저 실행`,
        inputSchema: {
          type: "object",
          properties: {
            pixelSuccessRate: {
              type: "number",
              description: "픽셀 비교 성공률 (0-100, d2c_compare_screenshots 결과)",
            },
            domSuccessRate: {
              type: "number",
              description: "DOM 비교 성공률 (0-100, d2c_compare_dom 결과)",
            },
            successRate: {
              type: "number",
              description: "레거시: 단일 성공률 (pixelSuccessRate, domSuccessRate 둘 다 없을 때 사용)",
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
            rulesPath: {
              type: "string",
              description: "규칙 파일 경로 (.md) - RULES_PATHS/RULES_GLOB가 없을 때 직접 지정",
            },
          },
          required: ["iteration"],
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

      // ============ OpenSpec 통합 도구들 ============

      // OpenSpec 규칙 로드
      {
        name: "d2c_load_openspec_rules",
        description: `사용자 프로젝트의 OpenSpec 규칙을 자동으로 탐지하고 로드합니다.
${SERVICE_IDENTIFIERS}

📋 **탐지 경로**:
- ./openspec/specs/*/spec.md
- ./.cursor/openspec/specs/*/spec.md
- ./docs/openspec/specs/*/spec.md

🔍 **반환 정보**:
- 발견된 spec 이름 및 경로
- 각 spec의 Requirements 목록
- 각 Requirement의 Scenarios`,
        inputSchema: {
          type: "object",
          properties: {
            forceReload: {
              type: "boolean",
              description: "캐시 무시하고 다시 로드 (기본: false)",
            },
            specNames: {
              type: "array",
              items: { type: "string" },
              description: "특정 spec만 필터링 (예: ['figma-standard', 'design-rules'])",
            },
          },
        },
      },

      // 워크플로우 Tasks 체크리스트
      {
        name: "d2c_get_workflow_tasks",
        description: `현재 Phase에 맞는 tasks.md 형식 체크리스트를 반환합니다.
${SERVICE_IDENTIFIERS}

📋 **체크리스트 포함 내용**:
- Phase 이름 및 목표 성공률
- 세부 Task 목록 (완료 상태 표시)
- 적용될 OpenSpec 규칙 목록`,
        inputSchema: {
          type: "object",
          properties: {
            phase: {
              type: "number",
              enum: [1, 2, 3],
              description: "현재 Phase (1, 2, 3)",
            },
            completedTasks: {
              type: "array",
              items: { type: "string" },
              description: "완료된 task ID 목록 (예: ['1.1', '1.2'])",
            },
            includeRules: {
              type: "boolean",
              description: "적용 규칙 목록 포함 (기본: true)",
            },
          },
          required: ["phase"],
        },
      },

      // OpenSpec 규칙 기반 검증
      {
        name: "d2c_validate_against_spec",
        description: `생성된 코드가 OpenSpec 규칙을 준수하는지 검증합니다.
${SERVICE_IDENTIFIERS}

🔍 **검증 내용**:
- 각 Requirement별 pass/fail/warn 상태
- 위반 시 구체적인 메시지
- 수정 가이드 제공`,
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "검증할 코드",
            },
            specName: {
              type: "string",
              description: "검증에 사용할 spec 이름 (없으면 모든 spec 적용)",
            },
            componentName: {
              type: "string",
              description: "컴포넌트 이름",
            },
          },
          required: ["code"],
        },
      },

      // 세션 상태 조회
      {
        name: "d2c_get_session_state",
        description: `현재 D2C 워크플로우 세션 상태를 조회합니다.
${SERVICE_IDENTIFIERS}

📊 **조회 내용**:
- Phase 실행 이력
- 현재 Phase
- 워크플로우 시작/완료 여부`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // 워크플로우 완료
      {
        name: "d2c_complete_workflow",
        description: `D2C 워크플로우를 명시적으로 완료하고 세션을 종료합니다.
${SERVICE_IDENTIFIERS}

✅ **완료 시 처리**:
- 세션 요약 리포트 생성
- 세션 상태 초기화
- 워크플로우 종료`,
        inputSchema: {
          type: "object",
          properties: {
            finalNotes: {
              type: "string",
              description: "최종 메모 (선택)",
            },
          },
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
        // AI 설정 상태 확인
        const aiSetup = await checkAISetup();
        // 규칙 파일 상태 확인
        const rulesStatus = await checkRulesFiles();
        // Figma 설정 상태 확인
        const figmaStatus = await checkFigmaSetup();
        
        // Baseline 스크린샷 확인
        let baselineExists = false;
        try {
          await fs.access(BASELINE_PATH);
          baselineExists = true;
        } catch {
          baselineExists = false;
        }
        
        const aiSetupStatus = `
## 🤖 AI 어시스턴트 설정

### Cursor Rules
${aiSetup.cursor.found 
  ? `✅ 설정됨: \`${aiSetup.cursor.path}\` (${aiSetup.cursor.type})` 
  : `❌ 미설정
- **권장**: \`.cursor/rules/d2c-workflow.mdc\` 또는 \`.cursorrules\` 생성
- **확인**: \`d2c_check_ai_setup\` 호출하여 추천 설정 확인`}

### GitHub Copilot Instructions
${aiSetup.copilot.found 
  ? `✅ 설정됨: \`${aiSetup.copilot.path}\`` 
  : `❌ 미설정
- **권장**: \`.github/copilot-instructions.md\` 생성
- **확인**: \`d2c_check_ai_setup\` 호출하여 추천 설정 확인`}

${!aiSetup.cursor.found || !aiSetup.copilot.found 
  ? `⚠️ **AI 설정이 없습니다!** \`d2c_check_ai_setup\`을 호출하여 추천 설정을 확인하세요.` 
  : `✅ AI 설정이 완료되어 있습니다.`}
`;

        // 규칙 파일 상태 섹션
        const rulesStatusSection = `
## 📋 디자인 규칙 파일 (필수)

${rulesStatus.message}
`;

        // Figma 상태 섹션
        const figmaStatusSection = `
## 🎨 Figma 설정 (필수)

### FIGMA_TOKEN
${figmaStatus.tokenSet 
  ? `✅ 환경변수 설정됨`
  : `❌ **환경변수 미설정**

MCP 설정에 \`FIGMA_TOKEN\`을 추가하세요:
\`\`\`json
{
  "servers": {
    "d2c": {
      "command": "npx",
      "args": ["syr-d2c-workflow-mcp"],
      "env": {
        "FIGMA_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
\`\`\`

💡 Figma Personal Access Token 발급: https://www.figma.com/developers/api#access-tokens`}

### Figma URL
${figmaStatus.urlSet 
  ? `✅ 설정됨: \`${figmaStatus.url}\``
  : `❌ **미설정** - \`d2c_set_figma_url\`로 설정하세요`}
`;

        // Baseline 상태 섹션
        const baselineStatusSection = `
## 📸 Baseline 스크린샷 ${baselineExists ? "(준비됨)" : "(필수)"}

${baselineExists 
  ? `✅ Baseline 파일 존재: \`${BASELINE_PATH}\``
  : `❌ Baseline 파일 없음`}
`;

        // Phase 시작 가능 여부 (Figma token + URL + 규칙 파일 + baseline 모두 필요)
        const canStartPhase = figmaStatus.tokenSet && figmaStatus.urlSet && rulesStatus.found && baselineExists;

        // Phase 선택 안내
        let phaseSelectionGuide: string;
        if (!figmaStatus.tokenSet) {
          phaseSelectionGuide = `
---

## 🚫 Phase 시작 불가 - FIGMA_TOKEN 필요

**MCP 설정에 \`FIGMA_TOKEN\` 환경변수를 추가하세요.**

1. Figma에서 Personal Access Token 발급
2. MCP 설정 파일에 \`FIGMA_TOKEN\` 추가
3. MCP 서버 재시작
`;
        } else if (!figmaStatus.urlSet) {
          phaseSelectionGuide = `
---

## 🚫 Phase 시작 불가 - Figma URL 필요

**변환할 Figma 디자인 URL을 설정하세요.**

\`\`\`
d2c_set_figma_url({
  figmaUrl: "https://www.figma.com/design/YOUR_FILE_ID/..."
})
\`\`\`

💡 Figma에서 변환할 프레임/컴포넌트 선택 → 우클릭 → "Copy link"
`;
        } else if (!baselineExists) {
          phaseSelectionGuide = `
---

## 🚫 Phase 시작 불가 - Baseline 필요

**Figma URL이 설정되었습니다. Baseline을 캡처하세요.**

\`\`\`
d2c_capture_figma_baseline()
\`\`\`

💡 저장된 Figma URL: \`${figmaStatus.url}\`
`;
        } else if (!rulesStatus.found) {
          phaseSelectionGuide = `
---

## 🚫 Phase 시작 불가 - 규칙 파일 필요

규칙 파일(.md)을 설정해주세요.
`;
        } else {
          // 세션 상태 확인 - Phase 1 이력 없으면 자동 실행 안내
          if (!sessionState.phase1Executed) {
            // 워크플로우 시작 표시
            sessionState.workflowStarted = true;
            
            phaseSelectionGuide = `
---

## 🚀 자동 Phase 1 실행

**첫 워크플로우 진입입니다. Phase 1을 실행하세요.**

### 📋 Phase 1 실행 순서

1. **Figma MCP로 코드 추출**
   \`\`\`
   figma-mcp의 get_code 또는 유사 도구로 코드 추출
   \`\`\`

2. **구현체 렌더링** (로컬 서버 실행)

3. **Pixel 비교 실행**
   \`\`\`
   d2c_run_visual_test({
     testName: "component",
     targetUrl: "http://localhost:3000",
     baselineImagePath: "${BASELINE_PATH}",
     phase: 1,
     iteration: 1
   })
   \`\`\`

4. **Phase 1 결과 확인**
   \`\`\`
   d2c_phase1_compare({
     successRate: [결과값],
     iteration: 1
   })
   \`\`\`

> ⚠️ **이 단계를 완료해야 HITL 루프가 시작됩니다.**
> Phase 1 완료 후 [1][2][3][P][D][B][완료] 옵션이 표시됩니다.

📌 **Figma URL**: \`${figmaStatus.url}\`
`;
          } else {
            phaseSelectionGuide = `
---

## ✋ HITL - Phase를 선택하세요

사전 검사가 완료되었습니다. 시작할 Phase를 선택하세요:

- **[1]** Phase 1: Figma MCP 재추출
    └─ 디자인에서 코드를 처음 추출합니다
- **[2]** Phase 2: LLM 이미지 diff 수정
    └─ 픽셀 차이를 분석하여 LLM이 코드를 수정합니다
- **[3]** Phase 3: LLM DOM 수정
    └─ DOM 구조 차이를 분석하여 LLM이 코드를 수정합니다

📌 **참고 기준** (일반적 달성 수준)
- Phase 1: ${PHASE_TARGETS.phase1}% | Phase 2: ${PHASE_TARGETS.phase2}% | Phase 3: ${PHASE_TARGETS.phase3}%

📌 **Figma URL**: \`${figmaStatus.url}\`
📌 **세션 상태**: Phase 1 ✅ | Phase 2 ${sessionState.phase2Executed ? "✅" : "❌"} | Phase 3 ${sessionState.phase3Executed ? "✅" : "❌"}
`;
          }
        }

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
${figmaStatusSection}
${rulesStatusSection}
${baselineStatusSection}
${aiSetupStatus}

---

## 📊 사전 검사 결과

| 항목 | 상태 |
|------|------|
| FIGMA_TOKEN | ${figmaStatus.tokenSet ? "✅ 설정됨" : "❌ **필수**"} |
| Figma URL | ${figmaStatus.urlSet ? "✅ 설정됨" : "❌ **필수**"} |
| Baseline | ${baselineExists ? "✅ 준비됨" : "❌ 필요"} |
| 규칙 파일 | ${rulesStatus.found ? `✅ ${rulesStatus.files.length}개 발견` : "❌ 필요"} |
| AI 설정 | ${aiSetup.cursor.found && aiSetup.copilot.found ? "✅ 완료" : "⚠️ 선택"} |
${phaseSelectionGuide}`,
            },
          ],
        };
      }

      case "d2c_check_ai_setup": {
        const input = z
          .object({
            showRecommendations: z.boolean().optional().default(true),
          })
          .parse(args);

        const aiSetup = await checkAISetup();
        
        let resultText = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 **AI 어시스턴트 설정 확인**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 현재 상태

### Cursor Rules
`;

        if (aiSetup.cursor.found) {
          resultText += `✅ **설정됨**
- 경로: \`${aiSetup.cursor.path}\`
- 유형: ${aiSetup.cursor.type === "folder" ? "폴더 (.cursor/rules/)" : "파일 (.cursorrules)"}
`;
        } else {
          resultText += `❌ **미설정**
- 확인 경로: ${AI_SETUP_PATHS.cursor.rules.map(p => `\`${p}\``).join(", ")}
`;
        }

        resultText += `
### GitHub Copilot Instructions
`;

        if (aiSetup.copilot.found) {
          resultText += `✅ **설정됨**
- 경로: \`${aiSetup.copilot.path}\`
`;
        } else {
          resultText += `❌ **미설정**
- 확인 경로: \`${AI_SETUP_PATHS.copilot.rules[0]}\`
`;
        }

        // 추천 설정 표시
        if (input.showRecommendations && (!aiSetup.cursor.found || !aiSetup.copilot.found)) {
          resultText += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 📝 추천 설정
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

          if (!aiSetup.cursor.found) {
            resultText += `
### Cursor Rules 추천 설정

**방법 1: .cursor/rules/ 폴더 사용 (권장)**
\`\`\`bash
mkdir -p .cursor/rules
\`\`\`

다음 내용으로 \`.cursor/rules/d2c-workflow.mdc\` 파일 생성:

\`\`\`markdown
${RECOMMENDED_CURSOR_RULES}
\`\`\`

**방법 2: .cursorrules 파일 사용**
프로젝트 루트에 \`.cursorrules\` 파일 생성 (위와 동일한 내용)

---
`;
          }

          if (!aiSetup.copilot.found) {
            resultText += `
### GitHub Copilot Instructions 추천 설정

**설정 방법:**
\`\`\`bash
mkdir -p .github
\`\`\`

다음 내용으로 \`.github/copilot-instructions.md\` 파일 생성:

\`\`\`markdown
${RECOMMENDED_COPILOT_INSTRUCTIONS}
\`\`\`

---
`;
          }

          resultText += `
## 🚀 빠른 설정 명령어

\`\`\`bash
# Cursor Rules 설정
mkdir -p .cursor/rules
cat > .cursor/rules/d2c-workflow.mdc << 'EOF'
${RECOMMENDED_CURSOR_RULES}EOF

# Copilot Instructions 설정
mkdir -p .github
cat > .github/copilot-instructions.md << 'EOF'
${RECOMMENDED_COPILOT_INSTRUCTIONS}EOF
\`\`\`
`;
        }

        // 요약
        const allConfigured = aiSetup.cursor.found && aiSetup.copilot.found;
        resultText += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 요약
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${allConfigured 
  ? `✅ **모든 AI 설정이 완료되어 있습니다!**
D2C 워크플로우를 시작할 준비가 되었습니다.` 
  : `⚠️ **일부 AI 설정이 누락되어 있습니다.**

AI 설정을 추가하면:
- AI가 D2C 워크플로우를 더 정확하게 수행합니다
- Phase별 도구 사용 순서를 자동으로 따릅니다
- 코드 품질 규칙을 일관되게 적용합니다

**다음 단계**: 위의 추천 설정을 프로젝트에 추가하세요.`}
`;

        return {
          content: [
            {
              type: "text",
              text: resultText,
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

      case "d2c_compare_screenshots": {
        const input = z
          .object({
            originalImage: z.string(),
            renderedImage: z.string(),
            threshold: z.number().min(0).max(1).optional().default(0.1),
            generateDiff: z.boolean().optional().default(false),
          })
          .parse(args);

        try {
          const result = await compareImages(
            input.originalImage,
            input.renderedImage,
            input.threshold,
            input.generateDiff
          );

          const successBar = "█".repeat(Math.round(result.successRate / 10)) + 
                            "░".repeat(10 - Math.round(result.successRate / 10));
          
          // Phase 목표 달성 여부 확인
          const phase1Met = result.successRate >= PHASE_TARGETS.phase1;
          const phase2Met = result.successRate >= PHASE_TARGETS.phase2;
          const phase3Met = result.successRate >= PHASE_TARGETS.phase3;

          let responseText = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **스크린샷 비교 결과** (pixelmatch)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 비교 결과

| 항목 | 값 |
|------|-----|
| **성공률** | ${successBar} **${result.successRate.toFixed(2)}%** |
| 이미지 크기 | ${result.width} × ${result.height} |
| 전체 픽셀 | ${result.totalPixels.toLocaleString()} |
| 차이 픽셀 | ${result.diffPixels.toLocaleString()} |
| 임계값 | ${input.threshold} |

## Phase 목표 달성 여부

| Phase | 목표 | 상태 |
|-------|------|------|
| Phase 1 | ${PHASE_TARGETS.phase1}% | ${phase1Met ? "✅ 달성" : "❌ 미달성"} |
| Phase 2 | ${PHASE_TARGETS.phase2}% | ${phase2Met ? "✅ 달성" : "❌ 미달성"} |
| Phase 3 | ${PHASE_TARGETS.phase3}% | ${phase3Met ? "✅ 달성" : "❌ 미달성"} |

## 다음 단계

이 결과를 Phase 도구에 전달하세요:
\`\`\`
d2c_phase1_compare(successRate: ${result.successRate.toFixed(2)}, iteration: N)
\`\`\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

          // diff 이미지가 있으면 추가
          if (result.diffImage) {
            responseText += `\n\n## Diff 이미지\n(빨간색 = 차이 픽셀)\n\n[diff 이미지가 생성되었습니다. ${result.diffPixels.toLocaleString()} 픽셀의 차이가 빨간색으로 표시됩니다.]`;
          }

          return {
            content: [
              {
                type: "text",
                text: responseText,
              },
              // diff 이미지가 있으면 이미지로도 반환
              ...(result.diffImage ? [{
                type: "image" as const,
                data: result.diffImage.replace("data:image/png;base64,", ""),
                mimeType: "image/png" as const,
              }] : []),
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `❌ **스크린샷 비교 실패**

## 오류
${message}

## 가능한 원인
- 이미지 형식이 PNG가 아님
- base64 인코딩이 잘못됨
- 파일 경로가 존재하지 않음

## 해결 방법
1. PNG 형식의 이미지인지 확인
2. base64 인코딩이 올바른지 확인
3. 파일 경로가 존재하는지 확인`,
              },
            ],
            isError: true,
          };
        }
      }

      case "d2c_set_figma_url": {
        const input = z
          .object({
            figmaUrl: z.string(),
          })
          .parse(args);

        // URL 유효성 검사
        if (!input.figmaUrl.includes("figma.com")) {
          return {
            content: [
              {
                type: "text",
                text: `❌ **유효하지 않은 Figma URL**

입력된 URL: \`${input.figmaUrl}\`

Figma URL은 다음 형식이어야 합니다:
- \`https://www.figma.com/design/FILE_ID/...\`
- \`https://www.figma.com/file/FILE_ID/...\``,
              },
            ],
            isError: true,
          };
        }

        // URL 저장
        await saveFigmaUrl(input.figmaUrl);

        return {
          content: [
            {
              type: "text",
              text: `✅ **Figma URL 설정 완료**

## 설정된 URL
\`${input.figmaUrl}\`

## 다음 단계
Baseline 스크린샷을 캡처하세요:
\`\`\`
d2c_capture_figma_baseline()
\`\`\``,
            },
          ],
        };
      }

      case "d2c_capture_figma_baseline": {
        const input = z
          .object({
            figmaUrl: z.string().optional(),
            selector: z.string().optional(),
            waitTime: z.number().optional().default(3000),
          })
          .parse(args);

        // FIGMA_TOKEN 확인
        if (!FIGMA_TOKEN) {
          return {
            content: [
              {
                type: "text",
                text: `❌ **FIGMA_TOKEN이 설정되지 않았습니다**

MCP 설정에 \`FIGMA_TOKEN\` 환경변수를 추가하세요:
\`\`\`json
{
  "env": {
    "FIGMA_TOKEN": "figd_YOUR_TOKEN_HERE"
  }
}
\`\`\`

💡 Figma Personal Access Token 발급:
https://www.figma.com/developers/api#access-tokens`,
              },
            ],
            isError: true,
          };
        }

        // Figma URL 결정 (입력값 또는 저장된 값)
        let figmaUrl = input.figmaUrl;
        if (!figmaUrl) {
          figmaUrl = await loadFigmaUrl() || undefined;
        }

        if (!figmaUrl) {
          return {
            content: [
              {
                type: "text",
                text: `❌ **Figma URL이 설정되지 않았습니다**

먼저 Figma URL을 설정하세요:
\`\`\`
d2c_set_figma_url({
  figmaUrl: "https://www.figma.com/design/YOUR_FILE_ID/..."
})
\`\`\``,
              },
            ],
            isError: true,
          };
        }

        try {
          // baseline 디렉토리 생성
          const baselineDir = path.join(PROJECT_ROOT, "d2c-baseline");
          await fs.mkdir(baselineDir, { recursive: true });

          // Playwright 스크립트 생성
          const captureScript = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: ${VIEWPORT_WIDTH}, height: ${VIEWPORT_HEIGHT} },
    deviceScaleFactor: ${DEVICE_SCALE_FACTOR},
  });
  const page = await context.newPage();
  
  // Figma 페이지로 이동
  await page.goto('${figmaUrl}', { waitUntil: 'networkidle' });
  
  // 추가 대기 (Figma 렌더링 시간)
  await page.waitForTimeout(${input.waitTime});
  
  // 스크린샷 캡처 (scale: 'device'로 실제 해상도 ${VIEWPORT_WIDTH * DEVICE_SCALE_FACTOR}x${VIEWPORT_HEIGHT * DEVICE_SCALE_FACTOR})
  ${input.selector 
    ? `const element = await page.locator('${input.selector}');
  await element.screenshot({ path: '${path.join(baselineDir, "design.png")}', scale: 'device' });`
    : `await page.screenshot({ path: '${path.join(baselineDir, "design.png")}', fullPage: false, scale: 'device' });`
  }
  
  await browser.close();
  console.log('SUCCESS');
})();
`;

          const scriptPath = path.join(PLAYWRIGHT_TEST_DIR, "capture-baseline.js");
          await fs.mkdir(PLAYWRIGHT_TEST_DIR, { recursive: true });
          await fs.writeFile(scriptPath, captureScript);

          // 스크립트 실행
          const execAsync = promisify(exec);
          const { stdout, stderr } = await execAsync(`node "${scriptPath}"`, {
            cwd: PROJECT_ROOT,
            timeout: 60000,
          });

          if (stdout.includes("SUCCESS")) {
            return {
              content: [
                {
                  type: "text",
                  text: `✅ **Figma Baseline 캡처 완료**

## 저장 위치
\`${BASELINE_PATH}\`

## 캡처 정보
| 항목 | 값 |
|------|-----|
| Figma URL | ${figmaUrl} |
| 선택자 | ${input.selector || "(전체 페이지)"} |
| Viewport (CSS) | ${VIEWPORT_WIDTH} x ${VIEWPORT_HEIGHT} |
| Device Scale | ${DEVICE_SCALE_FACTOR}x |
| **실제 해상도** | **${VIEWPORT_WIDTH * DEVICE_SCALE_FACTOR} x ${VIEWPORT_HEIGHT * DEVICE_SCALE_FACTOR}** |
| 대기 시간 | ${input.waitTime}ms |

## 다음 단계
\`d2c_run_visual_test\`로 구현체와 비교하세요:
\`\`\`
d2c_run_visual_test({
  testName: "my-component",
  targetUrl: "http://localhost:3000",
  baselineImagePath: "${BASELINE_PATH}"
})
\`\`\``,
                },
              ],
            };
          } else {
            throw new Error(stderr || "Unknown error during capture");
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: `❌ **Figma Baseline 캡처 실패**

## 오류
${errorMessage}

## 확인사항
1. **Playwright 설치**: \`npx playwright install chromium\` 실행
2. **Figma URL 확인**: URL이 유효한지 확인하세요
3. **Figma 로그인**: 비공개 파일의 경우 브라우저에서 먼저 Figma 로그인 필요
4. **대기 시간 증가**: waitTime을 5000ms 이상으로 설정해보세요

## 다시 시도
\`\`\`
d2c_capture_figma_baseline({
  figmaUrl: "YOUR_FIGMA_URL",
  waitTime: 5000
})
\`\`\``,
              },
            ],
            isError: true,
          };
        }
      }

      case "d2c_run_visual_test": {
        const input = z
          .object({
            testName: z.string(),
            targetUrl: z.string(),
            baselineImagePath: z.string(),
            maxDiffPixels: z.number().optional().default(100),
            threshold: z.number().min(0).max(1).optional().default(0.1),
            phase: z.number().min(1).max(3).optional().default(1),
            iteration: z.number().min(1).optional().default(1),
          })
          .parse(args);

        try {
          // baseline 이미지 존재 확인
          const baselinePath = path.isAbsolute(input.baselineImagePath) 
            ? input.baselineImagePath 
            : path.join(PROJECT_ROOT, input.baselineImagePath);
          
          await fs.access(baselinePath);

          // 테스트 파일 생성 (phase, iteration 전달)
          const testPath = await generateVisualTest(
            input.testName,
            input.targetUrl,
            baselinePath,
            input.maxDiffPixels,
            input.threshold,
            input.phase,
            input.iteration
          );

          // 테스트 실행
          const result = await runPlaywrightTest(testPath);

          const successBar = "█".repeat(Math.round(result.successRate / 10)) + 
                            "░".repeat(10 - Math.round(result.successRate / 10));

          const phase1Met = result.successRate >= PHASE_TARGETS.phase1;
          const phase2Met = result.successRate >= PHASE_TARGETS.phase2;
          
          // 저장된 스크린샷 정보
          const screenshotInfo = `

## 📸 저장된 스크린샷
| 타입 | 경로 |
|------|------|
| Baseline | \`${SCREENSHOT_DIR}/phase${input.phase}-v${input.iteration}-baseline-*.png\` |
| Code | \`${SCREENSHOT_DIR}/phase${input.phase}-v${input.iteration}-code-*.png\` |`;

          return {
            content: [
              {
                type: "text",
                text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Playwright 시각적 비교 결과**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 테스트 결과

| 항목 | 값 |
|------|-----|
| **성공률** | ${successBar} **${result.successRate.toFixed(2)}%** |
| 테스트명 | ${input.testName} |
| 대상 URL | ${input.targetUrl} |
| Phase / Iteration | ${input.phase} / ${input.iteration} |
| 통과/실패 | ${result.passed}/${result.failed} |
| 허용 차이 픽셀 | ${input.maxDiffPixels} |
${result.diffPixels !== undefined ? `| 실제 차이 픽셀 | ${result.diffPixels} |` : ""}
${screenshotInfo}

## Phase 목표 달성 여부

| Phase | 목표 | 상태 |
|-------|------|------|
| Phase 1 | ${PHASE_TARGETS.phase1}% | ${phase1Met ? "✅ 달성" : "❌ 미달성"} |
| Phase 2 | ${PHASE_TARGETS.phase2}% | ${phase2Met ? "✅ 달성" : "❌ 미달성"} |

## 다음 단계

\`\`\`
d2c_phase${input.phase}_compare(successRate: ${result.successRate.toFixed(2)}, iteration: ${input.iteration})
\`\`\`

${result.diffPath ? `\n**Diff 이미지**: \`${result.diffPath}\`` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `❌ **시각적 비교 테스트 실패**

## 오류
${message}

## 가능한 원인
- baseline 이미지 파일이 존재하지 않음
- Playwright가 설치되지 않음 (\`npx playwright install\`)
- 대상 URL에 접근할 수 없음

## 해결 방법
1. baseline 이미지 경로 확인: \`${input.baselineImagePath}\`
2. \`npx playwright install chromium\` 실행
3. 대상 URL 접근 가능 여부 확인`,
              },
            ],
            isError: true,
          };
        }
      }

      case "d2c_run_dom_golden_test": {
        const input = z
          .object({
            testName: z.string(),
            targetUrl: z.string(),
            goldenDomPath: z.string(),
            selectors: z.array(z.string()).optional().default(["body"]),
          })
          .parse(args);

        try {
          // golden DOM 파일 존재 확인
          const goldenPath = path.isAbsolute(input.goldenDomPath) 
            ? input.goldenDomPath 
            : path.join(PROJECT_ROOT, input.goldenDomPath);
          
          await fs.access(goldenPath);

          // 테스트 파일 생성
          const testPath = await generateDomGoldenTest(
            input.testName,
            input.targetUrl,
            goldenPath,
            input.selectors
          );

          // 테스트 실행
          const result = await runPlaywrightTest(testPath);

          const successBar = "█".repeat(Math.round(result.successRate / 10)) + 
                            "░".repeat(10 - Math.round(result.successRate / 10));

          const phase3Met = result.successRate >= PHASE_TARGETS.phase3;

          return {
            content: [
              {
                type: "text",
                text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Playwright DOM Golden 비교 결과**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 테스트 결과

| 항목 | 값 |
|------|-----|
| **DOM 성공률** | ${successBar} **${result.successRate.toFixed(2)}%** |
| 테스트명 | ${input.testName} |
| 대상 URL | ${input.targetUrl} |
| 비교 선택자 | ${input.selectors.join(", ")} |
| 일치/전체 | ${result.passed}/${result.total} |

## Phase 3 목표 달성 여부

| Phase | 목표 | 상태 |
|-------|------|------|
| Phase 3 | ${PHASE_TARGETS.phase3}% | ${phase3Met ? "✅ 달성" : "❌ 미달성"} |

## 다음 단계

\`\`\`
d2c_phase3_dom_compare(domSuccessRate: ${result.successRate.toFixed(2)}, iteration: N)
\`\`\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `❌ **DOM Golden 비교 테스트 실패**

## 오류
${message}

## 가능한 원인
- golden DOM 파일이 존재하지 않음
- Playwright가 설치되지 않음
- 대상 URL에 접근할 수 없음

## 해결 방법
1. \`d2c_create_dom_golden\`으로 golden 파일 먼저 생성
2. \`npx playwright install chromium\` 실행
3. 대상 URL 접근 가능 여부 확인`,
              },
            ],
            isError: true,
          };
        }
      }

      case "d2c_create_dom_golden": {
        const input = z
          .object({
            targetUrl: z.string(),
            outputPath: z.string().optional().default(".d2c-tests/golden-dom.json"),
            selectors: z.array(z.string()).optional().default(["body"]),
          })
          .parse(args);

        try {
          // DOM 추출 테스트 생성 및 실행
          const testDir = PLAYWRIGHT_TEST_DIR;
          await fs.mkdir(testDir, { recursive: true });
          
          const extractScript = `
import { chromium } from 'playwright';

async function extractDom() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('${input.targetUrl}');
  await page.waitForLoadState('networkidle');
  
  const selectors = ${JSON.stringify(input.selectors)};
  const results = [];
  
  for (const selector of selectors) {
    const elements = await page.locator(selector).all();
    
    for (const element of elements) {
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const id = await element.getAttribute('id');
      const className = await element.getAttribute('class');
      const textContent = await element.evaluate(el => el.textContent?.trim().substring(0, 100));
      const childCount = await element.evaluate(el => el.children.length);
      
      results.push({
        selector,
        tagName,
        id,
        className,
        textContent,
        childCount
      });
    }
  }
  
  console.log(JSON.stringify(results, null, 2));
  
  await browser.close();
}

extractDom().catch(console.error);
`;

          const scriptPath = path.join(testDir, "extract-dom.mjs");
          await fs.writeFile(scriptPath, extractScript, "utf-8");

          // 스크립트 실행
          const { stdout } = await execAsync(
            `npx playwright test --config=playwright.config.ts extract-dom.mjs 2>/dev/null || node extract-dom.mjs`,
            { cwd: testDir, timeout: 30000 }
          );

          // JSON 파싱
          const jsonMatch = stdout.match(/\[[\s\S]*\]/);
          if (!jsonMatch) {
            throw new Error("DOM 추출 결과를 파싱할 수 없습니다");
          }

          const domData = JSON.parse(jsonMatch[0]);

          // golden 파일 저장
          const outputPath = path.isAbsolute(input.outputPath) 
            ? input.outputPath 
            : path.join(PROJECT_ROOT, input.outputPath);
          
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, JSON.stringify(domData, null, 2), "utf-8");

          return {
            content: [
              {
                type: "text",
                text: `✅ **DOM Golden 파일 생성 완료**

## 결과

| 항목 | 값 |
|------|-----|
| 대상 URL | ${input.targetUrl} |
| 출력 경로 | \`${input.outputPath}\` |
| 추출 선택자 | ${input.selectors.join(", ")} |
| 추출된 요소 수 | ${domData.length} |

## 추출된 요소 미리보기

\`\`\`json
${JSON.stringify(domData.slice(0, 3), null, 2)}${domData.length > 3 ? "\n... 외 " + (domData.length - 3) + "개" : ""}
\`\`\`

## 다음 단계

\`d2c_run_dom_golden_test\`에서 이 파일을 사용하세요:
\`\`\`
d2c_run_dom_golden_test({
  testName: "my-component",
  targetUrl: "http://localhost:3000",
  goldenDomPath: "${input.outputPath}"
})
\`\`\``,
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `❌ **DOM Golden 파일 생성 실패**

## 오류
${message}

## 가능한 원인
- Playwright가 설치되지 않음
- 대상 URL에 접근할 수 없음
- 네트워크 오류

## 해결 방법
1. \`npx playwright install chromium\` 실행
2. 대상 URL 접근 가능 여부 확인
3. 네트워크 연결 확인`,
              },
            ],
            isError: true,
          };
        }
      }

      case "d2c_compare_dom": {
        // DOM 요소 스키마 (재귀적)
        const domElementSchema: z.ZodType<DomElementInfo> = z.lazy(() =>
          z.object({
            tag: z.string(),
            id: z.string().optional(),
            classes: z.array(z.string()),
            attributes: z.record(z.string()),
            textContent: z.string().optional(),
            children: z.array(domElementSchema),
          })
        ) as z.ZodType<DomElementInfo>;

        // 기본값 처리를 위한 전처리 함수
        const normalizeDomElement = (el: unknown): DomElementInfo => {
          const obj = el as Record<string, unknown>;
          return {
            tag: String(obj.tag || "div"),
            id: obj.id ? String(obj.id) : undefined,
            classes: Array.isArray(obj.classes) ? obj.classes.map(String) : [],
            attributes: (obj.attributes && typeof obj.attributes === "object") 
              ? Object.fromEntries(Object.entries(obj.attributes as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
              : {},
            textContent: obj.textContent ? String(obj.textContent) : undefined,
            children: Array.isArray(obj.children) ? obj.children.map(normalizeDomElement) : [],
          };
        };

        const rawInput = z
          .object({
            expectedDom: z.array(z.unknown()),
            actualDom: z.array(z.unknown()),
          })
          .parse(args);

        const input = {
          expectedDom: rawInput.expectedDom.map(normalizeDomElement),
          actualDom: rawInput.actualDom.map(normalizeDomElement),
        };

        try {
          const result = compareDomStructures(input.expectedDom, input.actualDom);

          const successBar = "█".repeat(Math.round(result.successRate / 10)) + 
                            "░".repeat(10 - Math.round(result.successRate / 10));
          
          // Phase 3 목표 달성 여부 확인
          const phase3Met = result.successRate >= PHASE_TARGETS.phase3;

          // 차이점 요약
          const missingText = result.missingElements.length > 0 
            ? result.missingElements.slice(0, 5).map(s => `- ❌ ${s}`).join("\n")
            : "없음";
          const extraText = result.extraElements.length > 0
            ? result.extraElements.slice(0, 5).map(s => `- ➕ ${s}`).join("\n")
            : "없음";
          const attrDiffText = result.attributeDiffs.length > 0
            ? result.attributeDiffs.slice(0, 5).map(d => 
                `- 🔄 \`${d.selector}\` [${d.attribute}]: "${d.expected}" → "${d.actual}"`
              ).join("\n")
            : "없음";
          const textDiffText = result.textDiffs.length > 0
            ? result.textDiffs.slice(0, 5).map(d =>
                `- 📝 \`${d.selector}\`: "${d.expected}" → "${d.actual}"`
              ).join("\n")
            : "없음";

          const responseText = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **DOM 구조 비교 결과**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 비교 결과

| 항목 | 값 |
|------|-----|
| **DOM 성공률** | ${successBar} **${result.successRate.toFixed(2)}%** |
| 전체 요소 | ${result.totalElements} |
| 일치 요소 | ${result.matchedElements} |
| 누락 요소 | ${result.missingElements.length} |
| 추가 요소 | ${result.extraElements.length} |
| 속성 차이 | ${result.attributeDiffs.length} |
| 텍스트 차이 | ${result.textDiffs.length} |

## Phase 3 목표 달성 여부

| Phase | 목표 | 상태 |
|-------|------|------|
| Phase 3 | ${PHASE_TARGETS.phase3}% | ${phase3Met ? "✅ 달성" : "❌ 미달성"} |

## 상세 차이점

### 누락된 요소 (상위 5개)
${missingText}

### 추가된 요소 (상위 5개)
${extraText}

### 속성 차이 (상위 5개)
${attrDiffText}

### 텍스트 차이 (상위 5개)
${textDiffText}

## ⚠️ Phase 3 사용 시 주의

픽셀 비교(\`d2c_compare_screenshots\`)와 DOM 비교 성공률이 다를 수 있습니다:
- **픽셀 성공률**: 시각적 유사도 (색상, 레이아웃, 크기)
- **DOM 성공률**: 구조적 유사도 (요소, 속성, 텍스트)

두 값이 크게 다르면 **HITL에서 어떤 기준을 사용할지 선택**하세요.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

          return {
            content: [
              {
                type: "text",
                text: responseText,
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `❌ **DOM 비교 실패**

## 오류
${message}

## 가능한 원인
- DOM 구조 형식이 잘못됨
- 필수 필드 누락 (tag, classes 등)

## 해결 방법
1. playwright-mcp에서 올바른 형식으로 DOM 스냅샷 추출
2. DomElementInfo 형식에 맞게 데이터 변환`,
              },
            ],
            isError: true,
          };
        }
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
            targetRate: z.number().optional().default(PHASE_TARGETS.phase1),
            iteration: z.number(),
            maxIterations: z.number().optional().default(5),
            diffDetails: z.string().optional(),
            previousRates: z.array(z.number()).optional(),
            rulesPath: z.string().optional(), // 규칙 파일 경로 (없을 때 전달)
          })
          .parse(args);

        const { successRate, targetRate, iteration, maxIterations, diffDetails, previousRates, rulesPath } = input;

        // 규칙 파일 확인 (첫 번째 반복에서만)
        if (iteration === 1) {
          const rulesStatus = await checkRulesFiles();
          
          // rulesPath가 전달되면 해당 파일 사용
          if (rulesPath) {
            const fullPath = path.isAbsolute(rulesPath) ? rulesPath : path.join(PROJECT_ROOT, rulesPath);
            try {
              await fs.access(fullPath);
              if (!fullPath.endsWith(".md")) {
                return {
                  content: [{
                    type: "text",
                    text: `❌ **규칙 파일은 .md 형식이어야 합니다**

전달된 경로: \`${rulesPath}\`

.md 확장자를 가진 파일 경로를 전달해주세요.`,
                  }],
                  isError: true,
                };
              }
              // 유효한 규칙 파일 - 진행
            } catch {
              return {
                content: [{
                  type: "text",
                  text: `❌ **규칙 파일을 찾을 수 없습니다**

전달된 경로: \`${rulesPath}\`

파일이 존재하는지 확인하고 올바른 경로를 전달해주세요.`,
                }],
                isError: true,
              };
            }
          } else if (!rulesStatus.found) {
            // 규칙 파일 없음 - 경고 및 경로 요청
            return {
              content: [{
                type: "text",
                text: `🚫 **Phase 1 시작 불가 - 규칙 파일 누락**

${rulesStatus.message}

---

## 📌 Phase 시작하려면

규칙 파일(.md) 경로를 \`rulesPath\` 파라미터로 전달해주세요:

\`\`\`
d2c_phase1_compare({
  successRate: ${successRate},
  iteration: 1,
  rulesPath: "./path/to/rules.md"  // ← 규칙 파일 경로 추가
})
\`\`\`

또는 환경변수를 설정해주세요:
- \`RULES_PATHS\`: 규칙 파일 경로들 (쉼표 구분)
- \`RULES_GLOB\`: 규칙 파일 glob 패턴`,
              }],
              isError: true,
            };
          }
        }

        // 세션에 Phase 1 실행 기록
        recordPhaseExecution(1, iteration, successRate);

        // 성공률 변화 계산
        const lastRate = previousRates?.length ? previousRates[previousRates.length - 1] : null;
        const rateDiff = lastRate !== null ? successRate - lastRate : null;

        const diffText = rateDiff !== null ? ` (${rateDiff >= 0 ? "+" : ""}${rateDiff.toFixed(1)}%)` : "";
        const progressBar = "█".repeat(Math.round(successRate / 10)) + "░".repeat(10 - Math.round(successRate / 10));

        // OpenSpec 규칙 로드 (매번 확인)
        const openSpecRules = await loadOpenSpecRules();
        let openSpecSection = "";
        if (openSpecRules.length > 0) {
          const rulesSummary = openSpecRules.map(rule => {
            const keyReqs = rule.requirements.slice(0, 3).map(r => `  - ${r.name}`).join("\n");
            return `### ${rule.specName}\n${keyReqs}${rule.requirements.length > 3 ? `\n  - ... 외 ${rule.requirements.length - 3}개` : ""}`;
          }).join("\n\n");
          openSpecSection = `
## 📋 OpenSpec 규칙 (성공률 향상 가이드)

${rulesSummary}

> 💡 **위 규칙을 참고하여 코드를 수정하면 성공률을 높일 수 있습니다.**
`;
        }

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Phase 1 결과** (Figma MCP 재추출)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 픽셀 비교 결과

| 항목 | 값 |
|------|-----|
| **픽셀 성공률** | ${progressBar} **${successRate.toFixed(1)}%**${diffText} |
| 반복 횟수 | ${iteration}회 |

${diffDetails ? `## 발견된 차이점\n${diffDetails}\n` : ""}
${openSpecSection}
## 📌 참고 기준

| Phase | 일반적 달성 수준 | 수정 방식 |
|-------|-----------------|----------|
| Phase 1 | ${PHASE_TARGETS.phase1}% | Figma MCP 재추출 |
| Phase 2 | ${PHASE_TARGETS.phase2}% | LLM 이미지 diff 수정 |
| Phase 3 | ${PHASE_TARGETS.phase3}% | LLM DOM 수정 |

---

## ✋ HITL - 다음 작업을 선택하세요

**Phase 선택:**
- **[1]** Phase 1: Figma MCP 재추출
- **[2]** Phase 2: LLM 이미지 diff 수정
- **[3]** Phase 3: LLM DOM 수정

**비교 재실행:**
- **[P]** Pixel 비교 재실행
- **[D]** DOM 비교 재실행
- **[B]** Baseline 재캡처 (Figma 스크린샷)

**종료:**
- **[완료]** 워크플로우 종료 → \`d2c_complete_workflow()\` 호출

> ⚠️ **[완료] 선택 전까지 HITL 루프가 계속됩니다.**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_phase2_image_diff": {
        const input = z
          .object({
            successRate: z.number(),
            targetRate: z.number().optional().default(PHASE_TARGETS.phase2),
            iteration: z.number(),
            maxIterations: z.number().optional().default(5),
            diffAreas: z.array(z.object({
              area: z.string(),
              type: z.string(),
              severity: z.enum(["high", "medium", "low"]).optional(),
            })).optional(),
            previousRates: z.array(z.number()).optional(),
            rulesPath: z.string().optional(),
          })
          .parse(args);

        const { successRate, targetRate, iteration, maxIterations, diffAreas, previousRates, rulesPath } = input;

        // 규칙 파일 확인 (첫 번째 반복에서만)
        if (iteration === 1) {
          const rulesStatus = await checkRulesFiles();
          
          if (rulesPath) {
            const fullPath = path.isAbsolute(rulesPath) ? rulesPath : path.join(PROJECT_ROOT, rulesPath);
            try {
              await fs.access(fullPath);
              if (!fullPath.endsWith(".md")) {
                return {
                  content: [{
                    type: "text",
                    text: `❌ **규칙 파일은 .md 형식이어야 합니다**\n\n전달된 경로: \`${rulesPath}\``,
                  }],
                  isError: true,
                };
              }
            } catch {
              return {
                content: [{
                  type: "text",
                  text: `❌ **규칙 파일을 찾을 수 없습니다**\n\n전달된 경로: \`${rulesPath}\``,
                }],
                isError: true,
              };
            }
          } else if (!rulesStatus.found) {
            return {
              content: [{
                type: "text",
                text: `🚫 **Phase 2 시작 불가 - 규칙 파일 누락**\n\n${rulesStatus.message}\n\n---\n\n## 📌 Phase 시작하려면\n\n규칙 파일(.md) 경로를 \`rulesPath\` 파라미터로 전달해주세요.`,
              }],
              isError: true,
            };
          }
        }

        const lastRate = previousRates?.length ? previousRates[previousRates.length - 1] : null;
        const rateDiff = lastRate !== null ? successRate - lastRate : null;

        const diffText = rateDiff !== null ? ` (${rateDiff >= 0 ? "+" : ""}${rateDiff.toFixed(1)}%)` : "";
        const progressBar = "█".repeat(Math.round(successRate / 10)) + "░".repeat(10 - Math.round(successRate / 10));

        // diff 영역 표시
        const diffAreasText = diffAreas?.length ? diffAreas.map(d => {
          const severityIcon = d.severity === "high" ? "🔴" : d.severity === "medium" ? "🟡" : "🟢";
          return `${severityIcon} ${d.area}: ${d.type}`;
        }).join("\n") : "";

        // 세션에 Phase 2 실행 기록
        recordPhaseExecution(2, iteration, successRate);

        // OpenSpec 규칙 로드 (매번 확인)
        const openSpecRules2 = await loadOpenSpecRules();
        let openSpecSection2 = "";
        if (openSpecRules2.length > 0) {
          const rulesSummary = openSpecRules2.map(rule => {
            const keyReqs = rule.requirements.slice(0, 3).map(r => `  - ${r.name}`).join("\n");
            return `### ${rule.specName}\n${keyReqs}${rule.requirements.length > 3 ? `\n  - ... 외 ${rule.requirements.length - 3}개` : ""}`;
          }).join("\n\n");
          openSpecSection2 = `
## 📋 OpenSpec 규칙 (성공률 향상 가이드)

${rulesSummary}

> 💡 **위 규칙을 참고하여 코드를 수정하면 성공률을 높일 수 있습니다.**
`;
        }

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Phase 2 결과** (LLM 이미지 Diff 수정)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 픽셀 비교 결과

| 항목 | 값 |
|------|-----|
| **픽셀 성공률** | ${progressBar} **${successRate.toFixed(1)}%**${diffText} |
| 반복 횟수 | ${iteration}회 |

${diffAreasText ? `## 이미지 Diff 분석\n${diffAreasText}\n` : ""}
${openSpecSection2}
## 📌 참고 기준

| Phase | 일반적 달성 수준 | 수정 방식 |
|-------|-----------------|----------|
| Phase 1 | ${PHASE_TARGETS.phase1}% | Figma MCP 재추출 |
| Phase 2 | ${PHASE_TARGETS.phase2}% | LLM 이미지 diff 수정 |
| Phase 3 | ${PHASE_TARGETS.phase3}% | LLM DOM 수정 |

---

## ✋ HITL - 다음 작업을 선택하세요

**Phase 선택:**
- **[1]** Phase 1: Figma MCP 재추출
- **[2]** Phase 2: LLM 이미지 diff 수정
- **[3]** Phase 3: LLM DOM 수정

**비교 재실행:**
- **[P]** Pixel 비교 재실행
- **[D]** DOM 비교 재실행
- **[B]** Baseline 재캡처 (Figma 스크린샷)

**종료:**
- **[완료]** 워크플로우 종료 → \`d2c_complete_workflow()\` 호출

> ⚠️ **[완료] 선택 전까지 HITL 루프가 계속됩니다.**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_phase3_dom_compare": {
        const input = z
          .object({
            pixelSuccessRate: z.number().optional(),
            domSuccessRate: z.number().optional(),
            successRate: z.number().optional(), // 레거시 호환
            targetRate: z.number().optional().default(PHASE_TARGETS.phase3),
            iteration: z.number(),
            maxIterations: z.number().optional().default(5),
            domDiffs: z.array(z.object({
              selector: z.string(),
              expected: z.string().optional(),
              actual: z.string().optional(),
              type: z.string(),
            })).optional(),
            previousRates: z.array(z.number()).optional(),
            rulesPath: z.string().optional(),
          })
          .parse(args);

        const { targetRate, iteration, maxIterations, domDiffs, previousRates, rulesPath } = input;

        // 규칙 파일 확인 (첫 번째 반복에서만)
        if (iteration === 1) {
          const rulesStatus = await checkRulesFiles();
          
          if (rulesPath) {
            const fullPath = path.isAbsolute(rulesPath) ? rulesPath : path.join(PROJECT_ROOT, rulesPath);
            try {
              await fs.access(fullPath);
              if (!fullPath.endsWith(".md")) {
                return {
                  content: [{
                    type: "text",
                    text: `❌ **규칙 파일은 .md 형식이어야 합니다**\n\n전달된 경로: \`${rulesPath}\``,
                  }],
                  isError: true,
                };
              }
            } catch {
              return {
                content: [{
                  type: "text",
                  text: `❌ **규칙 파일을 찾을 수 없습니다**\n\n전달된 경로: \`${rulesPath}\``,
                }],
                isError: true,
              };
            }
          } else if (!rulesStatus.found) {
            return {
              content: [{
                type: "text",
                text: `🚫 **Phase 3 시작 불가 - 규칙 파일 누락**\n\n${rulesStatus.message}\n\n---\n\n## 📌 Phase 시작하려면\n\n규칙 파일(.md) 경로를 \`rulesPath\` 파라미터로 전달해주세요.`,
              }],
              isError: true,
            };
          }
        }
        
        // 성공률 결정 (픽셀, DOM, 레거시 순으로 확인)
        const pixelRate = input.pixelSuccessRate;
        const domRate = input.domSuccessRate;
        const legacyRate = input.successRate;
        
        // 두 성공률이 모두 있는 경우
        const hasBothRates = pixelRate !== undefined && domRate !== undefined;
        
        // DOM diff 표시
        const domDiffsText = domDiffs?.length ? domDiffs.slice(0, 5).map(d => {
          const typeIcon = d.type === "missing" ? "❌" : d.type === "extra" ? "➕" : "🔄";
          return `${typeIcon} ${d.selector}: ${d.type}${d.expected ? ` (예상: ${d.expected})` : ""}`;
        }).join("\n") : "";

        // 성공률 표시 생성
        let ratesSection: string;
        if (hasBothRates) {
          const domBar = "█".repeat(Math.round(domRate / 10)) + "░".repeat(10 - Math.round(domRate / 10));
          const pixelBar = "█".repeat(Math.round(pixelRate / 10)) + "░".repeat(10 - Math.round(pixelRate / 10));
          ratesSection = `## 비교 결과

| 항목 | 값 |
|------|-----|
| **DOM 성공률** | ${domBar} **${domRate.toFixed(1)}%** |
| **픽셀 성공률** | ${pixelBar} **${pixelRate.toFixed(1)}%** |
| 반복 횟수 | ${iteration}회 |`;
        } else {
          const effectiveRate = pixelRate ?? domRate ?? legacyRate ?? 0;
          const progressBar = "█".repeat(Math.round(effectiveRate / 10)) + "░".repeat(10 - Math.round(effectiveRate / 10));
          ratesSection = `## 비교 결과

| 항목 | 값 |
|------|-----|
| **성공률** | ${progressBar} **${effectiveRate.toFixed(1)}%** |
| 반복 횟수 | ${iteration}회 |`;
        }

        // 세션에 Phase 3 실행 기록 (DOM 또는 Pixel 중 주요 성공률 사용)
        const phase3SuccessRate = domRate ?? pixelRate ?? legacyRate ?? 0;
        recordPhaseExecution(3, iteration, phase3SuccessRate);

        // OpenSpec 규칙 로드 (매번 확인)
        const openSpecRules3 = await loadOpenSpecRules();
        let openSpecSection3 = "";
        if (openSpecRules3.length > 0) {
          const rulesSummary = openSpecRules3.map(rule => {
            const keyReqs = rule.requirements.slice(0, 3).map(r => `  - ${r.name}`).join("\n");
            return `### ${rule.specName}\n${keyReqs}${rule.requirements.length > 3 ? `\n  - ... 외 ${rule.requirements.length - 3}개` : ""}`;
          }).join("\n\n");
          openSpecSection3 = `
## 📋 OpenSpec 규칙 (성공률 향상 가이드)

${rulesSummary}

> 💡 **위 규칙을 참고하여 코드를 수정하면 성공률을 높일 수 있습니다.**
`;
        }

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Phase 3 결과** (LLM DOM 수정)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${ratesSection}

${domDiffsText ? `## DOM 차이점 (상위 5개)\n${domDiffsText}\n` : ""}
${openSpecSection3}
## 📌 참고 기준

| Phase | 일반적 달성 수준 | 수정 방식 |
|-------|-----------------|----------|
| Phase 1 | ${PHASE_TARGETS.phase1}% | Figma MCP 재추출 |
| Phase 2 | ${PHASE_TARGETS.phase2}% | LLM 이미지 diff 수정 |
| Phase 3 | ${PHASE_TARGETS.phase3}% | LLM DOM 수정 |

---

## ✋ HITL - 다음 작업을 선택하세요

**Phase 선택:**
- **[1]** Phase 1: Figma MCP 재추출
- **[2]** Phase 2: LLM 이미지 diff 수정
- **[3]** Phase 3: LLM DOM 수정

**비교 재실행:**
- **[P]** Pixel 비교 재실행
- **[D]** DOM 비교 재실행
- **[B]** Baseline 재캡처 (Figma 스크린샷)

**종료:**
- **[완료]** 워크플로우 종료 → \`d2c_complete_workflow()\` 호출

> ⚠️ **[완료] 선택 전까지 HITL 루프가 계속됩니다.**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_get_session_state": {
        const historyText = sessionState.phaseHistory.length > 0
          ? sessionState.phaseHistory.map((record, index) => {
              const time = record.timestamp.toLocaleTimeString("ko-KR");
              return `| ${index + 1} | Phase ${record.phase} | v${record.iteration} | ${record.successRate.toFixed(1)}% | ${time} |`;
            }).join("\n")
          : "| - | - | - | - | - |";

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **D2C 세션 상태**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 현재 상태

| 항목 | 상태 |
|------|------|
| 워크플로우 시작 | ${sessionState.workflowStarted ? "✅ 시작됨" : "❌ 미시작"} |
| 현재 Phase | ${sessionState.currentPhase ?? "-"} |
| Phase 1 실행 | ${sessionState.phase1Executed ? "✅" : "❌"} |
| Phase 2 실행 | ${sessionState.phase2Executed ? "✅" : "❌"} |
| Phase 3 실행 | ${sessionState.phase3Executed ? "✅" : "❌"} |

## 실행 이력

| # | Phase | Iteration | 성공률 | 시간 |
|---|-------|-----------|--------|------|
${historyText}

## 다음 단계

${!sessionState.phase1Executed 
  ? `⚠️ **Phase 1이 실행되지 않았습니다.**
첫 워크플로우 시작 시 Phase 1 실행이 권장됩니다.`
  : `✅ Phase 1 완료. HITL 옵션에서 다음 작업을 선택하세요.`}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            },
          ],
        };
      }

      case "d2c_complete_workflow": {
        const input = z
          .object({
            finalNotes: z.string().optional(),
          })
          .parse(args);

        const summary = generateSessionSummary();
        const finalNotesSection = input.finalNotes ? `\n## 📝 최종 메모\n${input.finalNotes}\n` : "";

        // 세션 상태 초기화
        resetSessionState();

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ **D2C 워크플로우 완료**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${summary}
${finalNotesSection}
## 🔄 세션 초기화 완료

새로운 D2C 워크플로우를 시작하려면 \`syr\` 또는 관련 키워드로 다시 시작하세요.
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

      // ============ OpenSpec 통합 핸들러 ============

      case "d2c_load_openspec_rules": {
        const input = z
          .object({
            forceReload: z.boolean().optional().default(false),
            specNames: z.array(z.string()).optional(),
          })
          .parse(args);

        const rules = await loadOpenSpecRules(input.forceReload);
        
        let filteredRules = rules;
        if (input.specNames?.length) {
          filteredRules = rules.filter(r => input.specNames!.includes(r.specName));
        }

        if (filteredRules.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `📋 **OpenSpec 규칙 로드 결과**

## 발견된 규칙
없음

## 탐지 경로
${OPENSPEC_SEARCH_PATHS.map(p => `- ${path.join(PROJECT_ROOT, p)}`).join("\n")}

## 대안
- 환경변수 RULES_PATHS로 규칙 파일 지정
- \`d2c_get_design_rules\`로 기본 규칙 사용

💡 프로젝트에 OpenSpec 규칙을 추가하려면:
\`\`\`
mkdir -p openspec/specs/figma-standard
touch openspec/specs/figma-standard/spec.md
\`\`\``,
              },
            ],
          };
        }

        const rulesText = filteredRules.map(rule => {
          const reqList = rule.requirements.map(req => {
            const scenarioCount = req.scenarios.length;
            return `    - ${req.name} (${scenarioCount}개 시나리오)`;
          }).join("\n");
          
          return `### ${rule.specName}
- 경로: \`${rule.filePath}\`
- Requirements (${rule.requirements.length}개):
${reqList}`;
        }).join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `📋 **OpenSpec 규칙 로드 결과**

## 발견된 규칙 (${filteredRules.length}개)

${rulesText}

## 사용법
1. \`d2c_get_workflow_tasks\`로 체크리스트에서 규칙 확인
2. \`d2c_validate_against_spec\`로 코드 검증
3. 각 Phase에서 규칙 준수 여부 자동 확인`,
            },
          ],
        };
      }

      case "d2c_get_workflow_tasks": {
        const input = z
          .object({
            phase: z.number(),
            completedTasks: z.array(z.string()).optional().default([]),
            includeRules: z.boolean().optional().default(true),
          })
          .parse(args);

        const phaseInfo = PHASE_TASKS[input.phase as 1 | 2 | 3];
        if (!phaseInfo) {
          throw new Error(`Invalid phase: ${input.phase}. Must be 1, 2, or 3.`);
        }

        // 체크리스트 생성
        const taskList = phaseInfo.tasks.map(task => {
          const isCompleted = input.completedTasks.includes(task.id);
          return `- [${isCompleted ? "x" : " "}] ${task.id} ${task.content}`;
        }).join("\n");

        // 완료율 계산
        const completedCount = phaseInfo.tasks.filter(t => input.completedTasks.includes(t.id)).length;
        const totalCount = phaseInfo.tasks.length;
        const progressPercent = Math.round((completedCount / totalCount) * 100);

        // OpenSpec 규칙 섹션
        let rulesSection = "";
        if (input.includeRules) {
          const rules = await loadOpenSpecRules();
          if (rules.length > 0) {
            const rulesList = rules.map(rule => {
              const keyReqs = rule.requirements.slice(0, 3).map(r => r.name).join(", ");
              return `- **${rule.specName}**: ${keyReqs}${rule.requirements.length > 3 ? " 외 " + (rule.requirements.length - 3) + "개" : ""}`;
            }).join("\n");
            
            rulesSection = `\n### 적용 규칙\n${rulesList}\n`;
          } else {
            rulesSection = `\n### 적용 규칙\n- (없음) 기본 규칙 사용\n`;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `## ${phaseInfo.name} (목표 ${phaseInfo.target}%)

### 진행률: ${progressPercent}% (${completedCount}/${totalCount})
${"█".repeat(Math.round(progressPercent / 10))}${"░".repeat(10 - Math.round(progressPercent / 10))}

### Tasks
${taskList}
${rulesSection}
### 다음 단계
${completedCount === totalCount 
  ? `✅ Phase ${input.phase} 완료! ${input.phase < 3 ? `Phase ${input.phase + 1}로 진행하세요.` : "워크플로우 완료!"}`
  : `➡️ ${phaseInfo.tasks.find(t => !input.completedTasks.includes(t.id))?.id} ${phaseInfo.tasks.find(t => !input.completedTasks.includes(t.id))?.content} 진행`
}`,
            },
          ],
        };
      }

      case "d2c_validate_against_spec": {
        const input = z
          .object({
            code: z.string(),
            specName: z.string().optional(),
            componentName: z.string().optional(),
          })
          .parse(args);

        const rules = await loadOpenSpecRules();
        
        let targetRules = rules;
        if (input.specName) {
          targetRules = rules.filter(r => r.specName === input.specName);
        }

        interface ValidationResult {
          specName: string;
          requirement: string;
          status: "pass" | "fail" | "warn";
          message: string;
        }

        const results: ValidationResult[] = [];

        // 기본 검증 규칙 (항상 적용)
        const code = input.code;
        const componentName = input.componentName || "Component";

        // 1. PascalCase 컴포넌트 네이밍
        if (componentName && /^[A-Z][a-zA-Z0-9]*$/.test(componentName)) {
          results.push({
            specName: "default",
            requirement: "컴포넌트 네이밍 규칙",
            status: "pass",
            message: `${componentName}은(는) PascalCase 준수`,
          });
        } else if (componentName) {
          results.push({
            specName: "default",
            requirement: "컴포넌트 네이밍 규칙",
            status: "fail",
            message: `${componentName}은(는) PascalCase가 아님. 권장: ${componentName.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("")}`,
          });
        }

        // 2. Props 인터페이스
        if (code.includes("interface") && code.includes("Props")) {
          results.push({
            specName: "default",
            requirement: "Props 인터페이스 정의",
            status: "pass",
            message: "TypeScript Props 인터페이스 정의됨",
          });
        } else if (code.includes(": {") || code.includes("Props")) {
          results.push({
            specName: "default",
            requirement: "Props 인터페이스 정의",
            status: "warn",
            message: "Props 타입이 있으나 명시적 인터페이스 권장",
          });
        } else {
          results.push({
            specName: "default",
            requirement: "Props 인터페이스 정의",
            status: "fail",
            message: "Props 인터페이스가 없음. interface ComponentProps {} 추가 권장",
          });
        }

        // 3. 접근성
        const a11yPatterns = ["aria-", "role=", "tabIndex", "alt="];
        const hasA11y = a11yPatterns.some(p => code.includes(p));
        results.push({
          specName: "default",
          requirement: "접근성 속성",
          status: hasA11y ? "pass" : "warn",
          message: hasA11y ? "접근성 속성 포함됨" : "aria-*, role 속성 추가 권장",
        });

        // OpenSpec 규칙 기반 검증
        for (const rule of targetRules) {
          for (const req of rule.requirements) {
            // 키워드 기반 간단한 검증
            const keywords = req.name.toLowerCase().split(/\s+/);
            
            let matched = false;
            let status: "pass" | "warn" = "warn";
            
            // 네이밍 관련
            if (keywords.some(k => ["naming", "네이밍", "이름"].includes(k))) {
              if (/^[A-Z][a-zA-Z0-9]*$/.test(componentName || "")) {
                matched = true;
                status = "pass";
              }
            }
            
            // Props 관련
            if (keywords.some(k => ["props", "인터페이스", "interface"].includes(k))) {
              if (code.includes("interface") && code.includes("Props")) {
                matched = true;
                status = "pass";
              }
            }
            
            // 접근성 관련
            if (keywords.some(k => ["접근성", "a11y", "accessibility", "aria"].includes(k))) {
              if (hasA11y) {
                matched = true;
                status = "pass";
              }
            }

            if (!matched) {
              results.push({
                specName: rule.specName,
                requirement: req.name,
                status: "warn",
                message: `검증 필요: ${req.description || req.name}`,
              });
            } else {
              results.push({
                specName: rule.specName,
                requirement: req.name,
                status,
                message: status === "pass" ? "규칙 준수" : "검토 필요",
              });
            }
          }
        }

        // 결과 집계
        const passCount = results.filter(r => r.status === "pass").length;
        const failCount = results.filter(r => r.status === "fail").length;
        const warnCount = results.filter(r => r.status === "warn").length;
        const totalCount = results.length;
        const passRate = Math.round((passCount / totalCount) * 100);

        const statusIcon = (s: string) => s === "pass" ? "✅" : s === "fail" ? "❌" : "⚠️";
        
        const resultText = results.map(r => 
          `${statusIcon(r.status)} **${r.requirement}** (${r.specName})\n   ${r.message}`
        ).join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **OpenSpec 규칙 검증 결과**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 요약
- 통과: ${passCount}개 ✅
- 실패: ${failCount}개 ❌
- 경고: ${warnCount}개 ⚠️
- **준수율: ${passRate}%**

${"█".repeat(Math.round(passRate / 10))}${"░".repeat(10 - Math.round(passRate / 10))} ${passRate}%

## 상세 결과

${resultText}

${failCount > 0 ? `\n## 수정 필요 항목\n${results.filter(r => r.status === "fail").map(r => `- ${r.requirement}: ${r.message}`).join("\n")}` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
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

---

## ⚠️ 핵심 규칙 (반드시 준수)

### 🚀 첫 진입 시 자동 Phase 1 실행
**세션에서 Phase 1을 실행한 적이 없으면, 반드시 Phase 1을 먼저 실행하세요.**
- 사전검사 → Figma URL 설정 → Baseline 캡처 → **Phase 1 실행** → Pixel 비교
- 이 단계를 완료해야 HITL 루프가 시작됩니다.

### 🔄 HITL 루프 강제
**[완료]를 선택할 때까지 HITL이 계속됩니다.**
- Phase 완료 후 반드시 [1][2][3][P][D][B][완료] 중 하나를 선택하세요.
- [완료] 선택 전까지는 워크플로우가 종료되지 않습니다.

---

### 📋 첫 사이클 완성 가이드 (프로토타입)

\`\`\`
1️⃣ d2c_preflight_check()
   → FIGMA_TOKEN, URL, Baseline, 규칙 확인
   
2️⃣ d2c_set_figma_url({ figmaUrl: "..." })
   → Figma 디자인 URL 설정
   
3️⃣ d2c_capture_figma_baseline()
   → Figma 스크린샷 캡처 (720x1600)
   
4️⃣ Figma MCP로 코드 추출
   → figma-mcp 도구로 디자인 → 코드 변환
   
5️⃣ 로컬 서버에서 구현체 렌더링
   → http://localhost:3000 등에서 확인
   
6️⃣ d2c_run_visual_test({
     testName: "component",
     targetUrl: "http://localhost:3000",
     baselineImagePath: "./d2c-baseline/design.png",
     phase: 1,
     iteration: 1
   })
   → Pixel 비교 실행
   
7️⃣ d2c_phase1_compare({
     successRate: [결과값],
     iteration: 1
   })
   → Phase 1 결과 확인 + HITL 표시
   
8️⃣ HITL: [1][2][3][P][D][B][완료] 선택
   → [완료] 선택 시 → d2c_complete_workflow() 호출
\`\`\`

---

### 📊 Phase 시스템

| Phase | 수정 방식 | 참고 기준 |
|-------|----------|----------|
| **1** | Figma MCP 재추출 | ${PHASE_TARGETS.phase1}% |
| **2** | LLM 이미지 diff 수정 | ${PHASE_TARGETS.phase2}% |
| **3** | LLM DOM 수정 | ${PHASE_TARGETS.phase3}% |

> 📌 참고 기준은 일반적 달성 수준이며, **모든 판단은 사용자가 합니다.**

---

### 🔄 Phase별 실행 방법

#### Phase 1 (Figma MCP 재추출)
1. Figma MCP로 코드 추출/수정
2. \`d2c_run_visual_test\`로 Pixel 비교
3. \`d2c_phase1_compare\` 호출 → HITL

#### Phase 2 (LLM 이미지 diff 수정)
1. diff 이미지의 빨간색 영역 분석
2. LLM이 코드 수정
3. \`d2c_run_visual_test\`로 Pixel 비교
4. \`d2c_phase2_image_diff\` 호출 → HITL

#### Phase 3 (LLM DOM 수정)
1. \`d2c_run_dom_golden_test\`로 DOM 비교
2. DOM 차이 기반 LLM 코드 수정
3. \`d2c_run_visual_test\`로 Pixel 비교
4. \`d2c_phase3_dom_compare\` 호출 → HITL

---

### ✋ HITL 옵션 설명

| 옵션 | 설명 |
|------|------|
| **[1]** | Phase 1 실행 (Figma MCP 재추출) |
| **[2]** | Phase 2 실행 (LLM 이미지 diff 수정) |
| **[3]** | Phase 3 실행 (LLM DOM 수정) |
| **[P]** | Pixel 비교 재실행 |
| **[D]** | DOM 비교 재실행 |
| **[B]** | Baseline 재캡처 |
| **[완료]** | 워크플로우 종료 → \`d2c_complete_workflow()\` |

---

### 📋 도구 요약
| 도구 | 용도 |
|------|------|
| \`d2c_preflight_check\` | 사전 검사 + 첫 진입 시 Phase 1 안내 |
| \`d2c_get_session_state\` | 현재 세션 상태 조회 |
| \`d2c_run_visual_test\` | Pixel 비교 |
| \`d2c_run_dom_golden_test\` | DOM 비교 (Phase 3) |
| \`d2c_phase1_compare\` | Phase 1 결과 + HITL |
| \`d2c_phase2_image_diff\` | Phase 2 결과 + HITL |
| \`d2c_phase3_dom_compare\` | Phase 3 결과 + HITL |
| \`d2c_complete_workflow\` | 워크플로우 완료 + 세션 초기화 |`,
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
  console.error("SYR D2C Workflow MCP server running on stdio (v1.3.0)");
  console.error(`  Rules paths: ${RULES_PATHS.join(", ") || "(none)"}`);
  console.error(`  Rules glob: ${RULES_GLOB || "(none)"}`);
  console.error(`  OpenSpec paths: ${OPENSPEC_SEARCH_PATHS.map(p => path.join(PROJECT_ROOT, p)).join(", ")}`);
  console.error(`  Phase targets: Phase1=${PHASE_TARGETS.phase1}%, Phase2=${PHASE_TARGETS.phase2}%, Phase3=${PHASE_TARGETS.phase3}%`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
