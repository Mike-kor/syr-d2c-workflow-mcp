# Change: 3단계 검증 워크플로우 개선

## Why

현재 워크플로우는 AI가 주관적으로 점수를 부여하여 비교하는 방식으로, 객관적인 성공률 측정이 불가능합니다.
Playwright의 visual comparison API와 DOM 비교를 활용하여 객관적이고 단계적인 품질 검증 시스템이 필요합니다.

## What Changes

- **ADDED** Phase 1: Figma MCP 기반 스크린샷 비교 (목표 60%)
- **ADDED** Phase 2: LLM 기반 이미지 Diff 수정 (목표 70%)
- **ADDED** Phase 3: LLM 기반 DOM 비교 수정 (목표 90%)
- **MODIFIED** 기존 `d2c_compare_with_design` → 3단계 phase 시스템으로 대체
- **ADDED** 각 phase별 HITL(Human-in-the-Loop) 확인 기능
- **ADDED** 실시간 성공률 표시 기능

## Impact

- Affected specs: `d2c-workflow` (신규 생성)
- Affected code: `src/index.ts`
  - 새 도구 추가: `d2c_phase1_screenshot`, `d2c_phase2_image_diff`, `d2c_phase3_dom_compare`
  - 기존 도구 수정: `d2c_compare_with_design` 개선 또는 deprecated
  - 프롬프트 업데이트: `design_to_code` 워크플로우 변경

## Dependencies

- Playwright visual comparison API (`toHaveScreenshot()`)
- Playwright DOM snapshot 기능
- figma-developer-mcp
- @anthropic/mcp-playwright

## Success Criteria

1. 각 Phase별 목표 성공률 달성 여부를 객관적으로 측정 가능
2. 모든 Phase에서 HITL로 사용자 개입 가능
3. 실시간으로 현재 성공률 표시
4. Phase 간 순차적 진행 보장
