/**
 * ============================================================
 * AUTO-SYNC DASHBOARD + ANOTACIONES - Apps Script
 * ============================================================
 * Lee los sheets del tracker + tab "Anotaciones"
 * -> compila JSON -> dispara rebuild en GitHub
 * -> expone doPost() para recibir anotaciones desde el dashboard
 *
 * INSTALACION (una sola vez):
 * 1. Pegar este codigo en el Apps Script (reemplazar dashboardSync.gs)
 * 2. Ejecutar initDashboardSync() -> crea la tab "Anotaciones" y genera el secret
 * 3. Deploy > New deployment > Type: Web App
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - Copy the URL -> pegar en Script Properties como WEB_APP_URL
 * 4. Ejecutar syncDashboard()
 */

// ============================================================
// INICIALIZACION (una sola vez)
// ============================================================
function initDashboardSync() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Crear tab "Anotaciones" si no existe
  let annSheet = ss.getSheetByName('Anotaciones');
  if (!annSheet) {
    annSheet = ss.insertSheet('Anotaciones');
    annSheet.getRange(1, 1, 1, 5).setValues([['id','date','stage','text','createdAt']]);
    annSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#0C4650').setFontColor('#E7FF2A');
    annSheet.setColumnWidth(1, 180); annSheet.setColumnWidth(2, 100);
    annSheet.setColumnWidth(3, 110); annSheet.setColumnWidth(4, 420); annSheet.setColumnWidth(5, 170);
    annSheet.setFrozenRows(1);
    Logger.log('Creada tab "Anotaciones".');
  }

  // Generar secret si no existe
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ANNOTATION_SECRET')) {
    const secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('ANNOTATION_SECRET', secret);
    Logger.log('Secret generado y guardado en Script Properties.');
  }

  Logger.log('=== CONFIGURACION ===');
  Logger.log('GITHUB_TOKEN: ' + (props.getProperty('GITHUB_TOKEN') ? 'configurado' : 'FALTA'));
  Logger.log('ANNOTATION_SECRET: configurado (' + props.getProperty('ANNOTATION_SECRET').substring(0,8) + '...)');
  Logger.log('WEB_APP_URL: ' + (props.getProperty('WEB_APP_URL') || 'FALTA - deploy la Web App y guarda la URL aqui'));
  Logger.log('');
  Logger.log('Siguiente paso: Deploy > New deployment > Web App > Execute as: Me, Access: Anyone');
}

// ============================================================
// FUNCION PRINCIPAL - sincroniza al dashboard
// ============================================================
function syncDashboard() {
  const data = buildDataJson_();
  const nDias = Object.keys(data.days).length;
  if (nDias === 0) throw new Error('No se encontraron dias con datos.');
  Logger.log('Data compilada: ' + nDias + ' dias, ' + data.annotations.length + ' anotaciones');
  triggerGitHubDispatch_(data);
  Logger.log('Dispatch enviado. Dashboard se actualiza en ~45s.');
  return nDias;
}

function actualizarYSync() {
  actualizarTrackerAyer();
  Utilities.sleep(2000);
  syncDashboard();
}

// Jala Meta + GHL de HOY (funciones del tracker) y sincroniza al dashboard.
// Pensada para triggers intradía: el dashboard deja de ir rezagado medio día.
function actualizarHoyYSync() {
  actualizarTrackerHoy();
  Utilities.sleep(2000);
  syncDashboard();
}

// Crea triggers intradía (1 PM y 7 PM Colombia) para actualizarHoyYSync.
// Correr UNA vez. No toca los triggers de otras funciones (ej. el de la mañana).
// OJO: si corres crearTriggerDiario() del tracker, ese borra TODOS los triggers
// y habría que volver a correr esta función.
function crearTriggersIntradia() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'actualizarHoyYSync') ScriptApp.deleteTrigger(t);
  });
  [13, 19].forEach(h => {
    ScriptApp.newTrigger('actualizarHoyYSync')
      .timeBased().atHour(h).everyDays(1)
      .inTimezone('America/Bogota').create();
  });
  Logger.log('Triggers intradía creados: 1 PM y 7 PM Colombia.');
  Logger.log('Triggers actuales del proyecto:');
  ScriptApp.getProjectTriggers().forEach(t => Logger.log('  - ' + t.getHandlerFunction()));
}

