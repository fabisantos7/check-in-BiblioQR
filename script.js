const html = document.documentElement;
const btnTema = document.getElementById('btn-tema');
const textoTema = document.getElementById('texto-tema');

// 1. Alternância Modo Escuro / Claro
function aplicarTema(tema) {
  if (tema === 'dark') {
    html.setAttribute('data-theme', 'dark');
    textoTema.textContent = 'Claro';
  } else {
    html.removeAttribute('data-theme');
    textoTema.textContent = 'Escuro';
  }
  try { localStorage.setItem('senai_bib_tema', tema); } catch (e) {}
}

const temaSalvo = localStorage.getItem('senai_bib_tema') || 'light';
aplicarTema(temaSalvo);

btnTema.addEventListener('click', () => {
  const atual = html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  aplicarTema(atual === 'dark' ? 'light' : 'dark');
});

// 2. Navegação entre telas
const telaBoasVindas = document.getElementById('tela-boas-vindas');
const telaFormulario = document.getElementById('tela-formulario');
const telaSucesso    = document.getElementById('tela-sucesso');

function mostrarTela(tela) {
  [telaBoasVindas, telaFormulario, telaSucesso].forEach(t => t.classList.add('oculta'));
  tela.classList.remove('oculta');
  window.scrollTo(0, 0);
}

document.getElementById('btn-ir-checkin').addEventListener('click', () => mostrarTela(telaFormulario));
document.getElementById('btn-voltar').addEventListener('click',     () => mostrarTela(telaBoasVindas));

// 3. Identificação da mesa via QR Code (?mesa=04)
const params = new URLSearchParams(window.location.search);
const mesaParam = params.get('mesa');
const localAtual = mesaParam ? `Mesa ${mesaParam}` : 'Área Geral';

document.getElementById('texto-mesa-inicio').textContent = `${localAtual} · Biblioteca`;
document.getElementById('badge-mesa-form').textContent = localAtual;

// 4. Helpers usados pelo registro e pela sincronização
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

