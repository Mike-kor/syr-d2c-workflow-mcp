# Capability: OpenSpec 규칙 통합

## ADDED Requirements

### Requirement: OpenSpec 규칙 자동 탐지

시스템은 사용자 프로젝트 내 OpenSpec 규칙 파일을 자동으로 탐지해야 합니다(SHALL).

- 탐지 경로: `./openspec/specs/*/spec.md`, `./.cursor/openspec/specs/*/spec.md`
- 탐지 실패 시 기존 규칙 로드 방식으로 fallback

#### Scenario: OpenSpec 규칙 탐지 성공

- **GIVEN** 사용자 프로젝트에 `openspec/specs/figma-standard/spec.md` 파일이 존재할 때
- **WHEN** `d2c_load_openspec_rules`를 호출하면
- **THEN** 해당 규칙의 Requirements와 Scenarios를 파싱하여 반환한다

#### Scenario: OpenSpec 규칙 없음

- **GIVEN** 사용자 프로젝트에 OpenSpec 구조가 없을 때
- **WHEN** `d2c_load_openspec_rules`를 호출하면
- **THEN** 기존 환경변수/설정 파일 기반 규칙을 로드한다

---

### Requirement: 워크플로우 Tasks 체크리스트

시스템은 각 Phase 시작 시 tasks.md 형식의 체크리스트를 제공해야 합니다(SHALL).

#### Scenario: Phase 1 체크리스트 제공

- **GIVEN** Phase 1이 시작될 때
- **WHEN** `d2c_get_workflow_tasks(phase: 1)`를 호출하면
- **THEN** 다음 형식으로 체크리스트를 반환한다:
  ```
  ## Phase 1: Figma MCP 추출 (목표 60%)
  
  ### Tasks
  - [ ] 1.1 Figma 디자인 컨텍스트 가져오기
  - [ ] 1.2 Figma MCP로 코드 추출
  - [ ] 1.3 Playwright 렌더링
  - [ ] 1.4 스크린샷 비교 (toHaveScreenshot)
  - [ ] 1.5 d2c_phase1_compare 호출
  - [ ] 1.6 HITL 확인
  
  ### 적용 규칙
  - figma-standard: 컴포넌트 구조 규칙
  ```

#### Scenario: 적용 규칙 목록 표시

- **GIVEN** 프로젝트에 여러 OpenSpec 규칙이 있을 때
- **WHEN** `d2c_get_workflow_tasks`를 호출하면
- **THEN** 적용될 규칙 목록과 각 규칙의 핵심 Requirements를 표시한다

---

### Requirement: 규칙 기반 코드 검증

시스템은 생성된 코드가 OpenSpec 규칙을 준수하는지 검증해야 합니다(SHALL).

#### Scenario: 규칙 준수 검증 성공

- **GIVEN** 생성된 코드와 OpenSpec 규칙이 있을 때
- **WHEN** `d2c_validate_against_spec(code, specName)`를 호출하면
- **THEN** 각 Requirement별 pass/fail 상태와 메시지를 반환한다

#### Scenario: 규칙 미준수 발견

- **GIVEN** 생성된 코드가 특정 규칙을 위반했을 때
- **WHEN** `d2c_validate_against_spec`를 호출하면
- **THEN** 위반 내용과 수정 가이드를 반환한다:
  ```
  ❌ Requirement: 컴포넌트 네이밍 규칙
     위반: 컴포넌트 이름이 PascalCase가 아님
     현재: button_primary
     권장: ButtonPrimary
  ```

---

### Requirement: 규칙 우선순위

시스템은 다음 순서로 규칙을 적용해야 합니다(SHALL):

1. 환경변수로 명시적 지정된 규칙 (RULES_PATHS)
2. 사용자 프로젝트 OpenSpec 규칙
3. MCP 내장 기본 규칙

#### Scenario: 규칙 충돌 시 우선순위 적용

- **GIVEN** 환경변수와 OpenSpec 모두에 같은 항목의 규칙이 있을 때
- **WHEN** 규칙을 적용하면
- **THEN** 환경변수로 지정된 규칙이 우선 적용된다

---

### Requirement: 실시간 진행 상태

시스템은 tasks 체크리스트의 진행 상태를 추적해야 합니다(SHALL).

#### Scenario: Task 완료 표시

- **GIVEN** Phase 진행 중 특정 task가 완료되었을 때
- **WHEN** `d2c_get_workflow_tasks(phase, completedTasks: [1.1, 1.2])`를 호출하면
- **THEN** 완료된 task는 [x]로 표시한다:
  ```
  - [x] 1.1 Figma 디자인 컨텍스트 가져오기
  - [x] 1.2 Figma MCP로 코드 추출
  - [ ] 1.3 Playwright 렌더링
  ```
