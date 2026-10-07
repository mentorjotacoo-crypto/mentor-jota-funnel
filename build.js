#!/usr/bin/env node
/**
 * Build script: encripta data.json con AES-256-GCM + PBKDF2
 * y genera index.html con el payload embebido.
 *
 * Uso: node build.js "clave"
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Uso: node build.js "clave"   (minimo 8 caracteres)');
  process.exit(1);
}

const ITERATIONS = 150000;
const SALT_LEN = 16;
const IV_LEN = 12;

// Descifra un blob salt(16)|iv(12)|tag(16)|ct (base64), gzip opcional. Mismo
// formato para el payload del index.html y para los .enc del repo.
function descifrarBlob(b64) {
  const blob = Buffer.from(b64, 'base64');
  const key = crypto.pbkdf2Sync(password, blob.subarray(0, 16), ITERATIONS, 32, 'sha256');
  const dec = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(16, 28));
  dec.setAuthTag(blob.subarray(28, 44));
  let plain = Buffer.concat([dec.update(blob.subarray(44)), dec.final()]);
  if (plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b) plain = zlib.gunzipSync(plain);
  return JSON.parse(plain.toString('utf8'));
}

// Fuente del bloque del tracker (Low Ticket):
//   1. data.json, que escribe el workflow desde el dispatch del Apps Script
//      (o se genera a mano; esta en .gitignore).
//   2. Si no existe, el payload del index.html publicado: se descifra y se
//      toma solo lo que viene del tracker. Asi el rebuild que dispara un push
//      de ascensos.enc/closers.enc (o un workflow_dispatch manual) conserva el
//      ultimo Low Ticket sincronizado en vez de fallar por falta de data.json.
const LLAVES_ENC = ['ascensos', 'closers', 'atribucion'];
function cargarDatosBase() {
  const pData = path.join(__dirname, 'data.json');
  if (fs.existsSync(pData)) return JSON.parse(fs.readFileSync(pData, 'utf8'));
  const pIndex = path.join(__dirname, 'index.html');
  if (!fs.existsSync(pIndex)) {
    console.error('[ERROR] No hay data.json ni index.html del que recuperar el tracker.');
    process.exit(1);
  }
  const m = /const ENC_PAYLOAD = '([A-Za-z0-9+/=]+)'/.exec(fs.readFileSync(pIndex, 'utf8'));
  if (!m) {
    console.error('[ERROR] No hay data.json y el index.html no trae ENC_PAYLOAD.');
    process.exit(1);
  }
  let previo;
  try {
    previo = descifrarBlob(m[1]);
  } catch (e) {
    console.error('[ERROR] No hay data.json y el payload del index.html no descifra con esta clave: ' + e.message);
    process.exit(1);
  }
  LLAVES_ENC.forEach(k => delete previo[k]);
  if (!previo.days || !Object.keys(previo.days).length) {
    console.error('[ERROR] El index.html anterior no trae dias del tracker.');
    process.exit(1);
  }
  console.log('[OK] Sin data.json: tracker recuperado del index.html anterior (' +
              Object.keys(previo.days).length + ' dias, sincronizado ' + previo.updatedAt + ')');
  return previo;
}
const data = cargarDatosBase();

// Llaves de día: ISO 'YYYY-MM-DD' en todo el tablero. El Apps Script emitía
// 'Sep 27' (sin año) y desde 2026-10-05 emite ISO. Aquí se aceptan AMBOS:
// las llaves viejas se pasan a ISO con el año de data.dayYears (si viene) o
// deducido de la fecha de sincronización: un mes posterior al sincronizado es
// del año anterior (en enero, 'Dic 20' es del año pasado) y nada cae antes de
// LT_INICIO. La deducción solo sirve con menos de 12 meses de historial; con
// llaves ISO del origen no hace falta. template.html repite esta normalización
// (idempotente) por si recibe un payload viejo.
const MESES_ABR = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const LT_INICIO = '2026-02-01';
const ISO_DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
function normalizarDias(d) {
  if (!d || !d.days || typeof d.days !== 'object') return;
  const llaves = Object.keys(d.days);
  const viejas = llaves.filter(k => !ISO_DIA_RE.test(k));
  if (!viejas.length) { delete d.dayYears; return; }
  const m = /^(\d{4})-(\d{2})/.exec(d.updatedAt || '');
  const hoy = new Date();
  const ref = m ? { y: parseInt(m[1], 10), m: parseInt(m[2], 10) - 1 } : { y: hoy.getFullYear(), m: hoy.getMonth() };
  const dy = d.dayYears || {};
  const dias = {};
  let colisiones = 0, descartadas = 0;
  llaves.forEach(k => {
    let iso = k;
    if (!ISO_DIA_RE.test(k)) {
      const partes = k.split(' ');
      const mi = MESES_ABR.indexOf(partes[0]);
      const dd = parseInt(partes[1], 10);
      if (mi < 0 || !(dd >= 1 && dd <= 31)) { descartadas++; return; }
      let y = dy[k] !== undefined ? dy[k] : (mi > ref.m ? ref.y - 1 : ref.y);
      const isoDe = yy => yy + '-' + String(mi + 1).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
      if (dy[k] === undefined && isoDe(y) < LT_INICIO) y++;
      iso = isoDe(y);
    }
    if (dias[iso] !== undefined) colisiones++;
    dias[iso] = d.days[k];
  });
  d.days = dias;
  delete d.dayYears;
  console.log('[OK] ' + viejas.length + ' llaves "Mes DD" pasadas a ISO (año de referencia ' + ref.y + '-' + String(ref.m + 1).padStart(2, '0') + ')' +
              (colisiones ? ' — AVISO: ' + colisiones + ' repetidas' : '') + (descartadas ? ' — ' + descartadas + ' irreconocibles descartadas' : ''));
}
normalizarDias(data);

// Fusiona un blob .enc del repo (mismo formato salt|iv|tag|ct que el payload,
// gzip opcional; los generan sync_ascensos.py, sync_closers.py y
// sync_atribucion.py) dentro de `data` bajo la llave indicada. Así los
// auto-syncs del tracker LT no pisan esos datos.
//
// Si el archivo EXISTE y no descifra (clave distinta, archivo truncado por un
// push a medias), el build se detiene con error: antes seguía con un aviso y
// el workflow publicaba en verde un tablero con Ascensos/Closers/Canales en
// blanco, que el equipo leería como "no hubo ventas".
function fusionarEnc(archivo, llave, describir) {
  const p = path.join(__dirname, archivo);
  if (!fs.existsSync(p)) {
    console.log('[--] ' + archivo + ' no existe: la pestaña queda en estado vacío');
    return;
  }
  try {
    data[llave] = descifrarBlob(fs.readFileSync(p, 'ascii'));
    console.log('[OK] ' + archivo + ' fusionado: ' + describir(data[llave]));
  } catch (e) {
    console.error('[ERROR] ' + archivo + ' existe pero no descifra (' + e.message + '). ' +
                  'No se publica un tablero sin esos datos: revisar la clave o regenerar el archivo.');
    process.exit(1);
  }
}
fusionarEnc('closers.enc', 'closers', d => d.r.length + ' citas, ' + d.closers.length + ' closers');
fusionarEnc('atribucion.enc', 'atribucion', d => Object.keys(d.dias).length + ' dias por canal (' + d.modelo + ')');
fusionarEnc('ascensos.enc', 'ascensos', d => Object.keys(d.days).length + ' dias');

// Comprimir ANTES de cifrar: el JSON comprime ~90%; lo cifrado no comprime.
// El navegador detecta el magic gzip tras descifrar y usa DecompressionStream.
const rawJson = Buffer.from(JSON.stringify(data), 'utf8');
const plaintext = zlib.gzipSync(rawJson, { level: 9 });
console.log('[OK] JSON ' + Math.round(rawJson.length/1024) + ' KB -> gzip ' + Math.round(plaintext.length/1024) + ' KB');

const salt = crypto.randomBytes(SALT_LEN);
const iv = crypto.randomBytes(IV_LEN);
const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');

const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();

// Payload layout: salt(16) | iv(12) | authTag(16) | ciphertext
const payload = Buffer.concat([salt, iv, authTag, ciphertext]).toString('base64');

const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const output = template
  .replace('__ENCRYPTED_PAYLOAD__', payload)
  .replace('__ITERATIONS__', String(ITERATIONS))
  .replace('__BUILD_DATE__', new Date().toISOString());

fs.writeFileSync(path.join(__dirname, 'index.html'), output);

console.log('[OK] index.html generado');
console.log('     Payload encriptado: ' + payload.length + ' chars');
console.log('     Dias incluidos: ' + Object.keys(data.days).length);
console.log('     Build: ' + new Date().toLocaleString());
