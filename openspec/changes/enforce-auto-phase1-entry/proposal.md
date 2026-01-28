# Change: MCP 시작 시 자동 Phase 1 진입 강제

## Why

현재 syr 등 지시어로 D2C 워크플로우를 시작하면 사전검사만 수행하고, AI가 Phase 선택 없이 일반적으로 figma-mcp로 코드를 가져오는 경향이 있습니다. 이로 인해 D2C 워크플로우의 핵심인 Phase 시스템과 HITL 루프가 제대로 활용되지 않습니다.

## What Changes

- **세션 상태 관리 추가**: MCP 서버 내부에 세션별 Phase 실행 이력 추적 (메모리 내)
- **자동 Phase 1 진입**: 세션에서 phase1 시도 이력이 없으면 사전검사 후 **자동으로 Phase 1 실행**
- **HITL 루프 강제**: Phase 1 완료 후 pixel 비교 → HITL → [완료] 선택 시까지 반복
- **프롬프트 개선**: `design_to_code` 프롬프트에서 첫 진입 시 Phase 1 자동 실행 명시

### 변경되는 흐름

```
[이전]
syr 시작 → 사전검사 → 사용자 Phase 선택 대기 → (AI가 figma-mcp로 직접 처리)

[이후]
syr 시작 → 사전검사 → (이력 없음) → 자동 Phase 1 실행 → pixel 비교 → HITL
                                                                    ↓
                                                    [1][2][3][P][D][B][완료] 선택
                                                                    ↓
                                                    [완료] 선택 시 → 종료
```

## Impact

- **Affected specs**: d2c-workflow
- **Affected code**: 
  - `src/index.ts` - 세션 상태 관리, `design_to_code` 프롬프트, Phase 도구들
- **Breaking changes**: 없음 (기존 동작은 유지하되 첫 진입 시 자동 Phase 1 추가)
