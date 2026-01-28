# Tasks: MCP 시작 시 자동 Phase 1 진입 강제

## 1. 세션 상태 관리

- [x] 1.1 세션 상태 인터페이스 정의 (`D2CSessionState`)
  - `phase1Executed: boolean` - Phase 1 실행 여부
  - `currentPhase: number | null` - 현재 Phase
  - `phaseHistory: Array<{phase, iteration, successRate, timestamp}>` - 실행 이력
- [x] 1.2 세션 상태 저장소 구현 (메모리 내 Map 또는 객체)
- [x] 1.3 세션 초기화/리셋 함수 구현

## 2. Phase 실행 이력 추적

- [x] 2.1 `d2c_phase1_compare` 호출 시 세션 상태에 기록
- [x] 2.2 `d2c_phase2_image_diff` 호출 시 세션 상태에 기록
- [x] 2.3 `d2c_phase3_dom_compare` 호출 시 세션 상태에 기록
- [x] 2.4 세션 상태 조회 도구 추가 (`d2c_get_session_state`)

## 3. 사전검사 로직 수정

- [x] 3.1 `d2c_preflight_check`에서 세션 상태 확인
- [x] 3.2 Phase 1 이력 없으면 "Phase 1 자동 실행" 안내 메시지 추가
- [x] 3.3 결과 메시지에 "다음 단계: Phase 1 실행" 명시적 가이드

## 4. design_to_code 프롬프트 수정

- [x] 4.1 "첫 진입 시 Phase 1 자동 실행" 규칙 명시
- [x] 4.2 HITL 루프가 [완료] 선택까지 계속됨을 강조
- [x] 4.3 Phase 1 → pixel 비교가 프로토타입 사이클임을 명시
- [x] 4.4 각 단계별 예시 추가 (한 사이클 완성 가이드)

## 5. HITL 루프 강화

- [x] 5.1 Phase 결과 메시지에 "워크플로우 종료하려면 [완료] 선택" 강조
- [x] 5.2 [완료] 선택 시 세션 요약 리포트 생성
- [x] 5.3 세션 종료 시 상태 초기화

## 6. 테스트 및 문서화

- [x] 6.1 README에 "자동 Phase 1 진입" 흐름 추가
- [x] 6.2 변경 이력 (CHANGELOG) 업데이트
- [x] 6.3 버전 업데이트 (v1.7.0)

## Dependencies

- Task 1 → Task 2, 3, 4, 5 (세션 상태가 먼저 구현되어야 함)
- Task 2, 3 → Task 4 (상태 추적이 되어야 프롬프트에서 활용)
- Task 5 → Task 6 (기능 완성 후 문서화)

## Parallelizable

- Task 2.1~2.4 병렬 가능
- Task 4.1~4.4 병렬 가능
