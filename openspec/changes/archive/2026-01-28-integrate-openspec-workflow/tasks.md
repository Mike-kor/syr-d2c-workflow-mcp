# Tasks: OpenSpec 기반 워크플로우 통합

## 1. OpenSpec 규칙 로드 기능

- [ ] 1.1 `d2c_load_openspec_rules` 도구 스키마 정의
- [ ] 1.2 프로젝트 내 OpenSpec 경로 탐지 로직 구현
- [ ] 1.3 spec.md 파싱 로직 구현 (Requirements, Scenarios 추출)
- [ ] 1.4 규칙 우선순위 적용 로직 구현
- [ ] 1.5 기존 규칙 로드와 통합

## 2. 워크플로우 Tasks 기능

- [ ] 2.1 `d2c_get_workflow_tasks` 도구 스키마 정의
- [ ] 2.2 Phase별 tasks.md 형식 체크리스트 생성 로직
- [ ] 2.3 적용 규칙 목록 표시 기능
- [ ] 2.4 진행 상태 추적 기능

## 3. 규칙 검증 기능

- [ ] 3.1 `d2c_validate_against_spec` 도구 스키마 정의
- [ ] 3.2 코드와 규칙 Requirement 매칭 로직
- [ ] 3.3 Scenario 기반 검증 로직 (가능한 범위)
- [ ] 3.4 검증 결과 리포트 생성

## 4. 프롬프트 업데이트

- [ ] 4.1 `design_to_code` 프롬프트에 OpenSpec 사용법 추가
- [ ] 4.2 각 Phase에서 tasks 체크리스트 활용 안내
- [ ] 4.3 규칙 검증 호출 안내

## 5. 문서화 및 배포

- [ ] 5.1 README.md에 OpenSpec 통합 섹션 추가
- [ ] 5.2 사용 예시 추가
- [ ] 5.3 버전 업데이트 (0.4.0)
- [ ] 5.4 npm 배포
- [ ] 5.5 GitHub 푸시
