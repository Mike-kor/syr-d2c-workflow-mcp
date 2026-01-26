# Spec Delta: d2c-workflow

## MODIFIED Requirements

### Requirement: Phase 워크플로우 구조

시스템은 순차적 Phase 진행(1→2→3) 대신 동등한 Phase 선택 구조를 제공해야 합니다(SHALL). 사용자는 사전 검사 통과 후 원하는 Phase를 자유롭게 선택할 수 있어야 하며(MUST), 각 Phase 실행 후에도 다시 모든 Phase 중에서 선택할 수 있어야 합니다(MUST).

#### Scenario: 사전 검사 통과 후 Phase 선택

**Given** 사용자가 D2C 워크플로우를 시작함
**And** `d2c_preflight_check` 사전 검사를 통과함
**And** 규칙 파일(.md)이 존재함
**When** 사전 검사가 완료됨
**Then** Phase 선택 HITL 메시지가 표시됨
**And** Phase 1, 2, 3, 완료 옵션이 동등하게 제시됨

#### Scenario: Phase 1 실행 후 자유 선택

**Given** 사용자가 Phase 1을 선택하여 실행함
**When** Playwright pixel 비교가 완료됨
**Then** 픽셀 성공률이 표시됨
**And** "참고 기준" (60%, 70%, 90%)이 표시됨
**And** HITL로 Phase 1, 2, 3, 완료 중 선택 요청
**And** 어떤 Phase도 "권장"으로 표시되지 않음

#### Scenario: Phase 2 실행 후 자유 선택

**Given** 사용자가 Phase 2를 선택하여 실행함
**When** Playwright pixel 비교가 완료됨
**Then** 픽셀 성공률이 표시됨
**And** "참고 기준" (60%, 70%, 90%)이 표시됨
**And** HITL로 Phase 1, 2, 3, 완료 중 선택 요청

#### Scenario: Phase 3 실행 후 이중 성공률 표시

**Given** 사용자가 Phase 3을 선택하여 실행함
**When** DOM 비교와 Playwright pixel 비교가 모두 완료됨
**Then** DOM 성공률이 표시됨
**And** 픽셀 성공률이 표시됨
**And** 두 성공률이 함께 표시됨
**And** "참고 기준" (60%, 70%, 90%)이 표시됨
**And** HITL로 Phase 1, 2, 3, 완료 중 선택 요청

---

### Requirement: 목표 성공률 처리

시스템은 목표 성공률을 필수 달성 기준이 아닌 참고 기준으로만 표시해야 합니다(SHALL). 성공률이 목표를 초과해도 "권장"이나 "목표 달성" 메시지를 표시하지 않아야 하며(MUST NOT), 모든 판단은 사용자에게 위임되어야 합니다(MUST).

#### Scenario: 참고 기준 표시

**Given** 어떤 Phase든 실행이 완료됨
**When** 성공률 결과가 표시됨
**Then** "참고 기준"으로 다음이 표시됨:
  - Phase 1: 60%
  - Phase 2: 70%
  - Phase 3: 90%
**And** 현재 성공률과 참고 기준의 비교는 사용자가 판단

#### Scenario: 목표 달성 판단 제거

**Given** Phase가 실행되어 성공률이 계산됨
**When** 성공률이 참고 기준(60/70/90%)을 초과함
**Then** "목표 달성" 또는 "권장" 메시지가 표시되지 않음
**And** 모든 Phase 옵션이 동등하게 제시됨

---

### Requirement: HITL 옵션 구조

시스템은 Phase별로 다른 HITL 옵션 대신 통합된 옵션을 제공해야 합니다(SHALL). 모든 Phase 완료 후 동일한 옵션(Phase 1, 2, 3, 완료)이 제시되어야 하며(MUST), Phase 번호로 직관적으로 선택할 수 있어야 합니다(MUST).

#### Scenario: 통합 HITL 옵션 표시

**Given** 어떤 Phase든 실행이 완료됨
**When** HITL 메시지가 표시됨
**Then** 다음 옵션이 표시됨:
  - `[1]` Phase 1: Figma MCP 재추출
  - `[2]` Phase 2: LLM 이미지 diff 수정
  - `[3]` Phase 3: LLM DOM 수정
  - `[완료]` 현재 상태로 종료
**And** 옵션 순서는 항상 동일함

#### Scenario: Phase 번호로 선택

**Given** HITL 옵션이 표시됨
**When** 사용자가 `[1]`, `[2]`, `[3]` 중 하나를 선택함
**Then** 해당 Phase가 실행됨
**And** 이전 Phase와 무관하게 독립적으로 실행됨

#### Scenario: 완료 선택

**Given** HITL 옵션이 표시됨
**When** 사용자가 `[완료]`를 선택함
**Then** 워크플로우가 종료됨
**And** 현재까지의 결과가 최종 결과로 확정됨

---

## REMOVED Requirements

### Requirement: 순차적 Phase 진행

시스템은 Phase 1 → Phase 2 → Phase 3 순차 진행을 강제하지 않아야 합니다(SHALL NOT). 사용자 자유 선택으로 대체됩니다.

#### Scenario: Phase 1 완료 후 Phase 2 권장 (제거됨)

**Given** Phase 1에서 60% 이상 달성함
**When** 이전에는 Phase 2 진행이 권장되었음
**Then** 이제는 모든 Phase가 동등하게 제시됨

---

### Requirement: 목표 달성 기반 권장

시스템은 목표 성공률 달성 여부에 따른 다음 단계 권장을 하지 않아야 합니다(SHALL NOT). 모든 판단을 사용자에게 위임합니다.

#### Scenario: 목표 달성 시 권장 표시 (제거됨)

**Given** 성공률이 targetRate를 초과함
**When** 이전에는 "다음 Phase 진행 권장" 표시되었음
**Then** 이제는 권장 표시 없이 동등한 옵션만 제시됨
