## ADDED Requirements

### Requirement: HITL 육안 비교 기능
시스템은 Phase 완료 후 HITL에서 pixel 비교 결과를 육안으로 확인할 수 있는 옵션을 제공해야 합니다(SHALL).
시스템은 Playwright HTML reporter를 통해 baseline, actual, diff 이미지를 직관적으로 비교할 수 있는 인터페이스를 제공해야 합니다(SHALL).

#### Scenario: HITL에서 육안 비교 옵션 선택
- **WHEN** 사용자가 Phase 완료 후 HITL 옵션에서 "[V] 육안 비교"를 선택하면
- **THEN** 시스템은 `d2c_open_visual_review` 도구 호출을 안내하고
- **AND** 해당 도구는 Playwright HTML report를 열어 diff 이미지를 표시합니다

#### Scenario: HTML reporter에서 diff 확인
- **WHEN** `d2c_open_visual_review`가 실행되면
- **THEN** Playwright HTML reporter가 브라우저에서 열리고
- **AND** 사용자는 baseline, actual, diff 이미지를 슬라이더로 비교할 수 있습니다

### Requirement: 스크린샷 이력 저장
시스템은 각 visual test 실행 시 비교에 사용된 이미지를 이력으로 저장해야 합니다(SHALL).
저장되는 이미지는 baseline(원본), code(구현체), diff(차이) 3벌입니다.

#### Scenario: visual test 실행 시 스크린샷 저장
- **WHEN** `d2c_run_visual_test`가 실행되면
- **THEN** 시스템은 `D2C_SCREENSHOT_DIR` 경로에 3벌의 스크린샷을 저장하고
- **AND** 파일명은 `phase{N}-v{M}-{type}-{timestamp}.png` 형식이며
- **AND** 저장된 파일 경로가 결과에 포함됩니다

#### Scenario: 저장된 스크린샷 경로 확인
- **WHEN** `d2c_run_visual_test` 결과가 반환되면
- **THEN** 결과에 `savedScreenshots` 필드가 포함되고
- **AND** 해당 필드에는 baseline, code, diff 경로가 포함됩니다

## MODIFIED Requirements

### Requirement: Phase 도구 HITL 옵션
각 Phase 도구(`d2c_phase1_compare`, `d2c_phase2_image_diff`, `d2c_phase3_dom_compare`)는 완료 후 HITL 옵션을 표시해야 합니다(SHALL).
HITL 옵션에는 "[V] 육안 비교" 옵션이 포함되어야 합니다.

#### Scenario: Phase 1 완료 후 HITL 옵션
- **WHEN** `d2c_phase1_compare`가 완료되면
- **THEN** HITL 옵션에 "[1][2][3][P][D][B][V][완료]"가 표시되고
- **AND** "[V]"는 `d2c_open_visual_review` 호출을 안내합니다

#### Scenario: Phase 2 완료 후 HITL 옵션
- **WHEN** `d2c_phase2_image_diff`가 완료되면
- **THEN** HITL 옵션에 "[1][2][3][P][D][B][V][완료]"가 표시되고
- **AND** "[V]"는 `d2c_open_visual_review` 호출을 안내합니다

#### Scenario: Phase 3 완료 후 HITL 옵션
- **WHEN** `d2c_phase3_dom_compare`가 완료되면
- **THEN** HITL 옵션에 "[1][2][3][P][D][B][V][완료]"가 표시되고
- **AND** "[V]"는 `d2c_open_visual_review` 호출을 안내합니다