// ============================================================
// FIX: columna de totales bajo fecha futura (el "día fantasma")
// En Julio las fórmulas SUM quedaron bajo la fecha 29/07 en vez
// de una columna "Total". Esta función:
//   1. Normaliza headers de fecha en texto (ej. "30/7/2026")
//   2. Mueve el bloque de totales a una columna "Total" al final
//      (moveTo = cortar/pegar: las referencias se preservan)
//   3. Restaura la fecha real donde estaba el fantasma
//   4. Extiende los rangos SUM para cubrir todas las fechas del mes
// Correr UNA vez sobre el mes actual. Revisar el Log al terminar.
// ============================================================
function arreglarColumnaTotal() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoy = new Date();
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const nombre = meses[hoy.getMonth()] + ' - Low Ticket Tracker';
  const sheet = ss.getSheetByName(nombre);
  if (!sheet) { Logger.log('No existe la hoja "' + nombre + '"'); return; }

  const lastRow = sheet.getLastRow();
  let lastCol = sheet.getLastColumn();

  // 1. Normalizar headers de fecha que quedaron como texto (typos tipo "30/7/2026")
  let hdr = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
  for (let c = 2; c < lastCol; c++) {
    const v = hdr[c];
    if (v instanceof Date) continue;
    const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      sheet.getRange(2, c + 1)
        .setValue(new Date(parseInt(m[3],10), parseInt(m[2],10) - 1, parseInt(m[1],10), 12, 0, 0))
        .setNumberFormat('dd/MM/yyyy');
      Logger.log('Header texto → fecha corregido en col ' + (c + 1) + ': "' + v + '"');
    }
  }

  // 2. Detectar columna fantasma (fecha futura con fórmulas debajo) y última fecha
  hdr = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
  let phantomCol = -1, lastDateCol = -1;
  for (let c = 2; c < lastCol; c++) {
    const cell = hdr[c];
    if (!(cell instanceof Date)) continue;
    lastDateCol = c + 1;
    if (cell.getTime() > hoy.getTime() && phantomCol === -1) {
      const fs = sheet.getRange(3, c + 1, Math.min(lastRow - 2, 40), 1).getFormulas();
      if (fs.some(r => r[0])) phantomCol = c + 1;
    }
  }
  if (phantomCol === -1) { Logger.log('No hay columna fantasma (fecha futura con fórmulas). Nada que hacer.'); return; }

  const fechaFantasma = hdr[phantomCol - 1];
  const targetCol = lastDateCol + 1;
  Logger.log('Fantasma en col ' + phantomCol + ' (fecha ' + fechaFantasma + '). Total irá en col ' + targetCol);

  // 3. Mover el bloque completo (header + datos) a la columna Total
  sheet.getRange(2, phantomCol, lastRow - 1, 1).moveTo(sheet.getRange(2, targetCol));

  // 4. Headers: "Total" en la nueva columna; restaurar la fecha real en la vieja
  sheet.getRange(2, targetCol).setValue('Total').setFontWeight('bold');
  sheet.getRange(2, phantomCol).setValue(new Date(fechaFantasma)).setNumberFormat('dd/MM/yyyy');

  // 5. Extender rangos SUM del Total: C..última fecha
  const lastDateLetter = columnToLetter_(lastDateCol);
  const formulas = sheet.getRange(3, targetCol, lastRow - 2, 1).getFormulas();
  let sumFixed = 0;
  for (let i = 0; i < formulas.length; i++) {
    if (/^=SUM\(/i.test(formulas[i][0] || '')) {
      const fila = i + 3;
      sheet.getRange(fila, targetCol).setFormula('=SUM(C' + fila + ':' + lastDateLetter + fila + ')');
      sumFixed++;
    }
  }
  Logger.log('Listo: bloque movido, fecha ' + Utilities.formatDate(new Date(fechaFantasma), 'America/Bogota', 'dd/MM') +
             ' restaurada, ' + sumFixed + ' fórmulas SUM extendidas hasta ' + lastDateLetter + '.');
  Logger.log('Revisa la hoja "' + nombre + '" y luego corre syncDashboard().');
}

