# Change: OpenSpec 기반 워크플로우 통합

## Why

현재 MCP는 환경변수로 규칙 파일 경로를 지정하는 방식이지만, 사용자 프로젝트에서 OpenSpec 형식으로 정의된 규칙(예: `figma-standard`)을 자동으로 인식하고 활용하면 더 체계적인 워크플로우가 가능합니다.

또한 OpenSpec의 tasks.md 형식을 활용하면 AI가 워크플로우를 더 규칙적으로 실행할 수 있습니다.

## What Changes

- **ADDED** 사용자 프로젝트의 OpenSpec 규칙 자동 탐지 및 로드
- **ADDED** `d2c_load_openspec_rules` 도구 - 프로젝트의 OpenSpec specs 로드
- **ADDED** `d2c_get_workflow_tasks` 도구 - 현재 Phase에 맞는 체크리스트 반환
- **ADDED** `d2c_validate_against_spec` 도구 - OpenSpec 규칙 준수 검증
- **MODIFIED** 기존 규칙 로드 로직에 OpenSpec 경로 추가
- **ADDED** 워크플로우 실행 시 tasks.md 형식 출력

## Impact

- Affected specs: `openspec-integration` (신규)
- Affected code: `src/index.ts`
  - 새 도구 3개 추가
  - 규칙 로드 로직 확장
  - 프롬프트 업데이트

## Dependencies

- 사용자 프로젝트에 OpenSpec 구조 존재 시 활용 (선택적)
- openspec CLI (검증 시 사용, 선택적)

## Success Criteria

1. 사용자 프로젝트의 `openspec/specs/*/spec.md` 자동 탐지
2. 규칙 기반 코드 생성 및 검증
3. Phase별 tasks.md 형식 체크리스트 제공
4. 규칙 미준수 시 명확한 피드백 제공
