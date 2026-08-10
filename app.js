/* ============================================================
   CAROL PACHECO CONFEITARIA — app.js
   Front-end puro (vanilla JS) plugado no backend Supabase
   que o Lovable já gerou (ver README do projeto Lovable
   para nomes exatos de tabelas/funções).

   >>> PREENCHA AQUI antes de publicar <<<
   ============================================================ */

const SUPABASE_URL = "https://abloylbzwwrkbvilswdi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_qnc45c1a9x4iuRrihggHVQ_maw0qLKp";
const WHATSAPP_NUMBER = "5541991949877"; // formato: 55 + DDD + número, só dígitos

// URL pública do backend Lovable publicado (SEM barra no final).
// É de lá que vem o endpoint de pagamento /api/public/create-mercadopago-preference.
// Pendente: só preencher quando o Mercado Pago estiver configurado (token adicionado
// em Secrets no Lovable). Até lá, deixe como null — o checkout funciona normalmente
// até a etapa de pagamento, que fica registrada como pendente.
window.APP_BACKEND_ORIGIN = "https://carolpacheco-backend.lovable.app";

/* ------------------------------------------------------------
   Nada abaixo desta linha deveria precisar de edição manual —
   tudo é dirigido pelos dados que vierem do Supabase.
   ------------------------------------------------------------ */

const supabaseClient = (window.supabase && SUPABASE_URL.startsWith("http"))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (!window.supabase){
  console.error('[Carol Pacheco] Biblioteca @supabase/supabase-js não carregou. Verifique a tag <script> do CDN no <head> do index.html e sua conexão com a internet.');
} else if (!supabaseClient){
  console.error('[Carol Pacheco] SUPABASE_URL parece inválida:', SUPABASE_URL);
} else {
  console.log('[Carol Pacheco] Supabase client inicializado com sucesso.');
}

const state = {
  products: [],
  storeOpen: null,       // null = ainda não sabemos
  cart: [],               // [{product_id, variation_id, variation_name, name, unit_price, qty, image_url}]
  pendingProduct: null,   // produto aguardando escolha de variação
};

/* ---------------- Utilidades ---------------- */
function formatBRL(value){
  return value.toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
}
function onlyDigits(str){ return (str || '').replace(/\D/g, ''); }

function isValidCPF(cpf){
  cpf = onlyDigits(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let rev = (sum * 10) % 11;
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  rev = (sum * 10) % 11;
  if (rev === 10 || rev === 11) rev = 0;
  return rev === parseInt(cpf[10]);
}

function maskCPF(value){
  return onlyDigits(value).slice(0,11)
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}
function maskPhone(value){
  const d = onlyDigits(value).slice(0,11);
  if (d.length <= 10) return d.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3').trim();
  return d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3').trim();
}

/* ---------------- Header on scroll ---------------- */
const header = document.getElementById('siteHeader');
window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 40);
});

/* ============================================================
   STATUS DA LOJA (aberta / fechada)
   Fonte de verdade: função get_store_status() no Supabase,
   que já cruza o toggle manual com o horário de funcionamento.
   ============================================================ */
async function loadStoreStatus(){
  const pill = document.getElementById('storePill');
  const pillText = document.getElementById('storePillText');
  const closedBanner = document.getElementById('closedBanner');

  if (!supabaseClient){
    // Sem credenciais configuradas ainda — modo demonstração
    state.storeOpen = true;
    pillText.textContent = 'Aberto agora';
    return;
  }

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Tempo de resposta excedido (10s).')), 10000)
  );

  try{
    const { data, error } = await Promise.race([supabaseClient.rpc('get_store_status'), timeout]);
    if (error) throw error;

    // Espera-se algo como { is_open: boolean, next_open_label: string }
    const isOpen = data?.is_open ?? data?.[0]?.is_open ?? false;
    state.storeOpen = isOpen;

    if (isOpen){
      pill.classList.remove('closed');
      pillText.textContent = 'Aberto agora';
      closedBanner.classList.remove('show');
    } else {
      pill.classList.add('closed');
      pillText.textContent = 'Fechado no momento';
      closedBanner.classList.add('show');
    }
  } catch(err){
    console.error('Erro ao verificar status da loja:', err);
    // Em caso de falha, não bloqueia a navegação — assume fechado por segurança
    state.storeOpen = false;
    pill.classList.add('closed');
    pillText.textContent = 'Verifique pelo WhatsApp';
  }
  renderCheckoutAvailability();
}