// ============================================================
// FIX: corrige "% Tasa de Conversion Landing" en todos los meses
// Antes: compras / Clics Unicos en enlace (mal)
// Despues: compras / Vistas a la Pagina de aterrizaje (correcto)
// Correr UNA sola vez.
// ============================================================
function fixTasaConversionLanding() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let totalFixed = 0;
  ss.getSheets().forEach(sheet => {
    if (sheet.getName() === 'Anotaciones') return;
    const fullData = sheet.getDataRange().getValues();
    let lpvRowByBlock = null;
    let purchasesRowByBlock = null;
    let convLandingRows = [];

    for (let r = 0; r < fullData.length; r++) {
      const label = String(fullData[r][1] || '').trim();
      if (label === 'Fecha') {
        // Nuevo bloque: aplicar correcciones del bloque previo si hay
        if (lpvRowByBlock !== null && purchasesRowByBlock !== null) {
          convLandingRows.forEach(rowIdx => {
            applyConvLandingFormula_(sheet, rowIdx, purchasesRowByBlock, lpvRowByBlock, fullData[rowIdx].length);
            totalFixed++;
          });
        }
        lpvRowByBlock = null;
        purchasesRowByBlock = null;
        convLandingRows = [];
        continue;
      }
      if (label === 'Vistas a la Página de aterrizaje' || label === 'Vistas a la Pagina de aterrizaje') {
        lpvRowByBlock = r + 1; // 1-indexed
      }
      if (label === 'Compras Low Ticket') {
        purchasesRowByBlock = r + 1;
      }
      if (label.startsWith('% Tasa de Conversi') && label.includes('Landing')) {
        convLandingRows.push(r);
      }
    }
    // Ultimo bloque
    if (lpvRowByBlock !== null && purchasesRowByBlock !== null) {
      convLandingRows.forEach(rowIdx => {
        applyConvLandingFormula_(sheet, rowIdx, purchasesRowByBlock, lpvRowByBlock, fullData[rowIdx].length);
        totalFixed++;
      });
    }
  });
  Logger.log('Corregidas ' + totalFixed + ' filas de Tasa Conv Landing.');
  Logger.log('Formula nueva: =IFERROR(Compras_LT / LPV, 0)');
}

function applyConvLandingFormula_(sheet, rowIdx0, purchasesRow1, lpvRow1, totalCols) {
  // Columnas C en adelante (col 3) son los datos diarios; ultima col es Total
  for (let c = 3; c <= totalCols; c++) {
    const colLetter = columnToLetter_(c);
    const formula = '=IFERROR(' + colLetter + purchasesRow1 + '/' + colLetter + lpvRow1 + ',0)';
    sheet.getRange(rowIdx0 + 1, c).setFormula(formula);
    sheet.getRange(rowIdx0 + 1, c).setNumberFormat('0.00%');
  }
}

