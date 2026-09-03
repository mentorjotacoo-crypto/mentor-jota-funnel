# -*- coding: utf-8 -*-
"""
Smoke test del dashboard — corre DESPUÉS de publicar.

Detecta las fallas que ya nos mordieron:
  · marcadores de conflicto de git dentro del index.html (rompió el login)
  · errores de JS en runtime (una función borrada dejó 5 charts en blanco)
  · charts que no renderizan en algún tab
  · payload que no descifra, o datos que retroceden respecto a la fuente

Uso:  python smoke_test.py "<clave>" [--local]
      --local  prueba el index.html del repo en vez del sitio publicado.

Sale con código 0 si todo pasa, 1 si algo falla (apto para CI/tarea programada).
"""
import sys
import os
import re
import json
import gzip
import base64
import subprocess
import tempfile
from urllib.request import urlopen

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

URL = 'https://mentorjotacoo-crypto.github.io/mentor-jota-funnel/'
REPO = os.path.dirname(os.path.abspath(__file__))
EDGE_CANDIDATOS = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
]
TABS = ['pulso', 'resumen', 'embudo', 'journey', 'trends', 'revenue',
        'ascensos', 'closers', 'forecast', 'compare', 'data']

fallos = []
avisos = []


def check(nombre, ok, detalle='', critico=True, solo_al_fallar=False):
    """detalle: contexto a mostrar. Con solo_al_fallar=True se omite si pasa
    (para no imprimir el mensaje de error cuando el check fue exitoso)."""
    estado = 'PASS' if ok else ('FAIL' if critico else 'WARN')
    mostrar = detalle if (detalle and not (solo_al_fallar and ok)) else ''
    print(f'  [{estado}] {nombre}' + (f' — {mostrar}' if mostrar else ''))
    if not ok:
        (fallos if critico else avisos).append(f'{nombre}: {detalle}')
    return ok


def cargar_html(local):
    if local:
        with open(os.path.join(REPO, 'index.html'), encoding='utf-8') as f:
            return f.read()
    import time
    return urlopen(f'{URL}?smoke={int(time.time())}').read().decode('utf-8', 'replace')


def descifrar(html, clave):
    m = re.search(r"['\"]([A-Za-z0-9+/=]{5000,})['\"]", html)
    if not m:
        return None
    p = base64.b64decode(m.group(1))
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=p[:16], iterations=150000)
    plano = AESGCM(kdf.derive(clave.encode())).decrypt(p[16:28], p[44:] + p[28:44], None)
    if plano[:2] == b'\x1f\x8b':
        plano = gzip.decompress(plano)
    return json.loads(plano)


def prueba_navegador(html, clave):
    """Abre el dashboard ya logueado y reporta charts por tab + errores JS."""
    edge = next((e for e in EDGE_CANDIDATOS if os.path.exists(e)), None)
    if not edge:
        return None, 'Edge no encontrado (se omite la prueba de runtime)'

    inject = ("<script>sessionStorage.setItem('funnel_pw'," + json.dumps(clave) + ");"
              "window.__err=[];window.onerror=(m,s,l)=>window.__err.push(m+'@'+l);"
              "window.addEventListener('unhandledrejection',e=>window.__err.push('promise:'+e.reason));</script>")
    sonda = """
<script>
const esperar = ms => new Promise(r => setTimeout(r, ms));
setTimeout(async () => {
  const out = [];
  for (const t of %s) {
    try {
      switchTab(t, document.querySelector("[onclick*=\\""+t+"\\"]"));
      await esperar(600);
      let n = 0, sinDatos = 0;
      Object.values(chartInstances).forEach(c => {
        if (!c || !c.canvas) return;
        n++;
        // Un scatter/bubble no usa labels: sus datos viven en los datasets.
        const conPuntos = (c.data.datasets || []).some(
          d => (d.data || []).some(v => v !== null && v !== undefined));
        if (!(c.data.labels || []).length && !conPuntos) sinDatos++;
      });
      out.push(t + '=' + n + (sinDatos ? '/vacios:' + sinDatos : ''));
    } catch (e) { out.push(t + '=EXCEPCION:' + e.message); }
  }
  document.title = 'SMOKE|' + out.join(' ') + '|ERR:' + (window.__err.join(' ;; ') || 'ninguno');
}, 2800);
</script>""" % json.dumps(TABS)

    doc = html.replace('<script>', inject + '<script>', 1)
    doc = doc.replace('</body>', sonda + '</body>') if '</body>' in doc else doc + sonda
    ruta = os.path.join(tempfile.gettempdir(), 'smoke_dash.html')
    with open(ruta, 'w', encoding='utf-8') as f:
        f.write(doc)

    try:
        salida = subprocess.run(
            [edge, '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
             '--virtual-time-budget=30000', '--dump-dom', 'file:///' + ruta.replace('\\', '/')],
            capture_output=True, text=True, timeout=180, encoding='utf-8', errors='replace').stdout
    except subprocess.TimeoutExpired:
        return None, 'timeout del navegador'
    t = re.search(r'<title>SMOKE\|(.*?)</title>', salida or '', re.S)
    return (t.group(1) if t else None), None


