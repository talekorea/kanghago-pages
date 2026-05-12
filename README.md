# Kanghago Pages — 강하고 무역 외부 페이지

강하고 무역(Tale Korea)의 **관세사 확정** 및 **고객 확인** 외부 페이지입니다.

## 📋 구조

```
kanghago-pages/
├── api/
│   ├── _lib.js          ← Airtable 공통 모듈
│   ├── customs.js       ← 관세사 API
│   └── customer.js      ← 고객 API
├── public/
│   ├── index.html       ← 루트 (안내)
│   ├── customs.html     ← 관세사 페이지
│   └── customer.html    ← 고객 페이지
├── vercel.json
└── package.json
```

## 🔐 보안 모델

```
[관세사 페이지]
URL: /customs?ship=recXXX
인증: 사서함 상태 검증 (관세사확정대기/완료만 접근 가능)

[고객 페이지]
URL: /customer?ship=recXXX&t=무작위32자토큰
인증: Airtable에 저장된 토큰과 매치 + 만료일 검증 (1주일)
```

**PAT는 Vercel 환경 변수에만 저장**됩니다. URL이나 페이지 소스에 노출되지 않습니다.

## 🚀 배포 가이드

### 1. GitHub에 코드 업로드

#### 옵션 A: GitHub 웹에서 직접 업로드 (가장 쉬움)

1. https://github.com/talekorea/kanghago-pages 접속
2. **"Add file"** → **"Upload files"** 클릭
3. 이 폴더의 모든 파일을 드래그 (api/, public/, vercel.json, package.json, README.md)
4. Commit message: `Initial setup`
5. **Commit changes** 클릭

#### 옵션 B: GitHub Desktop (반복 작업 시 편리)

1. https://desktop.github.com/ 다운로드 설치
2. GitHub 로그인
3. **Clone repository** → `talekorea/kanghago-pages` 선택
4. 이 폴더 내용을 클론된 폴더에 복사
5. **Commit to main** → **Push origin**

### 2. Vercel에서 프로젝트 Import

1. https://vercel.com/new 접속
2. **"Continue with GitHub"** 클릭 (필요 시 권한 부여)
3. `talekorea/kanghago-pages` 저장소 옆 **"Import"** 클릭
4. **Configure Project** 화면:
   - Framework Preset: **Other**
   - Root Directory: `.` (기본값)
   - Build Command: (비움)
   - Output Directory: `public`
5. **Environment Variables** 추가 (이게 핵심!):
   - Name: `AIRTABLE_PAT` / Value: `(본인 Airtable PAT 입력)`
   - Name: `AIRTABLE_BASE_ID` / Value: `appGdGsw2NmQqgE95`
6. **Deploy** 클릭
7. 1-2분 후 배포 완료
8. URL 확인: `https://kanghago-pages.vercel.app` (또는 `kanghago-pages-xxx.vercel.app`)

### 3. 메인 도구 (v2.9.8) URL 업데이트

메인 도구에서 생성하는 고객 페이지 URL이 실제 Vercel URL과 일치해야 합니다.

`v2.9.8` 코드 안의 다음 부분을 본인 URL로 변경:

```javascript
const customerUrl = `https://kanghago-customer.vercel.app/?t=${token}&ship=${state.shipment.id}`;
```

→ 변경:

```javascript
const customerUrl = `https://[본인-vercel-url]/customer?t=${token}&ship=${state.shipment.id}`;
```

(다음 단계에서 함께 수정 예정)

## 🧪 배포 확인

배포 후 다음 URL이 작동해야 합니다:

- `https://[your-url]/` → 안내 페이지
- `https://[your-url]/customs?ship=recXXX` → 관세사 페이지
- `https://[your-url]/customer?ship=recXXX&t=토큰` → 고객 페이지

## 🔧 환경 변수

| 변수명 | 값 | 비고 |
|---|---|---|
| `AIRTABLE_PAT` | `pat...` | Airtable Personal Access Token |
| `AIRTABLE_BASE_ID` | `appGdGsw2NmQqgE95` | Base ID |

## 📝 라이센스

비공개 (Tale Korea 내부 사용)
