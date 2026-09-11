# -*- coding: utf-8 -*-
"""
Trae del servicio de Triangulacion (mentor-jota-tracking) el revenue atribuido
POR CANAL y lo deja listo para el dashboard:
  - atribucion.json  (local, gitignored — para inspeccion)
  - atribucion.enc   (AES-256-GCM + gzip, SI se commitea — build.js lo fusiona)

Por que existe: GHL no separa Meta de Google en sus transacciones, asi que el
dashboard no podia dar ROAS por canal. El servicio de triangulacion si lo hace
(y cuadra al centavo contra GHL); aqui solo se LEE su API, no se toca.

Uso:
  set MJT_PWD=<DASHBOARD_PASSWORD del servicio>
  python sync_atribucion.py "<clave del dashboard>" [--base URL] [--todo]

  --base  por defecto produccion; para probar contra una instancia local
  --todo  vuelve a pedir todos los dias (por defecto solo los ultimos 10)

Sale con codigo 9 si no hay cambios respecto al atribucion.json previo.
"""
import sys
import os
import json
import gzip
import base64
import http.cookiejar
import urllib.request
import urllib.parse
from datetime import date, datetime, timedelta, timezone

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

BASE_DEFECTO = 'https://tracking-production-6322.up.railway.app'
REPO = os.path.dirname(os.path.abspath(__file__))
ITERATIONS = 150000

# El servicio solo reporta desde aqui (su variable DATOS_DESDE): antes no hay
# revenue registrado y el ROAS saldria catastrofico sin significar nada.
DESDE = '2026-08-01'
MODELO = 'last_click'

# El servicio resincroniza contra GHL una ventana de 7 dias y re-atribuye
# ventas tardias; 10 dias de relectura cubren ese margen con holgura.
DIAS_RELECTURA = 10

# Toda llamada lleva timeout: un script desatendido sin timeout se cuelga en
# silencio (ya paso con el smoke test).
TIMEOUT = 45

BOGOTA = timezone(timedelta(hours=-5))


def hoy_bogota():
    return datetime.now(BOGOTA).date()


class Cliente:
    """Sesion con cookie: el reporte usa la misma autenticacion que el tablero."""

    def __init__(self, base, password):
        self.base = base.rstrip('/')
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self._login(password)

    def _login(self, password):
        req = urllib.request.Request(
            self.base + '/login',
            data=json.dumps({'password': password}).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
            method='POST')
        with self.op.open(req, timeout=TIMEOUT) as r:
            cuerpo = json.loads(r.read().decode('utf-8'))
        if not cuerpo.get('ok') or not any(c.name == 'mjt_sess' for c in self.jar):
            raise RuntimeError('login rechazado por el servicio de triangulacion')

    def get(self, ruta, **params):
        url = self.base + ruta + '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'Accept': 'application/json'})
        with self.op.open(req, timeout=TIMEOUT) as r:
            cuerpo = json.loads(r.read().decode('utf-8'))
        if not cuerpo.get('ok'):
            raise RuntimeError(f'{ruta} respondio sin ok: {str(cuerpo)[:160]}')
        return cuerpo


def fila_canal(f):
    """Solo lo que el dashboard necesita de cada fila por canal."""
    return {
        'canal': f.get('canal'),
        'pago': bool(f.get('pago')),
        'spend': round(float(f.get('spend') or 0), 2),
        'revenue': round(float(f.get('revenue') or 0), 2),
        'ventas': round(float(f.get('ventas') or 0), 2),
        'leads': round(float(f.get('leads') or 0), 2),
    }