/* ============================================================
   PRODUTOS
   Fonte: tabela `products` (+ `product_variations`)
   Policy pública permite leitura apenas de produtos disponíveis.
   ============================================================ */
async function loadProducts(){
  const grid = document.getElementById('productsGrid');

  if (!supabaseClient){
    grid.innerHTML = `<div class="empty-state">
      Conecte o Supabase em app.js (SUPABASE_URL / SUPABASE_ANON_KEY) para carregar o cardápio real.
    </div>`;
    console.error('[Carol Pacheco] supabaseClient não foi inicializado. Verifique se window.supabase existe e se SUPABASE_URL começa com http.');
    return;
  }

  console.log('[Carol Pacheco] Buscando produtos em', SUPABASE_URL);

  // Guard: se a chamada travar (rede lenta, CDN bloqueado, etc.), não deixa
  // a mensagem "Carregando cardápio…" presa pra sempre — mostra erro após 10s.
  const timeoutMs = 10000;
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Tempo de resposta excedido (10s).')), timeoutMs)
  );

  try{
    const query = supabaseClient
      .from('products')
      .select('*, product_variations(*)')
      .eq('is_available', true)
      .order('created_at', { ascending: true });

    const { data: products, error } = await Promise.race([query, timeout]);

    console.log('[Carol Pacheco] Resposta do Supabase:', { products, error });

    if (error) throw error;
    state.products = products || [];
    renderProducts();
  } catch(err){
    console.error('[Carol Pacheco] Erro ao carregar produtos:', err);
    grid.innerHTML = `<div class="empty-state">Não foi possível carregar o cardápio agora. Puxe a tela pra baixo pra atualizar, ou fale com a gente no WhatsApp.<br><small style="opacity:.6">${err.message || ''}</small></div>`;
  }
}

