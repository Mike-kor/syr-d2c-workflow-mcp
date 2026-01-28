# D2C Workflow Spec Delta

## ADDED Requirements

### Requirement: 세션 상태 관리

MCP 서버는 세션 내에서 Phase 실행 이력을 추적하는 상태를 관리해야 합니다(MUST). 이 상태는 메모리 내에서만 유지되며 세션 종료 시 초기화됩니다.

#### Scenario: 세션 상태 초기화

- **WHEN** MCP 서버가 시작되거나 새 세션이 시작될 때
- **THEN** 세션 상태는 `phase1Executed: false`로 초기화됩니다

#### Scenario: Phase 실행 기록

- **WHEN** `d2c_phase1_compare`, `d2c_phase2_image_diff`, 또는 `d2c_phase3_dom_compare`가 호출될 때
- **THEN** 해당 Phase 실행 정보가 세션 상태에 기록됩니다

#### Scenario: 세션 상태 조회

- **WHEN** `d2c_get_session_state` 도구가 호출될 때
- **THEN** 현재 세션의 Phase 실행 이력과 상태가 반환됩니다

---

### Requirement: 자동 Phase 1 진입

D2C 워크플로우가 처음 시작되고 세션에서 Phase 1 실행 이력이 없을 때, 시스템은 자동으로 Phase 1 실행을 안내해야 합니다(MUST).

#### Scenario: 첫 워크플로우 시작 시 자동 Phase 1 안내

- **WHEN** `d2c_preflight_check`가 호출되고 세션에서 Phase 1 이력이 없을 때
- **THEN** 사전검사 결과에 "Phase 1 자동 실행 필요" 안내가 포함됩니다
- **AND** 다음 단계로 Phase 1 실행이 명시적으로 가이드됩니다

#### Scenario: Phase 1 이력이 있을 때

- **WHEN** `d2c_preflight_check`가 호출되고 세션에서 Phase 1 이력이 있을 때
- **THEN** 일반적인 HITL Phase 선택 안내가 표시됩니다

---

### Requirement: HITL 루프 강제

D2C 워크플로우가 시작되면 사용자가 명시적으로 [완료]를 선택하거나 세션이 종료될 때까지 HITL 루프가 계속되어야 합니다(MUST).

#### Scenario: Phase 완료 후 HITL 지속

- **WHEN** 어떤 Phase의 비교 결과가 표시된 후
- **THEN** HITL 옵션 ([1][2][3][P][D][B][완료])이 표시됩니다
- **AND** 사용자가 [완료]를 선택할 때까지 워크플로우가 종료되지 않습니다

#### Scenario: 명시적 완료 선택 시 종료

- **WHEN** 사용자가 HITL에서 [완료]를 선택할 때
- **THEN** 세션 요약 리포트가 생성됩니다
- **AND** 세션 상태가 초기화됩니다
- **AND** 워크플로우가 종료됩니다

---

## MODIFIED Requirements

### Requirement: design_to_code 프롬프트

`design_to_code` 프롬프트는 D2C 워크플로우의 전체 과정을 안내하며, 첫 진입 시 Phase 1 자동 실행을 명시해야 합니다(MUST).

#### Scenario: 프롬프트 첫 진입 안내

- **WHEN** `design_to_code` 프롬프트가 실행될 때
- **THEN** "첫 진입 시 Phase 1 자동 실행" 규칙이 명시됩니다
- **AND** Phase 1 → pixel 비교가 프로토타입 사이클임이 안내됩니다

#### Scenario: HITL 루프 안내

- **WHEN** `design_to_code` 프롬프트가 실행될 때
- **THEN** "[완료] 선택 시까지 HITL 루프 지속" 규칙이 강조됩니다
- **AND** 각 HITL 옵션의 의미가 설명됩니다

#### Scenario: 한 사이클 가이드

- **WHEN** `design_to_code` 프롬프트가 실행될 때
- **THEN** 첫 사이클 완성 예시가 제공됩니다:
  1. 사전검사 → 2. Figma URL 설정 → 3. Baseline 캡처 → 4. Phase 1 실행 → 5. pixel 비교 → 6. HITL
