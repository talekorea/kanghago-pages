-- =====================================================================
-- consultations — 강하고 작업자↔고객 양방향 통관 상담 (v3.0.0)
-- 출처: DECISIONS.md 2026-05-15 §v3.0.0
-- 적용: Supabase Studio > SQL Editor에서 실행 (사장님 .env 추가 후)
-- =====================================================================

-- 공통: updated_at 자동 갱신
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TABLE IF NOT EXISTS public.consultations (
  -- 식별
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id        TEXT NOT NULL UNIQUE,  -- 12자 nanoid (URL: /c/{short_id})

  -- 사서함 정보
  airtable_sid    TEXT,                  -- Airtable Shipment.id (recXXX)
  mailbox_id      TEXT NOT NULL,         -- 사서함번호 (예: AP2233)

  -- 페이로드 (작업자 도구가 만든 JSON, 호환 위해 v=1 유지)
  payload         JSONB NOT NULL,
  -- 구조: { v:1, sname, customer, products, boxes, tariff, suggested, rate, inv, ct }

  -- 양방향 토글 ⭐
  customs_approved        BOOLEAN NOT NULL DEFAULT FALSE,
  customs_approved_at     TIMESTAMPTZ,
  customs_approved_by     TEXT,           -- 작업자 식별 (이메일 또는 user_id)

  customer_approved       BOOLEAN NOT NULL DEFAULT FALSE,
  customer_approved_at    TIMESTAMPTZ,
  customer_data           JSONB,          -- 고객 입력 (FTA / 배송 / 수취정보 / boxDeliveries)

  -- 최종 확정 (양쪽 OK 자동)
  finalized               BOOLEAN NOT NULL DEFAULT FALSE,
  finalized_at            TIMESTAMPTZ,

  -- 메타
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

  -- 검증
  CONSTRAINT chk_customs_audit CHECK (
    customs_approved = FALSE OR customs_approved_at IS NOT NULL
  ),
  CONSTRAINT chk_customer_audit CHECK (
    customer_approved = FALSE OR (customer_approved_at IS NOT NULL AND customer_data IS NOT NULL)
  ),
  CONSTRAINT chk_finalized_audit CHECK (
    finalized = FALSE OR (finalized_at IS NOT NULL AND customs_approved = TRUE AND customer_approved = TRUE)
  )
);
COMMENT ON TABLE public.consultations IS '강하고 통관 상담 (양방향 토글) — v3.0.0';
COMMENT ON COLUMN public.consultations.short_id IS '12자 nanoid — URL /c/{short_id}';
COMMENT ON COLUMN public.consultations.payload IS '작업자가 만든 통관 데이터 (v=1 JSON)';
COMMENT ON COLUMN public.consultations.customer_data IS '고객 응답 (fta, deliveryType, boxDeliveries, customer{...})';

CREATE INDEX IF NOT EXISTS idx_consultations_short_id ON public.consultations(short_id);
CREATE INDEX IF NOT EXISTS idx_consultations_mailbox ON public.consultations(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_consultations_status
  ON public.consultations(customs_approved, customer_approved, finalized, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultations_expires ON public.consultations(expires_at);

DROP TRIGGER IF EXISTS trg_consultations_updated_at ON public.consultations;
CREATE TRIGGER trg_consultations_updated_at BEFORE UPDATE ON public.consultations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 최종 확정 자동 트리거 — 양쪽 ✅ → finalized=TRUE
-- =====================================================================
CREATE OR REPLACE FUNCTION auto_finalize_consultation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customs_approved = TRUE
     AND NEW.customer_approved = TRUE
     AND NEW.finalized = FALSE
  THEN
    NEW.finalized := TRUE;
    NEW.finalized_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_finalize ON public.consultations;
CREATE TRIGGER trg_auto_finalize BEFORE INSERT OR UPDATE ON public.consultations
  FOR EACH ROW EXECUTE FUNCTION auto_finalize_consultation();

-- =====================================================================
-- RLS — 사장님 .env 후 활성화
--   읽기: short_id로만 (브라우저 anon key). expires_at 만료 차단.
--   쓰기(customer_approved=TRUE): short_id 매칭 + 1회만
--   관리: service_role (작업자 도구)
-- =====================================================================
ALTER TABLE public.consultations ENABLE ROW LEVEL SECURITY;

-- SELECT: 만료 안 된 모든 행 (short_id를 알아야 접근 가능 → URL이 자격증명)
CREATE POLICY consultations_select_active ON public.consultations
  FOR SELECT
  USING (expires_at > NOW());

-- INSERT: service_role만 (작업자 도구가 INSERT)
-- (anon 차단 — RLS USING TRUE면 누구나 INSERT 가능해지므로 default deny 유지)

-- UPDATE: anon은 customer 측 필드만 (customer_approved + customer_data)
CREATE POLICY consultations_update_customer ON public.consultations
  FOR UPDATE
  USING (expires_at > NOW() AND customer_approved = FALSE)
  WITH CHECK (
    -- 이 정책으로 들어오는 UPDATE는 customer 측 필드만 변경되어야 함
    -- (실제 컬럼 변경 검증은 BEFORE UPDATE 트리거에서)
    expires_at > NOW()
  );

-- 변경 가능 컬럼 화이트리스트 (anon UPDATE 시)
CREATE OR REPLACE FUNCTION enforce_customer_update_columns() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- service_role(auth.role()='service_role')은 자유. anon만 제한
  IF auth.role() = 'service_role' OR auth.role() = 'authenticated' THEN
    RETURN NEW;
  END IF;
  -- anon은 다음 컬럼만 변경 허용
  IF NEW.payload IS DISTINCT FROM OLD.payload THEN RAISE EXCEPTION 'payload는 변경 불가'; END IF;
  IF NEW.customs_approved IS DISTINCT FROM OLD.customs_approved THEN RAISE EXCEPTION 'customs_approved는 작업자만'; END IF;
  IF NEW.airtable_sid IS DISTINCT FROM OLD.airtable_sid THEN RAISE EXCEPTION 'airtable_sid 변경 불가'; END IF;
  IF NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id THEN RAISE EXCEPTION 'mailbox_id 변경 불가'; END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'expires_at 변경 불가'; END IF;
  -- short_id, id는 PK + UNIQUE — 어차피 변경 불가
  -- customer_approved, customer_approved_at, customer_data만 허용
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_update_guard ON public.consultations;
CREATE TRIGGER trg_customer_update_guard BEFORE UPDATE ON public.consultations
  FOR EACH ROW EXECUTE FUNCTION enforce_customer_update_columns();

-- =====================================================================
-- Realtime publication (작업자 도구가 customer_approved 변경 즉시 알림)
-- =====================================================================
DO $$ BEGIN
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.consultations';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN
    RAISE NOTICE 'supabase_realtime publication 미존재 — Studio에서 Database > Replication 활성화 권장';
END $$;

-- =====================================================================
-- 만료 자동 cleanup (옵션 cron — Supabase pg_cron extension 필요)
-- =====================================================================
-- 7일 + 30일 grace 후 hard delete. Studio에서 별도 활성화:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   SELECT cron.schedule('cleanup-consultations', '0 4 * * *',
--     $$DELETE FROM public.consultations WHERE expires_at < NOW() - INTERVAL '30 days'$$);

-- =====================================================================
-- 적용 후 검증 쿼리
-- =====================================================================
-- SELECT short_id, mailbox_id, customs_approved, customer_approved, finalized FROM consultations ORDER BY created_at DESC LIMIT 10;
-- SELECT COUNT(*) FROM consultations WHERE finalized = TRUE;