function renderProducts(){
  const grid = document.getElementById('productsGrid');
  if (!state.products.length){
    grid.innerHTML = `<div class="empty-state">Nenhum produto disponível no momento. Volte em breve!</div>`;
    return;
  }

  grid.innerHTML = state.products.map(p => {
    const outOfStock = !p.is_available || (p.stock_quantity ?? 0) <= 0;
    const lowStock = !outOfStock && p.stock_quantity <= 3;
    const tagClass = outOfStock ? 'out' : (lowStock ? 'low' : '');
    const tagText = outOfStock ? 'Esgotado' : `${p.stock_quantity} disponíveis`;

    return `
    <div class="product-card">
      <div class="product-media">
        <img src="${p.image_url || 'assets/placeholder-cake.jpg'}" alt="${p.name}" loading="lazy">
        <span class="stock-tag ${tagClass}">${tagText}</span>
      </div>
      <div class="product-info">
        <h3>${p.name}</h3>
        <p>${p.description || ''}</p>
        <div class="product-footer">
          <div class="price">${formatBRL(p.price)} <span>/un.</span></div>
          <button class="add-btn" data-product-id="${p.id}" ${outOfStock ? 'disabled' : ''}>
            ${outOfStock ? 'Esgotado' : '+ Adicionar'}
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.add-btn:not(:disabled)').forEach(btn => {
    btn.addEventListener('click', () => handleAddClick(btn.dataset.productId));
  });
}

function handleAddClick(productId){
  const product = state.products.find(p => String(p.id) === String(productId));
  if (!product) return;

  if (product.product_variations && product.product_variations.length){
    openVariantSheet(product);
  } else {
    addToCart(product, null);
    openCart();
  }
}

/* ---------------- Variantes (ex: escolha da calda) ---------------- */
const variantModal = document.getElementById('variantModal');
function openVariantSheet(product){
  state.pendingProduct = product;
  document.getElementById('variantProductName').textContent = product.name;
  const optionsWrap = document.getElementById('variantOptions');
  optionsWrap.innerHTML = product.product_variations.map(v => `
    <button class="variant-option" data-variation-id="${v.id}">
      <span>${v.name}</span>
      <span class="extra">${v.extra_price > 0 ? '+ ' + formatBRL(v.extra_price) : 'Sem custo extra'}</span>
    </button>
  `).join('');
  optionsWrap.querySelectorAll('.variant-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const variation = product.product_variations.find(v => String(v.id) === btn.dataset.variationId);
      addToCart(product, variation);
      closeVariantSheet();
      openCart();
    });
  });
  variantModal.classList.add('open');
}
function closeVariantSheet(){
  variantModal.classList.remove('open');
  state.pendingProduct = null;
}
variantModal.addEventListener('click', (e) => { if (e.target === variantModal) closeVariantSheet(); });

/* ============================================================
   CARRINHO
   ============================================================ */
function addToCart(product, variation){
  const unitPrice = Number(product.price) + Number(variation?.extra_price || 0);
  const key = `${product.id}-${variation?.id || 'base'}`;
  const existing = state.cart.find(i => i.key === key);

  if (existing){
    existing.qty += 1;
  } else {
    state.cart.push({
      key,
      product_id: product.id,
      variation_id: variation?.id || null,
      variation_name: variation?.name || null,
      name: product.name,
      unit_price: unitPrice,
      image_url: product.image_url,
      qty: 1,
    });
  }
  renderCart();
}

function changeQty(key, delta){
  const item = state.cart.find(i => i.key === key);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) state.cart = state.cart.filter(i => i.key !== key);
  renderCart();
}

function removeItem(key){
  state.cart = state.cart.filter(i => i.key !== key);
  renderCart();
}

function cartTotal(){
  return state.cart.reduce((sum, i) => sum + i.unit_price * i.qty, 0);
}

function renderCart(){
  const list = document.getElementById('cartList');
  const badge = document.getElementById('cartBadge');
  const totalEl = document.getElementById('cartTotal');
  const checkoutBtn = document.getElementById('checkoutBtn');
  const totalQty = state.cart.reduce((s,i) => s + i.qty, 0);

  badge.style.display = totalQty > 0 ? 'flex' : 'none';
  badge.textContent = totalQty;
  totalEl.textContent = formatBRL(cartTotal());

  if (!state.cart.length){
    list.innerHTML = `<div class="cart-empty">Seu carrinho está vazio.<br>Adicione algo delicioso do cardápio 🍰</div>`;
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = 'Adicione itens ao carrinho';
    return;
  }

  checkoutBtn.disabled = false;
  list.innerHTML = state.cart.map(i => `
    <div class="cart-item">
      <img src="${i.image_url || 'assets/placeholder-cake.jpg'}" alt="${i.name}">
      <div class="cart-item-info">
        <h4>${i.name}</h4>
        ${i.variation_name ? `<div class="variant">Calda: ${i.variation_name}</div>` : ''}
        <div class="cart-item-controls">
          <button class="qty-btn" data-key="${i.key}" data-delta="-1">−</button>
          <span>${i.qty}</span>
          <button class="qty-btn" data-key="${i.key}" data-delta="1">+</button>
          <span class="cart-item-price">${formatBRL(i.unit_price * i.qty)}</span>
          <button class="remove-item" data-key="${i.key}">Remover</button>
        </div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.qty-btn').forEach(btn => {
    btn.addEventListener('click', () => changeQty(btn.dataset.key, Number(btn.dataset.delta)));
  });
  list.querySelectorAll('.remove-item').forEach(btn => {
    btn.addEventListener('click', () => removeItem(btn.dataset.key));
  });

  renderCheckoutAvailability();
}

function renderCheckoutAvailability(){
  const checkoutBtn = document.getElementById('checkoutBtn');
  if (!checkoutBtn || !state.cart.length) return;
  if (state.storeOpen === false){
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = 'Loja fechada no momento';
  } else if (checkoutBtn.textContent === 'Loja fechada no momento') {
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Fechar pedido';
  }
}

/* ---------------- Drawer open/close ---------------- */
const overlay = document.getElementById('overlay');
const drawer = document.getElementById('cartDrawer');
function openCart(){
  overlay.classList.add('open');
  drawer.classList.add('open');
}
function closeCart(){
  overlay.classList.remove('open');
  drawer.classList.remove('open');
  // reset para a visão de carrinho ao reabrir
  document.getElementById('checkoutForm').classList.remove('show');
  document.getElementById('confirmScreen').classList.remove('show');
  document.getElementById('cartList').style.display = '';
  document.getElementById('drawerFoot').style.display = '';
}
document.getElementById('cartFab').addEventListener('click', openCart);
document.getElementById('drawerClose').addEventListener('click', closeCart);
overlay.addEventListener('click', closeCart);

