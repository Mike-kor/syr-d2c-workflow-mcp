# Tasks: 3단계 검증 워크플로우 구현

## 1. Phase 1 구현 (Figma MCP 기반)

- [x] 1.1 `d2c_phase1_compare` 도구 스키마 정의
- [x] 1.2 Playwright 스크린샷 비교 로직 구현
- [x] 1.3 성공률 계산 및 표시 기능 구현
- [x] 1.4 HITL 확인 로직 추가
- [ ] 1.5 Phase 1 테스트

## 2. Phase 2 구현 (LLM 이미지 Diff)

- [x] 2.1 `d2c_phase2_image_diff` 도구 스키마 정의
- [x] 2.2 이미지 diff 결과 분석 로직 구현
- [x] 2.3 LLM 코드 수정 가이드 생성 기능
- [x] 2.4 성공률 계산 및 표시 기능 구현
- [x] 2.5 HITL 확인 로직 추가
- [ ] 2.6 Phase 2 테스트

## 3. Phase 3 구현 (DOM 비교)

- [x] 3.1 `d2c_phase3_dom_compare` 도구 스키마 정의
- [x] 3.2 DOM 스냅샷 비교 로직 구현
- [x] 3.3 DOM 차이점 분석 및 수정 가이드 생성
- [x] 3.4 성공률 계산 및 표시 기능 구현
- [x] 3.5 HITL 확인 로직 추가
- [ ] 3.6 Phase 3 테스트

## 4. 통합 및 프롬프트 업데이트

- [x] 4.1 `d2c_workflow_status` 도구 추가 (전체 진행 상황)
- [x] 4.2 `design_to_code` 프롬프트 3단계 워크플로우로 업데이트
- [x] 4.3 기존 도구 유지 (하위 호환성)
- [ ] 4.4 통합 테스트

## 5. 배포

- [ ] 5.1 README.md 업데이트
- [x] 5.2 버전 업데이트 (0.3.0)
- [x] 5.3 npm 배포
- [ ] 5.4 GitHub 푸시
