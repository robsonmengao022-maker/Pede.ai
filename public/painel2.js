// ---------- Cardápio ----------
async function viewMenu() {
  const m = await api('/menu'); const v = $('view'); if (!v) return;
  let editing = null;
  const form = h('div', { class: 'card' });
  function drawForm() {
    const p = editing || {};
    form.replaceChildren(h('b', {}, editing ? 'Editar produto' : 'Novo produto'),
      h('div', { class: 'grid' },
        h('div', {}, h('label', {}, 'Nome'), h('input', { id: 'p_name', value: p.name || '' })),
        h('div', {}, h('label', {}, 'Preço (R$)'), h('input', { id: 'p_price', inputmode: 'decimal', value: p.price != null ? String(p.price).replace('.', ',') : '' }))),
      h('label', {}, 'Descrição (opcional)'), h('input', { id: 'p_desc', value: p.description || '' }),
      h('div', { class: 'grid' },
        h('div', {}, h('label', {}, 'Categoria'), h('select', { id: 'p_cat' }, h('option', { value: '' }, 'Sem categoria'), m.categories.map(c => h('option', { value: c.id, selected: c.id === p.category_id }, c.name)))),
        h('div', {}, h('label', {}, 'Link da foto (opcional)'), h('input', { id: 'p_img', placeholder: 'https://...', value: p.image_url || '' }))),
      h('div', { class: 'msg err', id: 'p_err' }),
      h('div', { class: 'row', style: 'justify-content:flex-start' },
        h('button', { class: 'btn', onclick: async () => {
          const body = { name: $('p_name').value, price: $('p_price').value, description: $('p_desc').value, category_id: $('p_cat').value, image_url: $('p_img').value, active: editing ? editing.active : 1 };
          try { editing ? await api('/products/' + editing.id, 'PUT', body) : await api('/products', 'POST', body); viewMenu(); } catch (e) { $('p_err').textContent = e.message; }
        } }, editing ? 'Salvar' : 'Adicionar produto'),
        editing ? h('button', { class: 'btn g', onclick: () => { editing = null; drawForm(); } }, 'Cancelar') : null));
  }
  drawForm();
  put(v, 
    h('div', { class: 'card' }, h('b', {}, 'Categorias'),
      h('div', { class: 'row', style: 'margin:8px 0' }, h('input', { id: 'c_name', placeholder: 'Ex: Lanches, Bebidas, Sobremesas' }), h('button', { class: 'btn', onclick: async () => { if ($('c_name').value.trim()) { await api('/categories', 'POST', { name: $('c_name').value }); viewMenu(); } } }, 'Criar')),
      h('div', {}, m.categories.map(c => h('span', { class: 'tag', style: 'margin-right:6px;display:inline-block;margin-bottom:6px' }, c.name + ' ', h('a', { href: '#', title: 'Excluir', onclick: async e => { e.preventDefault(); if (confirm('Excluir categoria "' + c.name + '"? Os produtos ficam sem categoria.')) { await api('/categories/' + c.id, 'DELETE'); viewMenu(); } } }, '✕'))))),
    form,
    h('h2', { style: 'font-size:17px' }, 'Produtos (' + m.products.length + ')'),
    m.products.map(p => h('div', { class: 'card row', style: p.active ? '' : 'opacity:.55' },
      h('div', {}, h('b', {}, p.name), h('div', { class: 'muted' }, brl(p.price) + (p.category_id ? ' · ' + (m.categories.find(c => c.id === p.category_id)?.name || '') : '') + (p.active ? '' : ' · PAUSADO'))),
      h('div', { class: 'row' },
        h('button', { class: 'btn g s', onclick: () => { editing = p; drawForm(); form.scrollIntoView({ behavior: 'smooth' }); } }, 'Editar'),
        h('button', { class: 'btn g s', onclick: async () => { await api('/products/' + p.id, 'PUT', { ...p, active: p.active ? 0 : 1 }); viewMenu(); } }, p.active ? 'Pausar' : 'Ativar'),
        h('button', { class: 'btn r s', onclick: async () => { if (confirm('Excluir "' + p.name + '"?')) { await api('/products/' + p.id, 'DELETE'); viewMenu(); } } }, 'Excluir')))));
}

