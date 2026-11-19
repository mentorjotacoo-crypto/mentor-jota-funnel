# -*- coding: utf-8 -*-
"""
Extrae los datos diarios de ascensos (high ticket) de la Hoja de seguimiento
Mentor Jota Consolidado.xlsx (Drive local) y genera:
  - ascensos.json  (local, gitignored — para inspección)
  - ascensos.enc   (encriptado AES-256-GCM, SÍ se commitea — build.js lo
                    desencripta y fusiona al payload del dashboard)

Uso:  python sync_ascensos.py "clave"
"""
import sys
import json
import base64
import gzip
import os
from datetime import datetime, date

import openpyxl
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

XLSX = r'H:\Mi unidad\Empresas Cynthia y Jose Julian\Mentor Jota\Técnico\Hoja de seguimiento Mentor Jota Consolidado.xlsx'
FUENTE_JSON = os.path.join(os.path.dirname(XLSX), 'ascensos_fuente.json')
REPO = os.path.dirname(os.path.abspath(__file__))

MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
         'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

# Columnas (1-based) en las pestañas mensuales — layout idéntico 2025/2026
# Tres modalidades con precio/pago separados:
#   Mentoría (principal): ventas/contratado/cobrado
#   STM Curso y STM Lite: sus propias columnas de venta, precio y pago
COLS = {
    'spend': 3,
    'impressions': 4,
    'clicks': 7,
    'leads': 10,
    'agendamientos': 13,
    'llamadas': 17,
    'ventas': 20,               # Mentoría
    'contratado': 26,           # Precio venta Mentoría
    'cobrado': 27,              # Pago Mentoría
    'cobrado_cuotas': 28,       # Pago Cuotas (financiaciones cobradas en el mes;
                                # el Excel del usuario las suma al cash HT del ROAS)
    'ventas_stm_curso': 22,
    'contratado_stm_curso': 29,
    'cobrado_stm_curso': 31,
    'ventas_stm_lite': 23,
    'contratado_stm_lite': 30,
    'cobrado_stm_lite': 32,
}

# Mismo formato que build.js: PBKDF2-SHA256 150k iters, salt(16)|iv(12)|tag(16)|ct
ITERATIONS = 150000


def num(v):
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace('$', '').replace(',', '').strip() or 0)
    except ValueError:
        return 0


