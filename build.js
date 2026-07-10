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

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Uso: node build.js "clave"   (minimo 8 caracteres)');
  process.exit(1);
}

const ITERATIONS = 150000;
const SALT_LEN = 16;
const IV_LEN = 12;

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

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
    const plain = Buffer.concat([decipher.update(aCt), decipher.final()]);
    data.ascensos = JSON.parse(plain.toString('utf8'));
    console.log('[OK] ascensos.enc fusionado: ' + Object.keys(data.ascensos.days).length + ' dias');
  } catch (e) {
    console.warn('[WARN] No se pudo desencriptar ascensos.enc: ' + e.message);
  }
}

const plaintext = Buffer.from(JSON.stringify(data), 'utf8');

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
