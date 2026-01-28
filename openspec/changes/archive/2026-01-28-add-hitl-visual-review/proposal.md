# Change: HITL 육안 비교 및 스크린샷 이력 저장 기능 추가

## Why

현재 Phase 완료 후 HITL 옵션에서 사용자가 다음 Phase로 진행할지 선택할 수 있지만, **pixel 비교 결과를 육안으로 직접 확인**할 수 있는 방법이 없습니다. 
또한 각 Phase에서 수행한 비교의 **스크린샷 이력 저장**이 제대로 작동하지 않아, 비교 과정을 추적하기 어렵습니다.

### 현재 문제점
1. **HITL에서 육안 비교 불가**: Phase 완료 시 성공률 수치만 표시되고, 실제 diff 이미지를 직접 확인할 방법이 없음
2. **스크린샷 이력 저장 실패**: `generateVisualTest`에서 생성한 테스트 코드가 스크린샷을 저장하도록 되어 있으나, 실제로 저장되지 않음
3. **비교 결과 추적 불가**: baseline, code, diff 3벌의 이미지를 이력으로 남기지 못함

## What Changes

- **ADDED** HITL 옵션에 "[V] 육안 비교" 옵션 추가
- **ADDED** `d2c_open_visual_review` 도구 - Playwright HTML report를 열어 육안 비교
- **ADDED** 스크린샷 이력 저장 로직 수정 - Phase/iteration별 3벌 저장 보장
- **MODIFIED** `d2c_run_visual_test` - diff 이미지를 `D2C_SCREENSHOT_DIR`에 복사
- **MODIFIED** Phase 도구들 (`d2c_phase1_compare`, `d2c_phase2_image_diff`, `d2c_phase3_dom_compare`) - HITL 옵션에 "[V] 육안 비교" 추가

## Impact

- Affected specs: `d2c-workflow`
- Affected code: `src/index.ts`
  - 새 도구 추가: `d2c_open_visual_review`
  - 기존 도구 수정: `d2c_run_visual_test`, Phase 도구들
  - 스크린샷 저장 로직 수정: `generateVisualTest`, `runPlaywrightTest`

## Dependencies

- Playwright Test Runner (HTML reporter)
- `@playwright/test` - `toHaveScreenshot()` diff 이미지 생성

## Success Criteria

1. HITL에서 "[V]" 선택 시 Playwright HTML report가 열림
2. 각 visual test 실행 시 `D2C_SCREENSHOT_DIR`에 3벌 저장됨:
   - `phase{N}-v{M}-baseline-{timestamp}.png`
   - `phase{N}-v{M}-code-{timestamp}.png`
   - `phase{N}-v{M}-diff-{timestamp}.png`
3. 저장된 스크린샷 경로가 결과에 표시됨