function columnToLetter_(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// ============================================================
// PARSER DEL SHEET -> data.json
// ============================================================
function buildDataJson_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const days = {};

  const METRIC_MAP = {
    'Impresiones':                          'impressions',
    'Alcance':                              'reach',
    'Clics en Enlaces':                     'clicks',
    'Vistas a la Página de aterrizaje':    'lpv',
    'Vistas a la Pagina de aterrizaje':    'lpv',
    'Leads':                                'leads',
    'Pagos Iniciados':                      'checkouts',
    'Compras Low Ticket':                   'purchases',
    'Bump Offer 1':                         'bump1',
    'Bump Offer 2':                         'bump2',
    'Total Ad Spend (According to Meta)':   'spend',
    'Valor de conversión total':            'revenue',
    'Valor de conversion total':            'revenue',
    'Valor de conversión compra low ticket':       'revenue_lt',
    'Valor de conversion compra low ticket':       'revenue_lt',
    'Valor de conversión compra Bump Offer 1':     'revenue_b1',
    'Valor de conversion compra Bump Offer 1':     'revenue_b1',
    'Valor de conversión compra  Bump Offer 1':    'revenue_b1',
    'Valor de conversion compra  Bump Offer 1':    'revenue_b1',
    'Valor de conversión compra Bump Offer 2':     'revenue_b2',
    'Valor de conversion compra Bump Offer 2':     'revenue_b2'
  };

  // Sheets de metricas (no la de anotaciones)
  ss.getSheets().forEach(sheet => {
    const name = sheet.getName();
    if (name === 'Anotaciones') return;
    // Excluir pestañas que NO son el tracker de Meta para no colisionar
    // etiquetas (ej. "Impresiones" de Google sobreescribiría la de Meta).
    // El dashboard actual solo consume las hojas de Meta ("... Low Ticket Tracker").
    if (name.indexOf('Google') >= 0) return;   // tabs de Google Ads
    if (name.indexOf('_Debug') >= 0) return;   // hojas de debug
    if (name.indexOf('_Diag') >= 0) return;    // hojas de diagnóstico
    const fullData = sheet.getDataRange().getValues();
    // Display values para la fila Fecha: los objetos Date de getValues() se
    // interpretan en la zona horaria del archivo y el script los renderiza en
    // la suya — si difieren, las fechas a medianoche se corren un día atrás
    // (bug real: todo Feb-Jun quedaba atribuido al día anterior). El texto
    // visible "dd/MM/yyyy" es inmune a zonas horarias.
    const fullDisplay = sheet.getDataRange().getDisplayValues();
    let currentDates = null;

    for (let r = 0; r < fullData.length; r++) {
      const row = fullData[r];
      const label = String(row[1] || '').trim();

      if (label === 'Fecha') {
        currentDates = [];
        for (let c = 2; c < row.length; c++) {
          const disp = String((fullDisplay[r] || [])[c] || '').trim();
          const dm = disp.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          currentDates.push(dm
            ? new Date(parseInt(dm[3],10), parseInt(dm[2],10) - 1, parseInt(dm[1],10), 12, 0, 0)
            : null);
        }
        continue;
      }
      if (!currentDates || !METRIC_MAP[label]) continue;

      const metric = METRIC_MAP[label];
      const hoyStr = Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd');
      for (let c = 2; c < row.length && (c - 2) < currentDates.length; c++) {
        const dateObj = currentDates[c - 2];
        if (!dateObj) continue;
        // Saltar días futuros: evita columnas vacías del mes y el "día fantasma"
        // donde una fórmula de totales queda pegada en una fecha futura (ej. Jul 29).
        const dStr = Utilities.formatDate(dateObj, 'America/Bogota', 'yyyy-MM-dd');
        if (dStr > hoyStr) continue;
        const dayKey = formatDayKey_(dateObj);
        if (!days[dayKey]) {
          days[dayKey] = { impressions:0, reach:0, clicks:0, lpv:0, leads:0, checkouts:0, purchases:0, bump1:0, bump2:0, spend:0, revenue:0, revenue_lt:0, revenue_b1:0, revenue_b2:0 };
        }
        const num = parseNumeric_(row[c]);
        if (num !== null) days[dayKey][metric] = num;
      }
    }
  });

  // Spend de Google Ads: pestañas "<Mes> - Google Tracker" (layout igual a Meta).
  // Solo se lee la fila de spend — las demás etiquetas ("Impresiones" etc.)
  // colisionarían con las de Meta. Se agrega como days[key].spend_google.
  ss.getSheets().forEach(sheet => {
    if (sheet.getName().indexOf('Google Tracker') < 0) return;
    const vals = sheet.getDataRange().getValues();
    const disp = sheet.getDataRange().getDisplayValues();
    const hoyStr = Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd');
    let dates = null;
    for (let r = 0; r < vals.length; r++) {
      const label = String(vals[r][1] || '').trim();
      if (label === 'Fecha') {
        dates = [];
        for (let c = 2; c < vals[r].length; c++) {
          const dm = String((disp[r] || [])[c] || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          dates.push(dm ? new Date(parseInt(dm[3],10), parseInt(dm[2],10)-1, parseInt(dm[1],10), 12, 0, 0) : null);
        }
        continue;
      }
      if (!dates || label.indexOf('Total Ad Spend') !== 0) continue;
      for (let c = 2; c < vals[r].length && (c - 2) < dates.length; c++) {
        const dObj = dates[c - 2];
        if (!dObj) continue;
        if (Utilities.formatDate(dObj, 'America/Bogota', 'yyyy-MM-dd') > hoyStr) continue;
        const key = formatDayKey_(dObj);
        if (!days[key]) continue;   // solo días que ya existen por Meta
        const num = parseNumeric_(vals[r][c]);
        if (num !== null) days[key].spend_google = num;
      }
    }
  });

  // Limpiar días sin actividad real (columnas del mes aún no pobladas).
  Object.keys(days).forEach(k => {
    const d = days[k];
    if (!d.impressions && !d.spend && !d.purchases && !d.leads && !d.lpv && !d.clicks && !d.spend_google) {
      delete days[k];
    }
  });

  // Anotaciones
  const annotations = readAnnotations_(ss);

  // Config Web App (para que el dashboard sepa donde escribir anotaciones)
  const props = PropertiesService.getScriptProperties();
  const webAppUrl = props.getProperty('WEB_APP_URL') || '';
  const annotationSecret = props.getProperty('ANNOTATION_SECRET') || '';

  return {
    updatedAt: Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd HH:mm'),
    prices: { lowTicket: 37, bump1: 42, bump2: 48 },
    days: days,
    annotations: annotations,
    webAppUrl: webAppUrl,
    annotationSecret: annotationSecret
  };
}

function readAnnotations_(ss) {
  const sheet = ss.getSheetByName('Anotaciones');
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  return data
    .filter(row => row[0] && row[1] && row[3]) // id, date, text
    .map(row => ({
      id: String(row[0]),
      date: formatAnnDate_(row[1]),
      stage: String(row[2] || 'general'),
      text: String(row[3]),
      createdAt: row[4] instanceof Date ? row[4].toISOString() : String(row[4] || '')
    }));
}

function formatAnnDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'America/Bogota', 'yyyy-MM-dd');
  }
  return String(v);
}

