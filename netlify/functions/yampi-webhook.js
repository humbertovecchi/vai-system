const https = require('https');

const SUPABASE_URL = 'https://cfbnqvznkmpihojwkgek.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmYm5xdnpua21waWhvandrZ2VrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTM2ODA3NSwiZXhwIjoyMDk0OTQ0MDc1fQ.U6eD2Az3ltWBgD4pRbDY5ZWBg749dbvU8drC6TTVFak';

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : '',
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Yampi envia pedidos pagos — verificar evento
  const eventType = payload.event || '';
  const isPaid =
    eventType.includes('paid') ||
    eventType.includes('aprovado') ||
    eventType.includes('payment') ||
    payload.data?.status?.alias === 'paid' ||
    payload.data?.status?.alias === 'approved';

  if (!isPaid) {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, event: eventType }) };
  }

  const order = payload.data || payload;
  const orderId = order.id || order.number || Date.now();
  const orderNumber = order.number || order.id || '?';

  const rawName = order.customer?.name || order.buyer?.name || 'Cliente';
  const customerName = rawName
    .toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const totalRaw = order.total || order.value || order.amount || 0;
  const total = Math.round(parseFloat(String(totalRaw).replace(',', '.')) * 100) / 100 || 0;

  const paidAtRaw = order.paid_at || order.approved_at || order.created_at || new Date().toISOString();
  const dueDate = paidAtRaw.slice(0, 10);

  // Ler all_data atual do Supabase
  const read = await supabaseRequest('GET', '/rest/v1/vai_data?select=value&key=eq.all_data');
  if (read.status !== 200 || !read.body?.length) {
    return { statusCode: 500, body: 'Erro ao ler dados do Supabase' };
  }

  const allData = read.body[0].value;

  // Verificar se pedido já foi importado
  const txs = allData.txs || [];
  const alreadyExists = txs.some(t => t.yampiId === String(orderId));
  if (alreadyExists) {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'already imported' }) };
  }

  // Criar novo lançamento
  const maxId = txs.reduce((m, t) => Math.max(m, t.id || 0), 0);
  const newTx = {
    id: maxId + 1,
    name: `Yampi #${orderNumber} — ${customerName}`,
    type: 'receber',
    cat: 'Vendas E-commerce',
    co: 'nf',
    courseId: null,
    status: 'pago',
    due: dueDate,
    val: total,
    notes: `Pedido Yampi #${orderNumber}`,
    yampiId: String(orderId),
  };

  allData.txs = [...txs, newTx];
  if (allData.txNid <= newTx.id) allData.txNid = newTx.id + 1;

  // Salvar de volta
  const write = await supabaseRequest('POST', '/rest/v1/vai_data', {
    key: 'all_data',
    value: allData,
    updated_at: new Date().toISOString(),
  });

  if (write.status >= 300) {
    return { statusCode: 500, body: `Erro ao salvar: ${JSON.stringify(write.body)}` };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, txId: newTx.id, order: orderNumber }),
  };
};
