// ---------- Cardápio ----------
const parseG = raw => { try { const x = JSON.parse(raw || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
const IMG_STYLE = 'width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--line)';
async function moveItem(type, list, i, d) {
  const ids = list.map(x => x.id); const j = i + d;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await api('/reorder', 'POST', { type, ids });
  viewMenu();
}
async function viewMenu() {
  const m = await api('/menu'); const v = $('view'); if (!v) return;
  let editing = null, groups = [], draft = {};
  const form = h('div', { class: 'card' });
  const catName = p => (m.categories.find(c => c.id === p.category_id) || {}).name || '';
  const lerDraft = () => ({ ...draft,
    name: $('p_name') ? $('p_name').value : draft.name, price: $('p_price') ? $('p_price').value : draft.price,
    description: $('p_desc') ? $('p_desc').value : draft.description, category_id: $('p_cat') ? $('p_cat').value : draft.category_id,
    image_url: $('p_img') ? $('p_img').value : draft.image_url });

  function drawGroups() {
    return h('div', {}, groups.map((g, gi) => h('div', { class: 'card', style: 'background:var(--bg);margin:10px 0' },
      h('div', { class: 'row' }, h('b', {}, 'Grupo ' + (gi + 1)), h('button', { class: 'btn r s', onclick: () => { draft = lerDraft(); groups.splice(gi, 1); drawForm(true); } }, 'Remover grupo')),
      h('div', { class: 'grid' },
        h('div', {}, h('label', {}, 'Nome do grupo (ex.: Adicionais, Escolha a bebida)'), h('input', { value: g.name, oninput: e => { g.name = e.target.value; } })),
        h('div', { class: 'grid' },
          h('div', {}, h('label', {}, 'Mínimo de escolhas'), h('input', { inputmode: 'numeric', value: String(g.min), oninput: e => { g.min = Number(e.target.value) || 0; } })),
          h('div', {}, h('label', {}, 'Máximo de escolhas'), h('input', { inputmode: 'numeric', value: String(g.max), oninput: e => { g.max = Number(e.target.value) || 1; } })))),
      g.items.map((it, ii) => h('div', { class: 'row', style: 'margin:6px 0;flex-wrap:nowrap' },
        h('input', { value: it.name, placeholder: 'Ex.: Bacon', style: 'flex:2;min-width:0', oninput: e => { it.name = e.target.value; } }),
        h('input', { value: it.price ? String(it.price).replace('.', ',') : '', placeholder: 'R$ 0', inputmode: 'decimal', style: 'flex:1;min-width:0', oninput: e => { it.price = Number(String(e.target.value).replace(',', '.')) || 0; } }),
        h('button', { class: 'btn g s', onclick: () => { draft = lerDraft(); g.items.splice(ii, 1); drawForm(true); } }, '✕'))),
      h('button', { class: 'btn g s', style: 'margin-top:6px', onclick: () => { draft = lerDraft(); g.items.push({ name: '', price: 0 }); drawForm(true); } }, '+ Opção'))));
  }

  function fotoChange(e) {
    const f = e.target.files[0]; if (!f) return;
    $('p_err').textContent = 'Enviando foto...';
    (async () => {
      try {
        const r = await api('/upload', 'POST', { data: await comprimirFoto(f) });
        $('p_img').value = r.url;
        $('p_prev').replaceWith(h('img', { id: 'p_prev', src: r.url, alt: '', style: IMG_STYLE }));
        $('p_err').textContent = 'Foto enviada. Agora salve o produto.';
      } catch (err) { $('p_err').textContent = err.message || 'Não consegui enviar a foto.'; }
    })();
  }

  function drawForm(fresh) {
    if (!fresh && $('p_name')) draft = lerDraft();
    const p = draft;
    form.replaceChildren(h('b', {}, editing ? 'Editar produto' : 'Novo produto'),
      h('div', { class: 'grid' },
        h('div', {}, h('label', {}, 'Nome'), h('input', { id: 'p_name', value: p.name || '' })),
        h('div', {}, h('label', {}, 'Preço (R$)'), h('input', { id: 'p_price', inputmode: 'decimal', value: p.price != null && p.price !== '' ? String(p.price).replace('.', ',') : '' }))),
      h('label', {}, 'Descrição (ingredientes)'), h('input', { id: 'p_desc', value: p.description || '' }),
      h('div', { class: 'grid' },
        h('div', {}, h('label', {}, 'Categoria'), h('select', { id: 'p_cat' }, h('option', { value: '' }, 'Sem categoria'), m.categories.map(c => h('option', { value: c.id, selected: String(c.id) === String(p.category_id) }, c.name)))),
        h('div', {}, h('label', {}, 'Foto do produto'),
          h('div', { class: 'row', style: 'justify-content:flex-start' },
            p.image_url ? h('img', { id: 'p_prev', src: p.image_url, alt: '', style: IMG_STYLE }) : h('span', { id: 'p_prev', class: 'muted' }, 'sem foto'),
            h('label', { class: 'btn g s', style: 'cursor:pointer' }, 'Escolher da galeria', h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: fotoChange }))))),
      h('input', { id: 'p_img', type: 'hidden', value: p.image_url || '' }),
      h('h3', { style: 'margin:16px 0 0' }, 'Adicionais e combos'),
      h('p', { class: 'muted', style: 'margin:4px 0' }, 'Crie um grupo para cada escolha. Adicionais: "Adicionais", mínimo 0, máximo 3, com Bacon +R$ 4 e Cream cheese +R$ 3. Combo: "Escolha a bebida", mínimo 1, máximo 1, com as bebidas e preço zero.'),
      drawGroups(),
      h('button', { class: 'btn g s', onclick: () => { draft = lerDraft(); groups.push({ name: '', min: 0, max: 1, items: [] }); drawForm(true); } }, '+ Adicionar grupo'),
      h('div', { class: 'msg err', id: 'p_err' }),
      h('div', { class: 'row', style: 'justify-content:flex-start;margin-top:10px' },
        h('button', { class: 'btn', onclick: saveProduct }, editing ? 'Salvar produto' : 'Adicionar produto'),
        editing ? h('button', { class: 'btn g', onclick: () => { editing = null; draft = {}; groups = []; drawForm(true); } }, 'Cancelar') : null));
  }

  async function saveProduct() {
    const d = lerDraft();
    const body = { name: d.name, price: d.price, description: d.description, category_id: d.category_id, image_url: d.image_url,
      active: editing ? editing.active : 1,
      groups: groups.filter(g => String(g.name).trim()).map(g => ({ name: g.name, min: g.min, max: g.max, items: g.items.filter(x => String(x.name).trim()) })) };
    try { editing ? await api('/products/' + editing.id, 'PUT', body) : await api('/products', 'POST', body); viewMenu(); }
    catch (e) { $('p_err').textContent = e.message; }
  }

  const cats = m.categories, prods = m.products;
  draft = {}; drawForm(true);
  v.replaceChildren(
    h('div', { class: 'card' }, h('b', {}, 'Categorias (a ordem é a que aparece pro cliente)'),
      h('div', { class: 'row', style: 'margin:8px 0' }, h('input', { id: 'c_name', placeholder: 'Ex: Lanches, Bebidas, Sobremesas' }),
        h('button', { class: 'btn', onclick: async () => { const n = $('c_name').value.trim(); if (n) { await api('/categories', 'POST', { name: n }); viewMenu(); } } }, 'Criar')),
      cats.map((c, i) => h('div', { class: 'row', style: 'margin:6px 0;flex-wrap:nowrap' }, h('span', { style: 'flex:1;min-width:0' }, c.name),
        h('button', { class: 'btn g s', disabled: i === 0, onclick: () => moveItem('categories', cats, i, -1) }, '▲'),
        h('button', { class: 'btn g s', disabled: i === cats.length - 1, onclick: () => moveItem('categories', cats, i, 1) }, '▼'),
        h('button', { class: 'btn r s', onclick: async () => { if (confirm('Excluir a categoria "' + c.name + '"? Os produtos ficam sem categoria.')) { await api('/categories/' + c.id, 'DELETE'); viewMenu(); } } }, 'Excluir')))),
    form,
    h('h2', { style: 'font-size:17px' }, 'Produtos (' + prods.length + ')'),
    ...prods.map((p, i) => h('div', { class: 'card row', style: p.active ? '' : 'opacity:.55' },
      h('div', { class: 'row', style: 'flex:1;min-width:0' },
        p.image_url ? h('img', { src: p.image_url, alt: '', style: 'width:48px;height:48px;object-fit:cover;border-radius:8px;flex:none' }) : null,
        h('div', { style: 'min-width:0' }, h('b', {}, p.name),
          h('div', { class: 'muted' }, brl(p.price) + (catName(p) ? ' · ' + catName(p) : '') + (parseG(p.groups_json).length ? ' · ' + parseG(p.groups_json).length + ' grupo(s)' : '') + (p.active ? '' : ' · PAUSADO')))),
      h('div', { class: 'row' },
        h('button', { class: 'btn g s', disabled: i === 0, onclick: () => moveItem('products', prods, i, -1) }, '▲'),
        h('button', { class: 'btn g s', disabled: i === prods.length - 1, onclick: () => moveItem('products', prods, i, 1) }, '▼'),
        h('button', { class: 'btn g s', onclick: () => { editing = p; draft = { ...p }; groups = parseG(p.groups_json); drawForm(true); form.scrollIntoView({ behavior: 'smooth' }); } }, 'Editar'),
        h('button', { class: 'btn g s', onclick: async () => { await api('/products/' + p.id, 'PUT', { ...p, groups: parseG(p.groups_json), active: p.active ? 0 : 1 }); viewMenu(); } }, p.active ? 'Pausar' : 'Ativar'),
        h('button', { class: 'btn r s', onclick: async () => { if (confirm('Excluir "' + p.name + '"?')) { await api('/products/' + p.id, 'DELETE'); viewMenu(); } } }, 'Excluir')))));
}

// ---------- Configurações ----------
function viewConfig() {
  const v = $('view'), s = me;
  const hours = (() => { try { const x = JSON.parse(s.hours || 'null'); return Array.isArray(x) ? x : []; } catch { return []; } })();
  const kmFees = (() => { try { const x = typeof s.km_fees === 'string' ? JSON.parse(s.km_fees || 'null') : s.km_fees; return Array.isArray(x) ? x : []; } catch { return []; } })();
  const chk = (id, label, val) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', id, checked: !!val }), label);
  put(v, h('div', { class: 'card' },
    h('div', { class: 'grid' },
      h('div', {}, h('label', {}, 'Nome da loja'), h('input', { id: 's_name', value: s.name })),
      h('div', {}, h('label', {}, 'WhatsApp'), h('input', { id: 's_wa', value: s.whatsapp })),
      h('div', {}, h('label', {}, 'Endereço'), h('input', { id: 's_addr', value: s.address })),
      h('div', {}, h('label', {}, 'Cidade'), h('input', { id: 's_city', value: s.city })),
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
    h('h3', { style: 'margin:18px 0 0' }, 'Horário de funcionamento'),
    h('p', { class: 'muted', style: 'margin:4px 0' }, 'Sem horário, a loja fica aberta enquanto o botão "Loja aberta" estiver marcado. Com horário, ela abre e fecha sozinha.'),
    ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'].map((dia, i) => h('div', { class: 'row', style: 'margin:6px 0;flex-wrap:wrap' },
      h('label', { class: 'chk', style: 'margin:0;width:110px' }, h('input', { type: 'checkbox', id: 'h_on' + i, checked: !!(hours[i] && hours[i].on) }), dia),
      h('input', { type: 'time', id: 'h_o' + i, value: (hours[i] && hours[i].open) || '08:00', style: 'width:auto' }),
      h('span', {}, 'às'),
      h('input', { type: 'time', id: 'h_c' + i, value: (hours[i] && hours[i].close) || '22:00', style: 'width:auto' }))),
    h('div', { class: 'grid', style: 'margin-top:10px' },
      h('div', {}, h('label', {}, 'Tempo de preparo (ex.: 30-40 min)'), h('input', { id: 's_prep', value: s.prep_time || '' })),
      h('div', {}, h('label', {}, 'Aviso para o cliente (opcional)'), h('input', { id: 's_notice', value: s.store_notice || '', placeholder: 'Ex.: Estamos com fila, pedidos podem demorar' }))),
    h('h3', { style: 'margin:18px 0 0' }, 'Taxa de entrega por km'),
    h('p', { class: 'muted', style: 'margin:4px 0' }, 'Distância em linha reta, do endereço da loja ao do cliente. Deixe em branco os km em que você não entrega. Salve o endereço da loja acima para o cálculo funcionar.'),
    h('div', { class: 'grid' }, Array.from({ length: 15 }, (_, i) => h('div', {}, h('label', {}, (i + 1) + ' km'), h('input', { id: 's_km' + (i + 1), inputmode: 'decimal', value: kmFees[i] == null ? '' : String(kmFees[i]).replace('.', ','), placeholder: 'R$' })))),
    h('div', { class: 'msg', id: 's_msg' }),
    h('button', { class: 'btn', onclick: async () => {
      const g = id => $(id).value, c = id => $(id).checked;
      try {
        const saved = await api('/me', 'PUT', { name: g('s_name'), whatsapp: g('s_wa'), address: g('s_addr'), city: g('s_city'), min_order: g('s_min'), is_open: c('s_open'),
          accepts_pix: c('s_pix'), pix_key: g('s_pixkey'), pix_name: g('s_pixname'), accepts_cash: c('s_cash'), accepts_card_delivery: c('s_card'), accepts_link: c('s_link'), payment_link: g('s_linkurl'), prep_time: g('s_prep'), store_notice: g('s_notice'), hours: Array.from({ length: 7 }, (_, i) => ({ on: c('h_on' + i), open: g('h_o' + i), close: g('h_c' + i) })), km_fees: Array.from({ length: 15 }, (_, i) => g('s_km' + (i + 1))) });
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

// Reduz a foto no celular antes de enviar (lado máximo 900 px, JPEG)
async function comprimirFoto(file) {
  const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(file); });
  const k = Math.min(1, 900 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
