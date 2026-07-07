// 청구서 + 결제 통합 페이지 데이터 프록시 — v3.2.3 Phase (2026-05-30)
//
// GET /api/invoice-view?mailbox=AP1819
//   returns: { shipment, customer, orders, products, totals, issuer, paidInAt, generatedAt }
//
// 사장님 통찰: "페이지 하나를 만들어서 그 양식에 청구 내역 + 입금계좌가 존재하는것이 맞다"
//   1. 직원이 도구 §9 [통합 청구서 URL] 클릭 → 페이지 URL 한 개로 카톡 발송
//   2. 고객이 페이지 열어 청구 내역 보고 하단 [입금계좌 안내]로 계좌이체 (v3.2.141: 페이앱 거절 → 계좌이체 + 세금계산서)
//
// 페이지: kanghago-pages.vercel.app/invoice-view.html?mailbox=AP1819
// 데이터: 이 API가 Shipments + Customers + Orders + Products 조인해서 반환.

const { atRequest, atListAll, handleCors, TABLES } = require('./_lib');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  let mailbox = (req.query && req.query.mailbox) || '';
  if (!mailbox) return res.status(400).json({ ok: false, error: 'mailbox 필요 (쿼리 파라미터)' });

  try {
    // 1. Shipments (사서함명 기준)
    const shipUrl = `/${TABLES.Shipments}?filterByFormula=${encodeURIComponent(`{사서함}="${mailbox}"`)}&maxRecords=1`;
    const shipResp = await atRequest('GET', shipUrl);
    let ship = (shipResp.records || [])[0];
    // [v3.2.218] 바레 사서함(날짜접미사 없음) 접두 매칭 폴백 — 정확 매칭 실패 시 "{mailbox}-*" 중 최신 1건(사서함 desc).
    //   ?s=AP1520 → AP1520-260630 등. 계산 로직 불변(사서함 해석만 확장). 정확명이 있으면 항상 그게 우선.
    if (!ship && !/-\d{6}$/.test(mailbox)) {
      const pfx = `${mailbox}-`;
      const pfxUrl = `/${TABLES.Shipments}?filterByFormula=${encodeURIComponent(`LEFT({사서함},${pfx.length})="${pfx}"`)}&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('사서함')}&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`;
      try { const pr = await atRequest('GET', pfxUrl); ship = (pr.records || [])[0]; } catch (e) {}
      if (ship && ship.fields && ship.fields['사서함']) mailbox = ship.fields['사서함'];   // 해석된 전체명으로 갱신
    }
    if (!ship) return res.status(404).json({ ok: false, error: '사서함 없음: ' + mailbox });

    // 2. Customers (사서함번호 기준)
    let customer = null;
    try {
      const baseKey = String(mailbox || '').replace(/-\d{6}$/, '');   // [선적분 키] 복합ID → 고객 사서함(base)
      const custUrl = `/${TABLES.Customers || 'Customers'}?filterByFormula=${encodeURIComponent(`{사서함번호}="${baseKey}"`)}&maxRecords=1`;
      const custResp = await atRequest('GET', custUrl);
      customer = (custResp.records || [])[0] || null;
    } catch (e) { console.warn('[invoice-view] Customers 조회 경고:', e.message); }

    // 3. Orders (Shipment 링크 기준)
    const orderUrl = `/${TABLES.Orders}?filterByFormula=${encodeURIComponent(`SEARCH('${mailbox}',ARRAYJOIN({Shipment}))`)}`;
    const orders = await atListAll(orderUrl);

    // 4. Products (Order 링크 기준)
    const orderIds = new Set(orders.map(o => o.id));
    const allProducts = [];
    if (orders.length > 0) {
      // Order 링크가 record ID라 ARRAYJOIN으로 검색
      // 단순화: Shipment ID 알면 모든 Products 검색 → Order로 필터
      const prodUrl = `/${TABLES.Products}?pageSize=100`;
      const prods = await atListAll(prodUrl);
      prods.forEach(p => {
        const links = (p.fields || {})['Order'] || [];
        if (Array.isArray(links) && links.some(id => orderIds.has(id))) {
          allProducts.push(p);
        }
      });
    }

    // [v3.2.203] 4.5 CostItems (현지 작업비 — 알리코인 사용내역 참고. 청구 합계 미포함)
    let costItems = [];
    try { costItems = await atListAll(`/${TABLES.CostItems || 'CostItems'}?filterByFormula=${encodeURIComponent(`SEARCH('${mailbox}',ARRAYJOIN({Shipment}))`)}`); } catch (e) { costItems = []; }

    // 5. 합계 계산
    const f = ship.fields || {};
    const cf = (customer && customer.fields) || {};
    const rateCnyUsd = parseFloat(f['환율CNY_USD']) || 0.14;
    const rateUsdKrw = parseFloat(f['환율USD_KRW']) || 1350;

    let totalInvoiceKrw = 0;
    const productLines = allProducts.map(p => {
      const pf = p.fields || {};
      const qty = parseFloat(pf['수량']) || 0;
      const unitUsd = parseFloat(pf['단가USD']) || 0;
      const lineKrw = Math.round(unitUsd * qty * rateUsdKrw);
      totalInvoiceKrw += lineKrw;
      return {
        description: pf['Description'] || pf['통관품명_영문'] || pf['상품ID'] || '',
        hs: pf['HS코드'] || '',
        qty,
        unitUsd,
        lineUsd: Math.round(unitUsd * qty * 100) / 100,
        lineKrw,
      };
    });

    // v3.2.18 P0: 물류비 청구서 모델 — 신고가 폴백 폐기.
    //   도구 §12 발행 시 Shipments에 저장된 청구금액_KRW + 6항목 breakdown 사용.
    //   청구금액_KRW = 0/빈값이면 0 (신고가 polluion 금지).
    const totals = {
      claimKrw: parseFloat(f['청구금액_KRW']) || 0,
      preVat: parseFloat(f['청구_preVAT']) || 0,
      vat: parseFloat(f['VAT']) || 0,
      // 참고용 신고가 (FTA 절세 안내 패널만 — 결제 미포함)
      invoiceKrw: totalInvoiceKrw,
      duty: 0,
      vatImport: 0,
      appliedFta: f['적용FTA확정'] || '',
      // v3.2.31: CO 절세 안내 — 도구가 청구서 발행 시 저장
      ftaSavingKrw: parseFloat(f['청구_FTA_절세_KRW']) || 0,
    };
    const breakdown = {
      bl:       parseFloat(f['청구_BL_금액'])       || 0,
      sea:      parseFloat(f['청구_해상운임_금액']) || 0,
      co:       parseFloat(f['청구_CO_금액'])       || 0,
      parcel:   parseFloat(f['청구_택배_금액'])      || 0,
      freight:  parseFloat(f['청구_화물_금액'])      || 0,
      milkrun:  parseFloat(f['청구_밀크런_금액'])    || 0,   // v3.2.38: ⌈CBM/1.5⌉×30,000
      coupang:  parseFloat(f['청구_쿠팡밀크런_금액']) || 0,
      shipMethod: f['배송방식'] || '',
    };
    // [v3.2.200] 알리코인(CNY) 차감 내역 — 도구 §12 발행 시 저장. 한국 결제 아님(정보 표기용).
    const _bl = parseFloat(f['청구_BL_CNY']) || 0;
    const _sea = parseFloat(f['청구_해운비_CNY']) || 0;
    const _co = parseFloat(f['청구_CO_CNY']) || 0;
    const _hd = parseFloat(f['핸들링CNY']) || 0;
    const _dc = parseFloat(f['도큐먼트피CNY']) || 0;
    const _totalCny = parseFloat(f['청구_알리코인_CNY']) || (_bl + _sea + _co + _hd + _dc);
    const _rateCnyKrw = parseFloat(f['환율CNY_KRW']) || (rateCnyUsd * rateUsdKrw);
    // [v3.2.203] 중국 현지 작업비 — CostItems(부대비용·원산지증명 제외). ★신고가 반영분, 청구 합계 미포함(참고).
    const _workItems = []; let _workTotal = 0;
    costItems.forEach(c => {
      const cf2 = c.fields || {}; const memo = cf2['메모'] || ''; const cat = cf2['카테고리'] || '';
      if (memo.includes('[부대비용:') || memo.includes('[원산지증명:') || cat === '부대비용' || cat === '원산지증명') return;
      const mm = memo.match(/수량\s*(\d+(?:\.\d+)?)\s*[×x*]\s*[¥₩\\]?\s*(\d+(?:\.\d+)?)/);
      const qty = mm ? parseFloat(mm[1]) : null, unit = mm ? parseFloat(mm[2]) : null;
      const eq = memo.match(/=\s*¥?\s*(\d+(?:\.\d+)?)\s*CNY/i);
      let cny = 0;
      if (eq) cny = parseFloat(eq[1]);
      else if (mm && /CNY|위안|¥/i.test(memo)) cny = qty * unit;
      else { const krw = parseFloat(cf2['금액KRW']) || 0; cny = _rateCnyKrw > 0 ? krw / _rateCnyKrw : 0; }
      if (!(cny > 0)) return;
      let label = String(cf2['항목명'] || '').trim() || '기타 작업';   // [v3.2.206] 실제 작업명 = 항목명 필드
      if (label.length > 30) label = label.slice(0, 30) + '…';
      _workItems.push({ label, qty, unit, cny: Math.round(cny * 100) / 100 }); _workTotal += cny;
    });
    _workTotal = Math.round(_workTotal * 100) / 100;
    // [v3.2.216] CO 종류/장수 근거 — (영문명,HS10) 고유 조합. 금액은 프리즈된 _co가 진실원, 여기선 표시 근거만 역산.
    const _coTypeSet = new Set();
    allProducts.forEach(p => {
      const pf = p.fields || {};
      if ((parseFloat(pf['수량']) || 0) <= 0) return;
      const nm = String(pf['통관품명_영문'] || pf['Description'] || '').trim().toUpperCase();
      const hs = String(pf['HS코드'] || '').replace(/[^0-9]/g, '');
      if (!nm && !hs) return;
      _coTypeSet.add(nm + '' + hs);
    });
    const _coTypes = _coTypeSet.size;
    const _coSheets = _co > 0 ? Math.max(1, Math.ceil(_coTypes / 13)) : 0;
    const _coAddCny = _co > 0 ? (_coSheets - 1) * 70 : 0;
    const _coBase = _co > 0 ? _co - _coAddCny : 0;
    const alicoin = {
      blCny: _bl, seaCny: _sea, coCny: _co, handlingCny: _hd, documentCny: _dc,
      coTypes: _coTypes, coSheets: _coSheets, coBase: _coBase, coAddCny: _coAddCny,
      workfeeCny: _hd + _dc, totalCny: _totalCny, krwRef: Math.round(_totalCny * _rateCnyKrw),
      localWorkCny: _workTotal, localWorkItems: _workItems,   // [v3.2.203] 현지 작업비(참고)
      grandUseCny: Math.round((_totalCny + _workTotal) * 100) / 100,   // 알리코인 총 사용(서비스+현지작업비)
    };
    // [v3.2.139] 발행주체 = 주식회사 테일코리아(단일 진실원). 통합 청구 URL(invoice-view)의 발행주체·입금계좌.
    const issuer = {
      name: '주식회사 테일코리아',
      biz: '162-86-01960',
      addr: '인천시 서구 북항로 207번길 55',
      tel: '010-3622-7995',
      email: 'admin@talekorea.com',
      bank: '하나은행 121-910031-58704',
      bankHolder: '예금주 주식회사 테일코리아',
    };

    // [v3.2.224] 배차요청서 링크 — delivery-request는 ship+t(고객토큰) 필수. ★토큰 없음/만료면 발급·저장(재사용)해 배차링크가 항상 유효.
    //   (§9 청구서 URL은 토큰을 안 만들어서, 토큰 없는 사서함은 배차버튼이 "잘못된 접근"이 됐음 — v3.2.224 근본수정.)
    //   ★교차접근 차단 불변: 토큰은 사서함별 고유, delivery-request가 그 사서함 토큰과 대조(다른 사서함 토큰=401). validateDeliveryToken 무변경.
    let deliveryUrl = null;
    try {
      let _tok = String(f['고객토큰'] || '').trim();
      const _exp = f['고객토큰만료일'];
      const _notExpired = !_exp || (new Date(_exp) >= new Date(new Date().toISOString().slice(0, 10)));
      let _valid = _tok.length >= 16 && _notExpired;
      if (!_valid) {
        _tok = require('crypto').randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
        const _newExp = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        try {
          await atRequest('PATCH', `/${TABLES.Shipments}/${ship.id}`, { fields: { '고객토큰': _tok, '고객토큰만료일': _newExp }, typecast: true });
          _valid = true;
        } catch (e) { _valid = false; }   // 발급 실패 시 버튼은 프런트에서 비활성 처리
      }
      if (_valid) {
        deliveryUrl = `https://kanghago-pages.vercel.app/delivery-request.html?ship=${ship.id}&t=${encodeURIComponent(_tok)}`;
      }
    } catch (e) { deliveryUrl = null; }

    return res.status(200).json({
      ok: true,
      shipment: {
        id: ship.id,
        mailbox,
        bondedWarehouse: f['보세창고'] || '',   // [v3.2.219] ④배차 출발지(동적)
        deliveryAddr: f['수취_주소'] || '',      // [v3.2.219] ④배차 도착지(고객 입력 주소·앞부분만 표시)
        status: f['상태'] || '',
        shipDate: f['출고요청일'] || '',
        blNo: f['BL번호'] || '',
        forwarder: f['포워딩사'] || '',
        issueDate: f['청구서발행일시'] || '',
        deliveryUrl,   // [v3.2.212] 배차요청서 링크(토큰 임베드·완성 URL) or null
        rateCnyUsd, rateUsdKrw,
      },
      customer: cf ? {
        name: cf['회원명'] || '',
        company: cf['회사명'] || '',
        bizNo: cf['사업자번호'] || '',
        phone: cf['연락처'] || '',
        address: cf['주소'] || '',
      } : null,
      orders: orders.map(o => ({ id: o.id, no: (o.fields || {})['주문번호'] || '' })),
      // products 배열은 참고용으로만 유지 (UI에서 미렌더, 빈배열도 OK)
      products: [],
      totals,
      breakdown,
      alicoin,   // [v3.2.200] 알리코인(CNY) 차감 내역 — 정보 표기(한국 결제 아님)
      issuer,   // [v3.2.139] 발행주체 = 주식회사 테일코리아 + 하나은행 계좌
      // [v3.2.141] 페이앱 영구 거절 → 결제수단 = 계좌이체 + 세금계산서. payappUrl/Status/Amount 제거.
      //   입금 확인 = Shipments.입금완료일시(§13 입금 매칭에서 기록) → 페이지 "입금 확인 완료" 표시.
      paidInAt: f['입금완료일시'] || '',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[invoice-view]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
