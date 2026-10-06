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

// Llaves de día. El Apps Script emitía 'Sep 27' (sin año) y desde 2026-10-05
// emite ISO '2026-09-27'. El tablero trabaja internamente con 'Mes DD' (es lo
// que muestran gráficas y filtros), así que aquí se aceptan AMBOS formatos:
// las ISO se pasan a 'Mes DD' y su año queda en data.dayYears['Mes DD'], que
// template.html usa en vez de deducir el año por la fecha de sincronización.
// Si dos fechas ISO caen en el mismo 'Mes DD' (histórico > 12 meses) gana la
// más reciente y se avisa: el modelo interno del tablero aún es de 12 meses.
const MESES_ABR = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function normalizarDias(d) {
  if (!d || !d.days || typeof d.days !== 'object') return;
  const llaves = Object.keys(d.days);
  const iso = llaves.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  if (!iso.length) return;                       // formato viejo: nada que hacer
  const dias = {}, anios = Object.assign({}, d.dayYears || {});
  llaves.filter(k => !/^\d{4}-\d{2}-\d{2}$/.test(k)).forEach(k => { dias[k] = d.days[k]; });
  let colisiones = 0;
  iso.sort().forEach(k => {
    const y = parseInt(k.slice(0, 4), 10), m = parseInt(k.slice(5, 7), 10), dd = k.slice(8, 10);
    if (!(m >= 1 && m <= 12)) { dias[k] = d.days[k]; return; }   // raro: se deja tal cual
    const corta = MESES_ABR[m - 1] + ' ' + dd;
    if (dias[corta] !== undefined && anios[corta] !== undefined && anios[corta] !== y) colisiones++;
    dias[corta] = d.days[k];
    anios[corta] = y;
  });
  d.days = dias;
  d.dayYears = anios;
  console.log('[OK] ' + iso.length + ' llaves ISO normalizadas a "Mes DD" (año en dayYears)' +
              (colisiones ? ' — AVISO: ' + colisiones + ' día(s) de distinto año con la misma llave; se conservó el más reciente' : ''));
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
