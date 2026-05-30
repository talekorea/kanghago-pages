// 청구서 + 결제 통합 페이지 데이터 프록시 — v3.2.3 Phase (2026-05-30)
//
// GET /api/invoice-view?mailbox=AP1819
//   returns: { shipment, customer, orders, products, totals, payappUrl, generatedAt }
//
// 사장님 통찰: "PDF 든 html 이든 페이지 하나를 만들어서 그 양식 하단에 결제하기 버튼이 존재하는것이 맞다"
//   1. 직원이 도구에서 [청구서 생성] 클릭 → 통합 페이지 URL 한 개로 카톡 발송
//   2. 고객이 페이지 열어 청구 내역 보고 하단 [결제하기] 클릭 → 페이앱 결제창
//
// 페이지: kanghago-pages.vercel.app/invoice-view.html?mailbox=AP1819
// 데이터: 이 API가 Shipments + Customers + Orders + Products 조인해서 반환.

const { atRequest, atListAll, handleCors, TABLES } = require('./_lib');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  const mailbox = (req.query && req.query.mailbox) || '';
  if (!mailbox) return res.status(400).json({ ok: false, error: 'mailbox 필요 (쿼리 파라미터)' });

  try {
    // 1. Shipments (사서함명 기준)
    const shipUrl = `/${TABLES.Shipments}?filterByFormula=${encodeURIComponent(`{사서함}="${mailbox}"`)}&maxRecords=1`;
    const shipResp = await atRequest('GET', shipUrl);
    const ship = (shipResp.records || [])[0];
    if (!ship) return res.status(404).json({ ok: false, error: '사서함 없음: ' + mailbox });

    // 2. Customers (사서함번호 기준)
    let customer = null;
    try {
      const custUrl = `/${TABLES.Customers || 'Customers'}?filterByFormula=${encodeURIComponent(`{사서함번호}="${mailbox}"`)}&maxRecords=1`;
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
      duty: 0,        // 도구 §9 FTA 절세 안내 산식 — 도구가 계산해 저장하면 사용
      vatImport: 0,
      appliedFta: f['적용FTA확정'] || '',
    };
    const breakdown = {
      bl:       parseFloat(f['청구_BL_금액'])       || 0,
      sea:      parseFloat(f['청구_해상운임_금액']) || 0,
      co:       parseFloat(f['청구_CO_금액'])       || 0,
      parcel:   parseFloat(f['청구_택배_금액'])      || 0,
      freight:  parseFloat(f['청구_화물_금액'])      || 0,
      coupang:  parseFloat(f['청구_쿠팡밀크런_금액']) || 0,
    };

    return res.status(200).json({
      ok: true,
      shipment: {
        id: ship.id,
        mailbox,
        status: f['상태'] || '',
        shipDate: f['출고요청일'] || '',
        blNo: f['BL번호'] || '',
        forwarder: f['포워딩사'] || '',
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
      payappUrl: f['페이앱_결제URL'] || '',
      payappStatus: f['페이앱_결제상태'] || '',
      payappAmount: parseFloat(f['페이앱_요청금액']) || 0,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[invoice-view]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
