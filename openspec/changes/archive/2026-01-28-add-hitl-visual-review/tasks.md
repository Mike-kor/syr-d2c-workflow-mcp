# Tasks: HITL 육안 비교 및 스크린샷 이력 저장

## 1. 스크린샷 이력 저장 로직 수정

- [ ] 1.1 `generateVisualTest` 함수에서 스크린샷 저장 로직 검토 및 수정
- [ ] 1.2 Playwright 테스트 실행 후 diff 이미지를 `D2C_SCREENSHOT_DIR`에 복사하는 로직 추가
- [ ] 1.3 baseline/code/diff 3벌이 모두 저장되는지 검증
- [ ] 1.4 저장된 파일 경로를 `d2c_run_visual_test` 결과에 포함

## 2. HITL 육안 비교 기능 추가

- [ ] 2.1 `d2c_open_visual_review` 도구 스키마 정의
- [ ] 2.2 Playwright HTML reporter 설정 추가
- [ ] 2.3 HTML report 자동 열기 로직 구현
- [ ] 2.4 최근 테스트 결과 경로 관리 로직 추가

## 3. Phase 도구 HITL 옵션 수정

- [ ] 3.1 `d2c_phase1_compare` HITL 옵션에 "[V] 육안 비교" 추가
- [ ] 3.2 `d2c_phase2_image_diff` HITL 옵션에 "[V] 육안 비교" 추가
- [ ] 3.3 `d2c_phase3_dom_compare` HITL 옵션에 "[V] 육안 비교" 추가
- [ ] 3.4 "[V]" 선택 시 `d2c_open_visual_review` 호출 안내 추가

## 4. 테스트 및 문서화

- [ ] 4.1 스크린샷 저장 기능 테스트
- [ ] 4.2 HITL 육안 비교 기능 테스트
- [ ] 4.3 README.md에 새 기능 문서화
- [ ] 4.4 design_to_code 프롬프트 업데이트