/* ============================================================
   CHECKOUT — SEM LOGIN, SEM E-MAIL
   Fluxo: nome + telefone + CPF  →  create_order (Supabase)
          →  preferência Mercado Pago  →  redireciona pro pagamento
   Nenhum dado de conta é criado; nenhuma notificação é enviada.
   ============================================================ */
const checkoutBtn = document.getElementById('checkoutBtn');
const checkoutForm = document.getElementById('checkoutForm');
const cartList = document.getElementById('cartList');
const confirmScreen = document.getElementById('confirmScreen');
const drawerFoot = document.getElementById('drawerFoot');

const custName = document.getElementById('custName');
const custPhone = document.getElementById('custPhone');
const custCpf = document.getElementById('custCpf');

custPhone.addEventListener('input', () => custPhone.value = maskPhone(custPhone.value));
custCpf.addEventListener('input', () => custCpf.value = maskCPF(custCpf.value));

checkoutBtn.addEventListener('click', () => {
  const showingForm = checkoutForm.classList.contains('show');
  if (!showingForm){
    // primeira etapa: mostra formulário de identificação (sem login)
    cartList.style.display = 'none';
    checkoutForm.classList.add('show');
    checkoutBtn.textContent = 'Confirmar e pagar';
    return;
  }
  submitOrder();
});

function validateCheckoutForm(){
  let valid = true;
  document.getElementById('errName').classList.remove('show');
  document.getElementById('errPhone').classList.remove('show');
  document.getElementById('errCpf').classList.remove('show');

  if (custName.value.trim().split(' ').length < 2){
    document.getElementById('errName').classList.add('show');
    valid = false;
  }
  if (onlyDigits(custPhone.value).length < 10){
    document.getElementById('errPhone').classList.add('show');
    valid = false;
  }
  if (!isValidCPF(custCpf.value)){
    document.getElementById('errCpf').classList.add('show');
    valid = false;
  }
  return valid;
}

async function submitOrder(){
  if (!validateCheckoutForm()) return;

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Enviando pedido…';

  const orderPayload = {
    p_customer_name: custName.value.trim(),
    p_customer_phone: onlyDigits(custPhone.value),
    p_customer_cpf: onlyDigits(custCpf.value),
    p_items: state.cart.map(i => ({
      product_id: i.product_id,
      variation_id: i.variation_id,
      quantity: i.qty,
    })),
  };

  try{
    if (!supabaseClient) throw new Error('Supabase não configurado ainda.');

    // 1) Cria o pedido sem exigir conta/login — RPC pública (create_order).
    // Preço, disponibilidade e desconto de estoque são validados e calculados no servidor.
    const { data: order, error: orderError } = await supabaseClient.rpc('create_order', orderPayload);
    if (orderError) throw orderError;

    // 2) Gera a preferência de pagamento no Mercado Pago via endpoint HTTP público
    //    (rota do backend Lovable: /api/public/create-mercadopago-preference).
    //    Enquanto a secret MERCADOPAGO_ACCESS_TOKEN não estiver configurada,
    //    esse endpoint responde 503 com { error: "Mercado Pago não configurado ainda" }.
    let payment = null;
    let paymentPending = false;

    if (window.APP_BACKEND_ORIGIN){
      try{
        const resp = await fetch(`${window.APP_BACKEND_ORIGIN}/api/public/create-mercadopago-preference`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: order.id ?? order[0]?.id, back_url: window.location.origin }),
        });
        payment = await resp.json();
        if (!resp.ok) throw new Error(payment?.error || 'Falha ao criar pagamento');
      } catch(payErr){
        console.warn('Pagamento ainda não disponível:', payErr.message);
        paymentPending = true;
      }
    } else {
      // Mercado Pago ainda não configurado (pendente por decisão do negócio) —
      // o pedido é criado e registrado normalmente, só o pagamento fica pra depois.
      paymentPending = true;
    }

    const checkoutUrl = payment?.checkout_url || payment?.init_point;

    // 3) Mostra confirmação. Se o pagamento já estiver configurado, redireciona pro
    //    Mercado Pago; caso contrário, avisa que o pedido foi registrado e o
    //    pagamento será combinado à parte (ex: via WhatsApp) enquanto isso não sobe.
    checkoutForm.classList.remove('show');
    drawerFoot.style.display = 'none';
    confirmScreen.classList.add('show');

    if (checkoutUrl){
      document.getElementById('confirmMsg').textContent = 'Redirecionando para o pagamento seguro do Mercado Pago…';
    } else if (paymentPending){
      document.getElementById('confirmMsg').textContent = 'Pedido registrado com sucesso! O pagamento ainda será habilitado — em breve você recebe as instruções para concluir.';
    } else {
      document.getElementById('confirmMsg').textContent = 'Pedido recebido! Em instantes você poderá concluir o pagamento.';
    }

    state.cart = [];
    renderCart();

    if (checkoutUrl){
      setTimeout(() => { window.location.href = checkoutUrl; }, 1200);
    }
  } catch(err){
    console.error('Erro ao enviar pedido:', err);
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Confirmar e pagar';
    alert('Não foi possível concluir o pedido agora. Tente novamente ou finalize pelo WhatsApp.');
  }
}