function formatDayKey_(d) {
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return months[d.getMonth()] + ' ' + String(d.getDate()).padStart(2, '0');
}

function parseNumeric_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$\s]/g, '').replace(/\./g, '').replace(/,/g, '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ============================================================
// GITHUB DISPATCH
// ============================================================
function triggerGitHubDispatch_(data) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('GITHUB_TOKEN no configurado en Script Properties.');

  const url = 'https://api.github.com/repos/mentorjotacoo-crypto/mentor-jota-funnel/dispatches';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({
      event_type: 'update-funnel',
      client_payload: data
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code >= 300) throw new Error('GitHub API error ' + code + ': ' + response.getContentText());
}

// ============================================================
// WEB APP - recibe anotaciones desde el dashboard
// ============================================================
function doPost(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();
    const secret = e.parameter.secret || '';
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('ANNOTATION_SECRET') || '';

    if (!expectedSecret) {
      return jsonResponse_({ ok:false, error:'Secret no configurado en Apps Script' });
    }
    if (secret !== expectedSecret) {
      return jsonResponse_({ ok:false, error:'Secret invalido' });
    }

    const annRaw = e.parameter.annotation;
    if (!annRaw) return jsonResponse_({ ok:false, error:'Falta parametro annotation' });
    const ann = JSON.parse(annRaw);
    if (!ann.id) return jsonResponse_({ ok:false, error:'Annotation sin id' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Anotaciones');
    if (!sheet) return jsonResponse_({ ok:false, error:'Tab Anotaciones no existe. Ejecuta initDashboardSync() primero.' });

    if (action === 'delete') {
      const rowIdx = findAnnotationRow_(sheet, ann.id);
      if (rowIdx > 0) sheet.deleteRow(rowIdx);
      syncDashboard();
      return jsonResponse_({ ok:true, action:'deleted' });
    }

    if (action === 'upsert') {
      const rowIdx = findAnnotationRow_(sheet, ann.id);
      const row = [
        ann.id,
        ann.date,
        ann.stage || 'general',
        ann.text || '',
        ann.createdAt || new Date().toISOString()
      ];
      if (rowIdx > 0) {
        sheet.getRange(rowIdx, 1, 1, 5).setValues([row]);
      } else {
        sheet.appendRow(row);
      }
      syncDashboard();
      return jsonResponse_({ ok:true, action:'upserted' });
    }

    return jsonResponse_({ ok:false, error:'action invalida: ' + action });
  } catch (err) {
    return jsonResponse_({ ok:false, error:String(err) });
  }
}

function doGet(e) {
  return jsonResponse_({ ok:true, msg:'Dashboard sync endpoint. Use POST.' });
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function findAnnotationRow_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

// ============================================================
// DIAGNOSTICOS
// ============================================================
function previsualizarData() {
  const data = buildDataJson_();
  const keys = Object.keys(data.days);
  Logger.log('Total dias: ' + keys.length);
  Logger.log('Anotaciones: ' + data.annotations.length);
  Logger.log('Web App URL: ' + (data.webAppUrl || 'NO CONFIGURADO'));
  Logger.log('Annotation secret: ' + (data.annotationSecret ? 'OK' : 'NO CONFIGURADO'));
  Logger.log('Primeros 3 dias: ' + JSON.stringify(keys.slice(0, 3)));
  Logger.log('Ultimos 3 dias: ' + JSON.stringify(keys.slice(-3)));
}
