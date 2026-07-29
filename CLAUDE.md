## CC 세션 디렉터리 분리 (2026-07-27, 홈페이지 PM 합의)
- 이 도구의 CC는 ★반드시 kanghago-pages/에서 실행. kanghago 루트 실행 금지.
- 홈페이지·1688-proxy 파일 수정·실행 금지(읽기·참고는 경로 명시 시 허용) — 필요하면 PM 간 문의.

## 후속 등록 (미착수)
- loadShipment Products 무필터 전체스캔(3,377건·63초) — 사서함 전환마다 발생. 별도 건으로 진단→설계 필요.
- ecommerce-tool의 buildCoRequestText = 7/12 구 fork — 전자상거래 CO 문구 필요 시 5b17bbb+v3.2.249 이식 필요.
- Products 죽은 참조(현지배송비CNY·WTO세율) 코드 정리.

## 컨텍스트 관리 규칙

### Bash 실행
- 명령 결과가 길 수 있으면 head / tail / grep으로 걸러서 필요한 부분만 출력할 것
- 파일 전체를 cat으로 읽지 말고 Read 도구로 필요한 범위(offset/limit)만 읽을 것
- 테스트·빌드처럼 로그가 긴 작업은 파일로 저장 후 tail -50 등으로 요약해서 확인할 것
  예: npm test > test-results.txt 2>&1 && tail -50 test-results.txt
- DB 조회 결과가 길면 LIMIT을 걸어 필요한 행만 출력할 것

### 보고 형식
- 통과/실패 표 + 핵심 수치 + 위험항목만. 전체 diff·로그 원문은 요청 시에만.
- DB 조회는 결과값만. 쿼리 원문·컬럼 전체·행 전체 출력 금지.

### 세션 관리
- 작업 주제가 바뀌면 새 세션을 시작할 것
- 컨텍스트 사용량이 80%를 넘으면 미리 알리고 /compact 할지 물어볼 것
- /compact 전 수정된 파일 목록, 현재 빌드·테스트 상태, 미해결 이슈를 먼저 파일로 저장할 것

### 인보이스 도구 프로젝트 참조
- 레포 = kanghago(메인) · kanghago-pages(배포본). 둘 다 브랜치 = main.
- 배포 = cd kanghago-pages && npx vercel --prod (GitHub 자동배포 아님 — CLI만 사용).
- ★Vercel 12함수 한도 초과 시 조용히 실패함 — 배포 후 함수 수 반드시 확인.
- 로컬 경로 = /Volumes/Thunderbolt 5 SSD/kanghago/
- 운영 DB write는 명시 승인된 것만. 돈·통관 관련 변경은 PM 확인 후 배포.