/* ============================================================
   HORÁRIOS
   Fonte: store_config.business_hours (jsonb)
   ============================================================ */
const DAYS_PT = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
const FALLBACK_HOURS = {
  0: null,
  1: null,
  2: {open:'08:00', close:'18:00'},
  3: {open:'08:00', close:'18:00'},
  4: {open:'08:00', close:'18:00'},
  5: {open:'08:00', close:'18:00'},
  6: {open:'08:00', close:'12:00'},
};

async function loadHours(){
  const list = document.getElementById('hoursList');
  let hours = FALLBACK_HOURS;

  if (supabaseClient){
    try{
      const { data, error } = await supabaseClient
        .from('store_config')
        .select('business_hours')
        .single();
      if (!error && data?.business_hours) hours = data.business_hours;
    } catch(err){
      console.error('Erro ao carregar horários:', err);
    }
  }

  const today = new Date().getDay();
  list.innerHTML = DAYS_PT.map((day, idx) => {
    const h = hours[idx];
    const isToday = idx === today;
    const timeLabel = h ? `${h.open} às ${h.close}` : 'Fechado';
    return `<div class="hours-row ${isToday ? 'today' : ''}">
      <span class="day">${day}</span>
      <span class="time">${timeLabel}</span>
    </div>`;
  }).join('');
}

/* ============================================================
   WHATSAPP LINKS
   ============================================================ */
function setWhatsappLinks(){
  const msg = encodeURIComponent('Olá! Vim pelo site e gostaria de fazer uma encomenda especial 🍰');
  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`;
  ['whatsappFab', 'heroWhatsapp', 'locationWhatsapp'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.href = url;
  });
}

/* ============================================================
   ANIMAÇÕES (GSAP)
   ============================================================ */
function initAnimations(){
  if (!window.gsap) return;
  gsap.registerPlugin(ScrollTrigger);

  gsap.from('.hero-eyebrow, .hero h1, .hero p.lede, .hero-ctas, .hero-badges', {
    y: 24, opacity: 0, duration: 0.9, stagger: 0.12, ease: 'power3.out', delay: 0.15
  });
  gsap.from('.hero-photo', { scale: 0.85, opacity: 0, duration: 1.1, ease: 'power3.out', delay: 0.2 });

  gsap.utils.toArray('.section-head').forEach(el => {
    gsap.from(el, {
      y: 30, opacity: 0, duration: 0.8, ease: 'power2.out',
      scrollTrigger: { trigger: el, start: 'top 85%' }
    });
  });

  ScrollTrigger.batch('.product-card', {
    start: 'top 90%',
    onEnter: batch => gsap.from(batch, { y: 26, opacity: 0, duration: 0.6, stagger: 0.08, ease: 'power2.out' }),
    once: true,
  });

  gsap.from('.about-visual', {
    x: -30, opacity: 0, duration: 0.9, ease: 'power2.out',
    scrollTrigger: { trigger: '.about', start: 'top 75%' }
  });
  gsap.from('.about h2, .about p, .about-signature', {
    y: 24, opacity: 0, duration: 0.8, stagger: 0.1, ease: 'power2.out',
    scrollTrigger: { trigger: '.about', start: 'top 70%' }
  });
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  setWhatsappLinks();
  loadStoreStatus();
  loadProducts();
  loadHours();
  renderCart();
  initAnimations();
});