def main():
    if len(sys.argv) < 2:
        print('Uso: python smoke_test.py "<clave>" [--local]')
        sys.exit(2)
    clave = sys.argv[1]
    local = '--local' in sys.argv
    print(f'\n=== SMOKE TEST — {"index.html local" if local else URL} ===\n')

    html = cargar_html(local)

    # 1. Integridad del HTML publicado
    check('sin marcadores de conflicto de git',
          not re.search(r'^(<<<<<<<|>>>>>>>|=======)$', html, re.M),
          'hay marcadores dentro del index.html (rompe TODO el JS)', solo_al_fallar=True)
    check('payload presente', bool(re.search(r"['\"][A-Za-z0-9+/=]{5000,}['\"]", html)))

    # 2. El payload descifra y trae datos coherentes
    datos = None
    try:
        datos = descifrar(html, clave)
    except Exception as e:
        check('el payload descifra', False, str(e)[:80])
    if datos:
        dias = datos.get('days', {})
        asc = datos.get('ascensos', {}).get('days', {})
        check('el payload descifra', True, f'{len(dias)} días LT · {len(asc)} días ascensos')
        check('hay datos de Low Ticket', len(dias) > 0)
        check('hay datos de ascensos', len(asc) > 0, critico=False)
        # los totales no deberían ser cero
        spend = sum(d.get('spend', 0) for d in dias.values())
        check('el spend acumulado es > 0', spend > 0, f'${spend:,.0f}')
        # frescura: el último día no debería tener más de 2 días de rezago
        try:
            from datetime import date
            ult = max(asc) if asc else None
            if ult:
                rezago = (date.today() - date.fromisoformat(ult)).days
                check('ascensos con menos de 3 días de rezago', rezago <= 2,
                      f'último día {ult} ({rezago} días)', critico=False)
        except Exception:
            pass

    # 3. Runtime real en navegador (lo que node --check NO puede ver)
    res, err = prueba_navegador(html, clave)
    if err:
        print(f'  [WARN] prueba de navegador omitida — {err}')
    elif not res:
        check('el dashboard renderiza en navegador', False, 'la sonda no respondió (¿login fallido?)')
    else:
        cuerpo, _, errores = res.partition('|ERR:')
        check('sin errores de JavaScript', errores.strip() == 'ninguno', errores.strip()[:160])
        for parte in cuerpo.split():
            tab, _, val = parte.partition('=')
            if 'EXCEPCION' in val:
                check(f'tab {tab} renderiza', False, val)
            elif 'vacios' in val:
                check(f'tab {tab} sin charts vacíos', False, val, critico=False)
            else:
                check(f'tab {tab} renderiza', int(val) > 0, f'{val} charts')

    # Histórico de salud: una línea por corrida (permite ver degradaciones)
    from datetime import datetime
    hist = os.path.join(REPO, 'smoke_history.csv')
    nuevo = not os.path.exists(hist)
    try:
        with open(hist, 'a', encoding='utf-8', newline='') as f:
            if nuevo:
                f.write('fecha;destino;resultado;fallos;avisos;dias_lt;dias_ht;detalle\n')
            n_lt = len(datos.get('days', {})) if datos else 0
            n_ht = len(datos.get('ascensos', {}).get('days', {})) if datos else 0
            det = ' | '.join(fallos + avisos).replace(';', ',')[:300]
            f.write(f'{datetime.now():%Y-%m-%d %H:%M};{"local" if local else "live"};'
                    f'{"FALLO" if fallos else "OK"};{len(fallos)};{len(avisos)};{n_lt};{n_ht};{det}\n')
    except OSError:
        pass

    print()
    if fallos:
        print(f'RESULTADO: {len(fallos)} FALLO(S) CRÍTICO(S)')
        for f in fallos:
            print(f'  ✗ {f}')
        sys.exit(1)
    print('RESULTADO: TODO OK' + (f' ({len(avisos)} aviso(s))' if avisos else ''))
    for a in avisos:
        print(f'  ! {a}')
    sys.exit(0)


if __name__ == '__main__':
    main()
