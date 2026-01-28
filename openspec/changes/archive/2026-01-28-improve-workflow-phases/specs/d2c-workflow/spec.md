# Capability: D2C 3단계 검증 워크플로우

## ADDED Requirements

### Requirement: Phase 1 스크린샷 비교

시스템은 Figma MCP로 추출한 코드의 렌더링 결과를 원본 디자인과 픽셀 단위로 비교하여 성공률을 측정해야 합니다(SHALL).

- 기본 목표 성공률: 60%
- 수정 주체: Figma MCP (코드 재추출)
- HITL 확인 필수

#### Scenario: Phase 1 성공률 미달 시 재시도

- **GIVEN** Phase 1이 진행 중이고 현재 성공률이 55%일 때
- **WHEN** 사용자가 "계속"을 선택하면
- **THEN** Figma MCP로 코드를 다시 추출하고 비교를 반복한다

#### Scenario: Phase 1 성공률 달성 시 Phase 2 진행

- **GIVEN** Phase 1이 진행 중일 때
- **WHEN** 성공률이 60% 이상 달성되면
- **THEN** Phase 2로 자동 전환을 권장한다

#### Scenario: Phase 1 수동 개입

- **GIVEN** Phase 1이 진행 중일 때
- **WHEN** 사용자가 코드를 직접 수정하면
- **THEN** 수정된 코드로 다시 비교를 수행한다

---

### Requirement: Phase 2 이미지 Diff 기반 LLM 수정

시스템은 Phase 1 결과물의 이미지 diff를 분석하고 LLM이 코드를 수정하여 성공률을 높여야 합니다(SHALL).

- 기본 목표 성공률: 70%
- 수정 주체: LLM (코드 직접 수정)
- HITL 확인 필수

#### Scenario: Phase 2 이미지 diff 분석

- **GIVEN** Phase 1이 완료되고 Phase 2가 시작될 때
- **WHEN** 이미지 diff가 수행되면
- **THEN** 차이점 위치와 종류(색상/레이아웃/간격)를 분석하여 LLM에 전달한다

#### Scenario: Phase 2 LLM 코드 수정

- **GIVEN** 이미지 diff 결과가 있을 때
- **WHEN** LLM이 코드를 수정하면
- **THEN** 수정된 코드를 렌더링하고 성공률을 재측정한다

#### Scenario: Phase 2 성공률 달성 시 Phase 3 진행

- **GIVEN** Phase 2가 진행 중일 때
- **WHEN** 성공률이 70% 이상 달성되면
- **THEN** Phase 3로 자동 전환을 권장한다

---

### Requirement: Phase 3 DOM 비교 기반 LLM 수정

시스템은 DOM 구조를 비교하여 LLM이 코드를 수정하고 최종 성공률 90%를 달성해야 합니다(SHALL).

- 기본 목표 성공률: 90%
- 수정 주체: LLM (코드 직접 수정)
- HITL 확인 필수

#### Scenario: Phase 3 DOM 구조 비교

- **GIVEN** Phase 2가 완료되고 Phase 3가 시작될 때
- **WHEN** DOM 비교가 수행되면
- **THEN** 구조적 차이(요소 누락/추가, 속성 차이)를 분석하여 LLM에 전달한다

#### Scenario: Phase 3 최종 완료

- **GIVEN** Phase 3가 진행 중일 때
- **WHEN** 성공률이 90% 이상 달성되면
- **THEN** 워크플로우를 완료하고 최종 결과를 보고한다

---

### Requirement: 실시간 성공률 표시

시스템은 모든 Phase에서 현재 성공률을 실시간으로 표시해야 합니다(SHALL).

#### Scenario: 성공률 표시 형식

- **GIVEN** 비교가 완료되었을 때
- **WHEN** 성공률이 계산되면
- **THEN** 다음 형식으로 표시한다:
  ```
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📊 Phase 2 - 반복 3/5
  ┌────────────┬──────────┬────────┐
  │ 현재 성공률 │ 목표     │ 상태   │
  ├────────────┼──────────┼────────┤
  │ 65%        │ 70%      │ 진행중 │
  └────────────┴──────────┴────────┘
  → 계속하시겠습니까? [Y/N/수동수정]
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ```

---

### Requirement: HITL (Human-in-the-Loop) 확인

시스템은 각 Phase의 매 반복마다 사용자에게 계속 여부를 확인해야 합니다(SHALL).

#### Scenario: HITL 옵션 제공

- **GIVEN** Phase N의 비교가 완료되었을 때
- **WHEN** 목표 성공률 미달이면
- **THEN** 다음 옵션을 제공한다:
  - 계속 (자동 수정 후 반복)
  - 수동 수정 (사용자가 직접 코드 수정)
  - 현재 상태로 완료
  - 워크플로우 중단

#### Scenario: 최대 반복 횟수 도달

- **GIVEN** Phase N의 반복 횟수가 최대(기본 5회)에 도달했을 때
- **WHEN** 목표 성공률 미달이면
- **THEN** 강제로 HITL 확인을 요청한다

---

### Requirement: Phase별 목표 성공률 설정

시스템은 각 Phase의 목표 성공률을 사용자가 설정할 수 있어야 합니다(SHALL).

#### Scenario: 기본 성공률 적용

- **GIVEN** 사용자가 목표 성공률을 지정하지 않았을 때
- **WHEN** 워크플로우가 시작되면
- **THEN** 기본값을 적용한다: Phase1=60%, Phase2=70%, Phase3=90%

#### Scenario: 사용자 지정 성공률 적용

- **GIVEN** 사용자가 `targetRates: {phase1: 50, phase2: 65, phase3: 85}`를 지정했을 때
- **WHEN** 워크플로우가 시작되면
- **THEN** 지정된 값으로 목표를 설정한다
