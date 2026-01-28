# Tasks: flatten-phase-hierarchy

## 작업 목록

### 1. Phase 도구 출력 통합

- [x] **1.1** `d2c_phase1_compare` 출력 변경
  - 목표 달성 여부 판단 로직 제거
  - "참고 기준" 표시로 변경
  - 통합 HITL 옵션 추가: [1] Phase 1, [2] Phase 2, [3] Phase 3, [완료]

- [x] **1.2** `d2c_phase2_image_diff` 출력 변경
  - 목표 달성 여부 판단 로직 제거
  - "참고 기준" 표시로 변경
  - 통합 HITL 옵션 추가

- [x] **1.3** `d2c_phase3_dom_compare` 출력 변경
  - DOM 성공률 + 픽셀 성공률 두 가지 모두 표시
  - "참고 기준" 표시로 변경
  - 통합 HITL 옵션 추가

### 2. 워크플로우 시작점 변경

- [x] **2.1** `d2c_preflight_check` 후 Phase 선택 유도
  - 사전 검사 통과 후 Phase 선택 HITL 메시지 추가

### 3. Prompt 업데이트

- [x] **3.1** `design_to_code` prompt 워크플로우 설명 변경
  - 순차적 Phase 설명 제거
  - 동등한 Phase 선택 설명으로 변경
  - 새 HITL 옵션 설명 추가

### 4. 참고 기준 상수 정리

- [x] **4.1** `PHASE_TARGETS` 상수 용도 변경
  - 변수명 유지하되 주석에 "참고 기준"임을 명시
  - 코드 내 목표 달성 판단 로직에서 제거

## 완료

모든 작업이 완료되었습니다. v1.0.0으로 배포됩니다.