// 5. Sincronização com o painel da bibliotecária (JSON na nuvem)
//    - o check-in feito aqui entra no mesmo JSON que o painel lê;
//    - sem internet, a entrada fica guardada aqui e sincroniza depois;
//    - este check-in é SÓ DE ENTRADA: não há mais check-out nem tempo
//      de permanência (o aluno fecha o navegador ao sair e isso não é
//      um dado confiável — preferimos registrar só a entrada).
const SINC = (() => {
  const KEY_SYNC = 'senai_bib_sync';
  const KEY_FILA = 'senai_bib_entradas_pendentes';   // fila de ENTRADAS pendentes (offline)
  let busy = false, lastErr = null;

  const code = () => { try { return (localStorage.getItem(KEY_SYNC) || '').trim(); } catch (e) { return ''; } };
  const setCode = c => { try { c ? localStorage.setItem(KEY_SYNC, String(c).trim()) : localStorage.removeItem(KEY_SYNC); } catch (e) {} };
  const url = () => code() ? 'https://textdb.dev/api/data/' + encodeURIComponent(code()) : null;

  // aceita o código puro ou o endereço inteiro colado (https://textdb.dev/api/data/CODIGO)
  function limparCodigo(v) {
    let c = String(v || '').trim();
    const m = c.match(/textdb\.dev\/api\/data\/([A-Za-z0-9._-]+)/i);
    if (m) c = m[1];
    return c.replace(/^https?:\/\/[^\/]+\//i, '').replace(/\/$/i, '').trim();
  }

  function nuvemVazia() {
    return { schemaVersion: 1, settings: {}, students: [], checkins: [], tombstones: [] };
  }
  function garantir(doc) {
    if (!doc || typeof doc !== 'object') return nuvemVazia();
    if (!Array.isArray(doc.checkins))   doc.checkins   = [];
    if (!Array.isArray(doc.students))   doc.students   = [];
    if (!Array.isArray(doc.tombstones)) doc.tombstones = [];
    if (!doc.settings || typeof doc.settings !== 'object') doc.settings = {};
    return doc;
  }

  function paraPainel(d) {
    const entryISO = d.entryISO || (new Date().toISOString().slice(0, 10) + 'T' + (d.hora || '12:00') + ':00');
    return {
      id: d.id || ('ck-' + norm(d.nome).replace(/\s+/g, '-') + '-' + String(entryISO).replace(/\D/g, '').slice(0, 12)),
      nameKey: norm(d.nome),
      name: d.nome,
      turma: d.turma || '',
      atividade: d.motivo || '',
      entryAt: entryISO,
      local: d.local || '',
      updatedAt: d.entryISO || new Date().toISOString(),
      device: 'entrada'
    };
  }

  function incluirAluno(doc, d) {
    const nk = norm(d.nome);
    if (!nk || doc.students.some(s => s.nameKey === nk)) return;
    const agora = new Date().toISOString();
    doc.students.push({ id: uid(), nameKey: nk, name: d.nome, turma: d.turma || '', notes: '', manual: false, createdAt: agora, updatedAt: agora, device: 'entrada' });
  }

  async function lerNuvem() {
    const r = await fetch(url(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Falha ' + r.status);
    const txt = (await r.text()).trim();
    if (!txt) return null;                      // chave nova / sem dados = nuvem vazia
    try { return garantir(JSON.parse(txt)); } catch (e) { return null; }
  }

  async function gravarNuvem(doc) {
    doc.updatedAt = new Date().toISOString();
    const r = await fetch(url(), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(doc) });
    if (!r.ok) throw new Error('Falha ao enviar ' + r.status);
  }

  // 5.1 Fila de ENTRADAS pendentes — garante que o check-in chegue ao painel
  //     mesmo se a internet cair no momento do registro. Cada item fica aqui
  //     até a nuvem confirmar (próximo ciclo, a cada 15s).
  function lerFila() {
    try {
      const raw = localStorage.getItem(KEY_FILA);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function salvarFila(arr) {
    try {
      if (arr && arr.length) localStorage.setItem(KEY_FILA, JSON.stringify(arr));
      else localStorage.removeItem(KEY_FILA);
    } catch (e) {}
  }
  function enfileirarEntrada(d) {
    if (!d || !d.id) return;
    const fila = lerFila().filter(x => x.id !== d.id);   // evita duplicar
    fila.push({ id: d.id, nome: d.nome, turma: d.turma || '', motivo: d.motivo || '', local: d.local || '', hora: d.hora || '', entryISO: d.entryISO || new Date().toISOString() });
    salvarFila(fila);
  }

  // Tenta drenar a fila: para cada entrada pendente ainda ausente da nuvem,
  // adiciona ao doc. NÃO mexe na fila aqui — a remoção só acontece em
  // confirmarEntradasNaFila(), após o push ter sucesso. Retorna true se
  // modificou o doc (precisa gravar).
  function drenarFilaEntradas(doc) {
    const fila = lerFila();
    if (!fila.length) return false;
    let mudou = false;
    for (const item of fila) {
      if (doc.checkins.some(c => c.id === item.id)) continue;          // já está na nuvem
      if (doc.tombstones && doc.tombstones.some(t => t && t.id === item.id)) continue; // foi apagado
      doc.checkins.push(paraPainel(item));
      incluirAluno(doc, item);
      mudou = true;
    }
    return mudou;
  }

  // Após um push bem-sucedido, remove da fila as entradas já confirmadas.
  function confirmarEntradasNaFila(doc) {
    const fila = lerFila();
    if (!fila.length) return;
    const restantes = fila.filter(item => {
      if (doc.checkins.some(c => c.id === item.id)) return false;     // resolvido
      if (doc.tombstones && doc.tombstones.some(t => t && t.id === item.id)) return false; // apagado
      return true;
    });
    if (restantes.length !== fila.length) salvarFila(restantes);
  }

  function statusTexto() {
    const el = document.getElementById('sync-info');
    if (!el) return;
    if (code()) {
      el.innerHTML = lastErr
        ? '<span class="sync-aviso">painel: sem conexão agora — as entradas ficam salvas aqui e sincronizam depois</span> · <a href="#" id="lnk-sync">reconectar</a>'
        : '<span class="sync-ok">● conectado ao painel da biblioteca</span> · <a href="#" id="lnk-sync">trocar código</a>';
    } else {
      el.innerHTML = '<a href="#" id="lnk-sync">conectar ao painel da biblioteca →</a>';
    }
    const a = document.getElementById('lnk-sync');
    if (a) a.addEventListener('click', pedirCodigo);
  }

  function pedirCodigo(ev) {
    if (ev) ev.preventDefault();
    const bruto = prompt('Cole o código de sincronização criado no painel da bibliotecária (Configurações → Sincronização):') || '';
    const c = limparCodigo(bruto);
    if (c && /^[A-Za-z0-9._-]{4,80}$/.test(c)) {
      setCode(c);
      sincronizar();
    } else if (bruto.trim()) {
      alert('Esse código não parece válido.\nAbra o painel da bibliotecária → Configurações → Sincronização → "Copiar código" e cole aqui (só o código, ou o endereço inteiro — ambos servem).');
    }
    statusTexto();
  }

  // turmas definidas no painel passam a valer aqui também
  function aplicarTurmas(lista) {
    const sel = document.getElementById('turma');
    if (!sel || !Array.isArray(lista) || !lista.length) return;
    const atuais = Array.from(sel.options).slice(1).map(o => o.value);
    if (JSON.stringify(atuais) === JSON.stringify(lista)) return;
    const marcada = lista.includes(sel.value);
    sel.innerHTML = '<option value="" disabled' + (marcada ? '' : ' selected') + '>Selecione...</option>' +
      lista.map(t => '<option value="' + escH(t) + '">' + escH(t) + '</option>').join('');
  }

  async function sincronizar() {
    if (!url() || busy) return;
    busy = true;
    try {
      const doc = garantir((await lerNuvem()) || nuvemVazia());

      // turmas do painel valem aqui também
      if (doc.settings && Array.isArray(doc.settings.turmas)) aplicarTurmas(doc.settings.turmas);

      // drena a fila de entradas pendentes (check-ins feitos offline)
      const filaMudou = drenarFilaEntradas(doc);

      if (filaMudou) {
        await gravarNuvem(doc);
        confirmarEntradasNaFila(doc);
      } else {
        confirmarEntradasNaFila(doc);
      }

      lastErr = null;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    } finally {
      busy = false;
      statusTexto();
    }
  }

  // Chamado logo após o aluno confirmar a entrada: já tenta enviar na hora.
  async function aposEntrada(d) {
    if (!d || !d.id) return;
    // 1. guarda na fila — garante entrega mesmo se a internet falhar agora
    enfileirarEntrada(d);

    if (!url()) { statusTexto(); return; }
    try {
      const doc = garantir((await lerNuvem()) || nuvemVazia());
      // drena a fila (inclui a entrada que acabamos de enfileirar)
      if (drenarFilaEntradas(doc)) {
        await gravarNuvem(doc);
        confirmarEntradasNaFila(doc);
      } else {
        confirmarEntradasNaFila(doc);
      }
      lastErr = null;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    statusTexto();
  }

  function iniciar() {
    statusTexto();
    sincronizar();
    setInterval(sincronizar, 15000);
  }

  return { iniciar, aposEntrada, pedirCodigo, limparCodigo };
})();

// 6. Registro de entrada
function preencherResumo(dados) {
  document.getElementById('resumo-nome').textContent      = dados.nome;
  document.getElementById('resumo-turma').textContent     = dados.turma;
  document.getElementById('resumo-local').textContent     = dados.local;
  document.getElementById('resumo-atividade').textContent = dados.motivo;
  document.getElementById('resumo-hora').textContent      = dados.hora;
}

// código de sincronização pelo endereço (?sync=CÓDIGO) — configura uma vez e esquece
const syncParam = params.get('sync');
if (syncParam && syncParam.trim()) {
  const cLimpo = SINC.limparCodigo(syncParam);   // aceita também o endereço inteiro
  if (cLimpo && /^[A-Za-z0-9._-]{4,80}$/.test(cLimpo)) {
    try { localStorage.setItem('senai_bib_sync', cLimpo); } catch (e) {}
  }
}

document.getElementById('form-checkin').addEventListener('submit', (e) => {
  e.preventDefault();

  const agora = new Date();
  const horaFormatada = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const dados = {
    id: uid(),
    nome:   document.getElementById('nome').value.trim(),
    turma:  document.getElementById('turma').value,
    local:  localAtual,
    motivo: document.querySelector('input[name="motivo"]:checked').value,
    hora:   horaFormatada,
    entryISO: agora.toISOString()
  };

  preencherResumo(dados);
  mostrarTela(telaSucesso);
  SINC.aposEntrada(dados);
});

// Botão "Concluir · próximo aluno" — volta para o início, pronto para o próximo.
// Não há mais check-out: a entrada já foi enviada, é só limpar o formulário.
document.getElementById('btn-concluir').addEventListener('click', () => {
  document.getElementById('form-checkin').reset();
  // volta o motivo para "Leitura" (padrão)
  const leituraRadio = document.querySelector('input[name="motivo"][value="Leitura"]');
  if (leituraRadio) leituraRadio.checked = true;
  mostrarTela(telaBoasVindas);
});

// 7. partida da sincronização
SINC.iniciar();
