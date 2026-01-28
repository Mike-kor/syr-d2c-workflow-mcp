## MODIFIED Requirements

### Requirement: Phase 전환 HITL 확인

각 Phase에서 목표 성공률 달성 여부와 관계없이 시스템은 사용자에게 다음 행동을 선택하도록 요청해야 합니다(SHALL).

#### Scenario: 목표 성공률 달성 시 HITL 확인

- **GIVEN** Phase N에서 목표 성공률을 달성함
- **WHEN** Phase 도구(`d2c_phase1_compare`, `d2c_phase2_image_diff`, `d2c_phase3_dom_compare`)가 호출됨
- **THEN** 시스템은 자동으로 다음 Phase로 진행하지 않고 사용자에게 선택을 요청해야 함
- **AND** 선택지에는 "다음 Phase 진행", "같은 Phase 반복", "현재 상태로 완료", "중단"이 포함되어야 함

#### Scenario: 목표 성공률 미달성 시 HITL 확인

- **GIVEN** Phase N에서 목표 성공률을 달성하지 못함
- **WHEN** Phase 도구가 호출됨
- **THEN** 시스템은 사용자에게 선택을 요청해야 함
- **AND** 선택지에는 "같은 Phase 반복", "다음 Phase로 건너뛰기", "현재 상태로 완료", "중단"이 포함되어야 함

#### Scenario: 최대 반복 횟수 도달 시 HITL 확인

- **GIVEN** Phase N에서 최대 반복 횟수에 도달함
- **WHEN** Phase 도구가 호출됨
- **THEN** 시스템은 자동으로 중단하지 않고 사용자에게 선택을 요청해야 함
- **AND** 경고 메시지와 함께 계속 반복할지 여부를 물어야 함

### Requirement: HITL 선택지 표시

각 Phase 도구의 출력에는 사용자가 선택할 수 있는 명확한 옵션이 표시되어야 합니다(SHALL).

#### Scenario: Phase 1 HITL 옵션 표시

- **GIVEN** `d2c_phase1_compare` 도구가 호출됨
- **WHEN** 결과가 반환됨
- **THEN** 다음 옵션이 표시되어야 함:
  - [Y] 다음 Phase로 진행 (Phase 2)
  - [R] 같은 Phase 반복 (Figma MCP 재추출)
  - [N] 현재 상태로 완료
  - [M] 수동 수정 후 재비교
  - [S] 워크플로우 중단

#### Scenario: Phase 2 HITL 옵션 표시

- **GIVEN** `d2c_phase2_image_diff` 도구가 호출됨
- **WHEN** 결과가 반환됨
- **THEN** 다음 옵션이 표시되어야 함:
  - [Y] 다음 Phase로 진행 (Phase 3)
  - [R] 같은 Phase 반복 (LLM 이미지 diff 수정)
  - [N] 현재 상태로 완료
  - [M] 수동 수정 후 재비교
  - [S] 워크플로우 중단

#### Scenario: Phase 3 HITL 옵션 표시

- **GIVEN** `d2c_phase3_dom_compare` 도구가 호출됨
- **WHEN** 결과가 반환됨
- **THEN** 다음 옵션이 표시되어야 함:
  - [Y] 완료
  - [R] 같은 Phase 반복 (LLM DOM 수정)
  - [N] 현재 상태로 완료
  - [M] 수동 수정 후 재비교
  - [S] 워크플로우 중단
