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

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

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
// gzip opcional) dentro de `data` bajo la llave indicada.
function fusionarEnc(archivo, llave, describir) {
  const p = path.join(__dirname, archivo);
  if (!fs.existsSync(p)) return;
  try {
    const blob = Buffer.from(fs.readFileSync(p, 'ascii'), 'base64');
    const key = crypto.pbkdf2Sync(password, blob.subarray(0, 16), ITERATIONS, 32, 'sha256');
    const dec = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(16, 28));
    dec.setAuthTag(blob.subarray(28, 44));
    let plain = Buffer.concat([dec.update(blob.subarray(44)), dec.final()]);
    if (plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b) plain = zlib.gunzipSync(plain);
    data[llave] = JSON.parse(plain.toString('utf8'));
    console.log('[OK] ' + archivo + ' fusionado: ' + describir(data[llave]));
  } catch (e) {
    console.warn('[WARN] No se pudo desencriptar ' + archivo + ': ' + e.message);
  }
}
fusionarEnc('closers.enc', 'closers', d => d.r.length + ' citas, ' + d.closers.length + ' closers');
fusionarEnc('atribucion.enc', 'atribucion', d => Object.keys(d.dias).length + ' dias por canal (' + d.modelo + ')');

// Fusionar ascensos.enc si existe (blob encriptado commiteado al repo —
// mismo formato salt|iv|tag|ct que el payload; lo genera sync_ascensos.py).
// Así los auto-syncs del tracker LT no pisan los datos de ascensos.
const ascPath = path.join(__dirname, 'ascensos.enc');
if (fs.existsSync(ascPath)) {
  try {
    const blob = Buffer.from(fs.readFileSync(ascPath, 'ascii'), 'base64');
    const aSalt = blob.subarray(0, 16);
    const aIv = blob.subarray(16, 28);
    const aTag = blob.subarray(28, 44);
    const aCt = blob.subarray(44);
    const aKey = crypto.pbkdf2Sync(password, aSalt, ITERATIONS, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', aKey, aIv);
    decipher.setAuthTag(aTag);
    let plain = Buffer.concat([decipher.update(aCt), decipher.final()]);
    // Soporta blob comprimido (gzip magic 1f 8b) o legacy sin comprimir
    if (plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b) {
      plain = zlib.gunzipSync(plain);
    }
    data.ascensos = JSON.parse(plain.toString('utf8'));
    console.log('[OK] ascensos.enc fusionado: ' + Object.keys(data.ascensos.days).length + ' dias');
  } catch (e) {
    console.warn('[WARN] No se pudo desencriptar ascensos.enc: ' + e.message);
  }
}

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
