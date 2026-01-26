# Change: Phase 전환 시 강제 HITL 확인

## Why

현재 구현에서는 Phase 목표 성공률을 달성하면 자동으로 다음 Phase로 진행하도록 권장(`recommendation = "next_phase"`)합니다. 이는 사용자가 원치 않는 자동 진행을 유발할 수 있습니다.

사용자는 성공률 달성 여부와 관계없이 **항상** 다음 선택지를 제공받아야 합니다:
- 다음 Phase로 진행
- 현재 Phase에서 한 번 더 반복 (품질 향상 시도)
- 현재 상태로 완료
- 워크플로우 중단

## What Changes

- **MODIFIED** `d2c_phase1_compare`: 성공률 달성 시에도 자동 진행 대신 HITL 확인
- **MODIFIED** `d2c_phase2_image_diff`: 성공률 달성 시에도 자동 진행 대신 HITL 확인
- **MODIFIED** `d2c_phase3_dom_compare`: 성공률 달성 시에도 자동 진행 대신 HITL 확인
- **ADDED** HITL 옵션에 "같은 Phase 반복" 선택지 추가

## Impact

- Affected specs: `d2c-workflow`
- Affected code: `src/index.ts`
  - Phase 도구들의 recommendation 로직 변경
  - HITL 옵션 텍스트 업데이트

## Success Criteria

1. 목표 성공률 달성 시에도 사용자에게 선택권 제공
2. "같은 Phase 반복" 옵션이 항상 표시됨
3. 자동으로 다음 Phase로 넘어가지 않음