// ---------- Configurações ----------
function viewConfig() {
  const v = $('view'), s = me;
  const kmFees = (() => { try { const x = typeof s.km_fees === 'string' ? JSON.parse(s.km_fees || 'null') : s.km_fees; return Array.isArray(x) ? x : []; } catch { return []; } })();
  const chk = (id, label, val) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', id, checked: !!val }), label);
  put(v, h('div', { class: 'card' },
    h('div', { class: 'grid' },
      h('div', {}, h('label', {}, 'Nome da loja'), h('input', { id: 's_name', value: s.name })),
      h('div', {}, h('label', {}, 'WhatsApp'), h('input', { id: 's_wa', value: s.whatsapp })),
      h('div', {}, h('label', {}, 'Endereço'), h('input', { id: 's_addr', value: s.address })),
      h('div', {}, h('label', {}, 'Cidade'), h('input', { id: 's_city', value: s.city })),
      h('div', {}, h('label', {}, 'Taxa de entrega (R$)'), h('input', { id: 's_fee', inputmode: 'decimal', value: String(s.delivery_fee).replace('.', ',') })),
      h('div', {}, h('label', {}, 'Pedido mínimo (R$)'), h('input', { id: 's_min', inputmode: 'decimal', value: String(s.min_order).replace('.', ',') }))),
    chk('s_open', 'Loja aberta (aceitando pedidos)', s.is_open),
    h('h3', { style: 'margin:18px 0 0' }, 'Formas de pagamento'),
    h('p', { class: 'muted', style: 'margin:4px 0' }, 'O dinheiro de Pix e cartão cai direto na SUA conta. A Pedeaí não recebe nem segura nenhum valor das suas vendas.'),
    chk('s_pix', 'Aceitar Pix', s.accepts_pix),
    h('div', { class: 'grid' }, h('div', {}, h('label', {}, 'Sua chave Pix'), h('input', { id: 's_pixkey', value: s.pix_key, placeholder: 'CPF, CNPJ, e-mail, telefone ou chave aleatória' })),
      h('div', {}, h('label', {}, 'Nome do recebedor (como no banco)'), h('input', { id: 's_pixname', value: s.pix_name }))),
    chk('s_cash', 'Aceitar dinheiro na entrega', s.accepts_cash),
    chk('s_card', 'Aceitar cartão na maquininha (na entrega)', s.accepts_card_delivery),
    chk('s_link', 'Aceitar cartão online por link de pagamento (Mercado Pago, InfinitePay, etc.)', s.accepts_link),
    h('label', {}, 'Seu link de pagamento'), h('input', { id: 's_linkurl', value: s.payment_link, placeholder: 'https://...' }),
    h('h3', { style: 'margin:18px 0 0' }, 'Taxa de entrega por km'),
    h('p', { class: 'muted', style: 'margin:4px 0' }, 'Distância em linha reta, do endereço da loja ao do cliente. Deixe em branco os km em que você não entrega. Salve o endereço da loja acima para o cálculo funcionar.'),
    h('div', { class: 'grid' }, Array.from({ length: 15 }, (_, i) => h('div', {}, h('label', {}, (i + 1) + ' km'), h('input', { id: 's_km' + (i + 1), inputmode: 'decimal', value: kmFees[i] == null ? '' : String(kmFees[i]).replace('.', ','), placeholder: 'R$' })))),
    h('div', { class: 'msg', id: 's_msg' }),
    h('button', { class: 'btn', onclick: async () => {
      const g = id => $(id).value, c = id => $(id).checked;
      try {
        const saved = await api('/me', 'PUT', { name: g('s_name'), whatsapp: g('s_wa'), address: g('s_addr'), city: g('s_city'), delivery_fee: g('s_fee'), min_order: g('s_min'), is_open: c('s_open'),
          accepts_pix: c('s_pix'), pix_key: g('s_pixkey'), pix_name: g('s_pixname'), accepts_cash: c('s_cash'), accepts_card_delivery: c('s_card'), accepts_link: c('s_link'), payment_link: g('s_linkurl'), km_fees: Array.from({ length: 15 }, (_, i) => g('s_km' + (i + 1))) });
        me = await api('/me'); $('s_msg').className = saved.warning ? 'msg err' : 'msg ok'; $('s_msg').textContent = saved.warning || 'Salvo!';
      } catch (e) { $('s_msg').className = 'msg err'; $('s_msg').textContent = e.message; }
    } }, 'Salvar configurações')));
}

// ---------- Mensalidade ----------
async function viewBilling() {
  const b = await api('/billing'); const v = $('view'); if (!v) return;
  const t = b.tiers, pct = Math.min(100, b.revenue / t.midUpTo * 100);
  put(v, h('div', { class: 'card' },
    h('div', { class: 'muted' }, 'Vendas deste mês (' + b.month + ')'), h('div', { style: 'font-size:28px;font-weight:700' }, brl(b.revenue)),
    h('div', { class: 'muted' }, b.orders + ' pedidos (cancelados não contam)'),
    h('div', { class: 'bar' }, h('i', { style: 'width:' + pct + '%' })),
    h('div', {}, 'Mensalidade do mês: ', h('b', {}, b.fee ? brl(b.fee) : 'R$ 0,00 — grátis 🎉')),
    b.next ? h('p', { class: 'muted' }, 'Se passar de ' + brl(b.next.at) + ' em vendas, a mensalidade vai para ' + brl(b.next.fee) + '.') : null),
    h('div', { class: 'card' }, h('b', {}, 'Como funciona'),
      h('div', { class: 'tier' + (b.fee === 0 ? ' cur' : '') }, h('span', {}, 'Até ' + brl(t.freeUpTo) + ' em vendas no mês'), h('span', {}, 'Grátis')),
      h('div', { class: 'tier' + (b.fee === t.midFee ? ' cur' : '') }, h('span', {}, 'De ' + brl(t.freeUpTo) + ' a ' + brl(t.midUpTo)), h('span', {}, brl(t.midFee))),
      h('div', { class: 'tier' + (b.fee === t.topFee ? ' cur' : '') }, h('span', {}, 'Acima de ' + brl(t.midUpTo)), h('span', {}, brl(t.topFee)))));
}
start();