def dias_entre(a, b):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def cifrar(data, password):
    plano = gzip.compress(json.dumps(data, ensure_ascii=False).encode('utf-8'), 9)
    salt, iv = os.urandom(16), os.urandom(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    ct_tag = AESGCM(kdf.derive(password.encode('utf-8'))).encrypt(iv, plano, None)
    return base64.b64encode(salt + iv + ct_tag[-16:] + ct_tag[:-16]).decode('ascii'), len(plano)


def main():
    args = sys.argv[1:]
    if not args or len(args[0]) < 8:
        print('Uso: python sync_atribucion.py "<clave dashboard>" [--base URL] [--todo]')
        sys.exit(1)
    clave = args[0]
    base = args[args.index('--base') + 1] if '--base' in args else BASE_DEFECTO
    todo = '--todo' in args
    pwd = os.environ.get('MJT_PWD', '')
    if not pwd:
        print('[SKIP] falta MJT_PWD (contrasena del servicio de triangulacion)')
        sys.exit(0)

    jpath = os.path.join(REPO, 'atribucion.json')
    previo = {}
    if os.path.exists(jpath):
        try:
            with open(jpath, encoding='utf-8') as f:
                previo = json.load(f)
        except (OSError, ValueError):
            previo = {}

    print(f'Conectando a {base} ...')
    cli = Cliente(base, pwd)

    hoy = hoy_bogota()
    inicio = date.fromisoformat(DESDE)
    # Solo se reusan dias del mismo servicio y modelo; si cambia, se pide todo.
    mismo_origen = previo.get('base') == base and previo.get('modelo') == MODELO
    cache = previo.get('dias', {}) if (mismo_origen and not todo) else {}
    corte = hoy - timedelta(days=DIAS_RELECTURA)

    dias = {}
    pedidos = 0
    for d in dias_entre(inicio, hoy):
        k = d.isoformat()
        if k in cache and d < corte:
            dias[k] = cache[k]
            continue
        r = cli.get('/api/report/breakdown', dim='channel', model=MODELO, **{'from': k, 'to': k})
        dias[k] = [fila_canal(f) for f in r.get('filas', [])
                   if (f.get('spend') or f.get('revenue') or f.get('ventas') or f.get('leads'))]
        pedidos += 1

    # Punto 7: valor de por vida por canal de adquisicion, por mes del CLIC.
    # Separa front (low ticket) de high (ascensos) y cuenta solo cuotas #1 como
    # ascenso nuevo; es lo que convierte "cuanto vendio" en "cuanto rindio".
    ltv = {}
    m = date(inicio.year, inicio.month, 1)
    while m <= hoy:
        sig = date(m.year + (m.month // 12), (m.month % 12) + 1, 1)
        fin = min(sig - timedelta(days=1), hoy)
        r = cli.get('/api/report/ltv', dim='channel', model=MODELO,
                    **{'from': m.isoformat(), 'to': fin.isoformat()})
        ltv[m.strftime('%Y-%m')] = r.get('filas', [])
        pedidos += 1
        m = sig

    data = {
        'base': base, 'modelo': MODELO, 'desde': DESDE,
        'dias': dias, 'ltv': ltv,
        'actualizado': datetime.now(BOGOTA).isoformat(timespec='seconds'),
    }

    tot_rev = sum(f['revenue'] for fs in dias.values() for f in fs)
    tot_spend = sum(f['spend'] for fs in dias.values() for f in fs)
    canales = sorted({f['canal'] for fs in dias.values() for f in fs if f['canal']})
    print(f'  {len(dias)} dias ({pedidos} consultas) | revenue ${tot_rev:,.2f} | gasto ${tot_spend:,.2f}')
    print(f'  canales: {", ".join(canales) or "(ninguno)"}')

    if previo.get('dias') == dias and previo.get('ltv') == ltv:
        print('[SKIP] sin cambios respecto al ultimo sync')
        sys.exit(9)

    with open(jpath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    payload, n = cifrar(data, clave)
    with open(os.path.join(REPO, 'atribucion.enc'), 'w', encoding='utf-8') as f:
        f.write(payload)
    print(f'[OK] atribucion.enc escrito ({len(payload) / 1024:.1f} KB, {n / 1024:.1f} KB comprimidos)')


if __name__ == '__main__':
    main()
