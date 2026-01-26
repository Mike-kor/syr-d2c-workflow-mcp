# Tasks: Phase 전환 시 강제 HITL 확인

## 1. Phase 도구 recommendation 로직 변경

- [x] 1.1 `d2c_phase1_compare`에서 `next_phase` 대신 `user_confirm` 사용
- [x] 1.2 `d2c_phase2_image_diff`에서 `next_phase` 대신 `user_confirm` 사용
- [x] 1.3 `d2c_phase3_dom_compare`에서 `complete` 대신 `user_confirm` 사용

## 2. HITL 옵션 텍스트 업데이트

- [x] 2.1 Phase 1 HITL 옵션에 "같은 Phase 반복" 선택지 추가
- [x] 2.2 Phase 2 HITL 옵션에 "같은 Phase 반복" 선택지 추가
- [x] 2.3 Phase 3 HITL 옵션에 "같은 Phase 반복" 선택지 추가

## 3. 결과 메시지 개선

- [x] 3.1 목표 달성 시 "달성했지만 선택하세요" 메시지 추가
- [x] 3.2 각 선택지별 결과 설명 추가

## 4. 테스트 및 빌드

- [x] 4.1 TypeScript 빌드 확인
- [x] 4.2 HITL 옵션 출력 확인

## 5. 배포

- [x] 5.1 버전 업데이트 (0.6.0)
- [x] 5.2 npm publish