def main():
    if len(sys.argv) < 2 or len(sys.argv[1]) < 8:
        print('Uso: python sync_ascensos.py "clave"  (min 8 chars)')
        sys.exit(1)
    password = sys.argv[1]

    # 15-nov-2026: Juan paso el libro a Google Sheets (privado). El script ligado a ese Sheet
    # (C:/tmp/consolidado_clone/ascensos.js) deja cada 2 horas "ascensos_fuente.json" en la
    # misma carpeta de Drive con las filas de las pestanas mensuales. Si existe, ESA es la
    # fuente; el Excel viejo queda solo como respaldo por si el JSON no esta.
    hoy = date.today()
    days = {}
    hojas_leidas = []
    fuente = 'Hoja de seguimiento Mentor Jota Consolidado.xlsx'
    hojas = {}          # nombre -> lista de filas [fecha(date), col2, col3, ...]
    if os.path.exists(FUENTE_JSON):
        print(f'Leyendo {FUENTE_JSON}...')
        with open(FUENTE_JSON, encoding='utf-8') as f:
            src = json.load(f)
        fuente = 'Google Sheet (ascensos_fuente.json, %s)' % src.get('generado', '?')
        try:
            edad = (datetime.now() - datetime.fromisoformat(src['generado'])).total_seconds() / 3600
            if edad > 30:
                # 19-nov-2026: con la copia vieja este script regrababa ascensos.enc y PISABA
                # los dias que el tracker ya habia traido del Sheet (el tablero se quedo en el
                # 12-nov). La fuente viva es el tracker (data.ht -> build.js); una copia vieja
                # no publica nada.
                print('[SKIP] ascensos_fuente.json tiene %.0f horas: los ascensos los trae el tracker' % edad)
                sys.exit(9)
        except (KeyError, ValueError):
            pass
        for nombre, filas_src in src.get('hojas', {}).items():
            out = []
            for r in filas_src:
                try:
                    out.append([date.fromisoformat(r[0])] + list(r[1:]))
                except (ValueError, TypeError, IndexError):
                    continue
            hojas[nombre] = out
    else:
        print(f'Leyendo {XLSX}...')
        wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
        for nombre in wb.sheetnames:
            partes = nombre.split(' ')
            if len(partes) != 2 or partes[0] not in MESES or not partes[1].isdigit():
                continue
            out = []
            for row in wb[nombre].iter_rows(min_row=2, max_col=max(COLS.values()), values_only=True):
                if isinstance(row[0], datetime):
                    out.append([row[0].date()] + list(row[1:]))
            hojas[nombre] = out

    for anio in range(2025, hoy.year + 1):
        for mi, mes in enumerate(MESES):
            nombre = f'{mes} {anio}'
            if nombre not in hojas:
                continue
            filas = 0
            for row in hojas[nombre]:
                d = row[0]
                if d.year != anio or d.month != mi + 1:
                    continue  # basura fuera del mes
                if d > hoy:
                    continue  # días futuros del mes en curso
                key = d.isoformat()
                if key not in days:
                    days[key] = {k: 0 for k in COLS}
                # Sumar (soporta varias fuentes por día: Facebook, Google...)
                for k, c in COLS.items():
                    days[key][k] += num(row[c - 1] if c - 1 < len(row) else None)
                filas += 1
            hojas_leidas.append(f'{nombre} ({filas} filas)')

    # Redondear para no arrastrar floats largos
    for k, v in days.items():
        for m in v:
            v[m] = round(v[m], 2)

    ascensos = {
        'updatedAt': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'source': fuente,
        'days': days,
    }

    print(f'Hojas leídas: {len(hojas_leidas)}')
    for h in hojas_leidas:
        print(f'  - {h}')
    print(f'Días totales: {len(days)}')

    # ¿Cambiaron los DATOS respecto a la corrida anterior?
    # (el .enc cifra con salt aleatorio, así que siempre difiere byte a byte:
    #  comparar el archivo cifrado daría "cambio" siempre y llenaría el repo
    #  de commits vacíos. La comparación real se hace sobre 'days'.)
    json_path = os.path.join(REPO, 'ascensos.json')
    sin_cambios = False
    if os.path.exists(json_path):
        try:
            with open(json_path, encoding='utf-8') as f:
                sin_cambios = json.load(f).get('days') == days
        except (ValueError, OSError):
            sin_cambios = False

    if sin_cambios:
        print('[SIN CAMBIOS] los datos son idénticos a la corrida anterior')
        sys.exit(9)   # el runner interpreta 9 como "nada que publicar"

    # Guardar JSON local (gitignored)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(ascensos, f, ensure_ascii=False, indent=2)
    print(f'[OK] {json_path}')

    # Encriptar → ascensos.enc (mismo formato que el payload del dashboard)
    # Comprimir antes de cifrar: build.js detecta el magic gzip y descomprime.
    plaintext = gzip.compress(json.dumps(ascensos, ensure_ascii=False).encode('utf-8'), 9)
    salt = os.urandom(16)
    iv = os.urandom(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    key = kdf.derive(password.encode('utf-8'))
    ct_tag = AESGCM(key).encrypt(iv, plaintext, None)  # ct + tag(16) al final
    ct, tag = ct_tag[:-16], ct_tag[-16:]
    payload = base64.b64encode(salt + iv + tag + ct).decode('ascii')

    enc_path = os.path.join(REPO, 'ascensos.enc')
    with open(enc_path, 'w', encoding='ascii') as f:
        f.write(payload)
    print(f'[OK] {enc_path} ({len(payload)} chars)')
    print('Siguiente: node build.js "clave" && git add ascensos.enc index.html && commit+push')


if __name__ == '__main__':
    main()
