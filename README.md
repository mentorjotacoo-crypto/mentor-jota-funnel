# Mentor Jota Funnel Dashboard

Dashboard privado del embudo de ventas de MENtoreo (Desafío 12 Días → Low Ticket → Bumps).

Los datos se encriptan con **AES-256-GCM** (PBKDF2-SHA256, 150K iteraciones) antes de subir a GitHub. El repo es público pero los números solo se ven con la clave.

## Actualizar datos

1. Editar `data.json` con los nuevos días (copiar del Google Sheet).
2. Generar el HTML encriptado:

   ```bash
   node build.js "clave-de-jota"
   ```

3. Commit + push:

   ```bash
   git add index.html data.json
   git commit -m "update: datos al $(date +%Y-%m-%d)"
   git push
   ```

GitHub Pages redespliega automáticamente en ~30s.

## Estructura

- `data.json` — fuente de datos del embudo (no se sube encriptado, se sube tal cual)
- `template.html` — HTML con lógica de decryption (WebCrypto API)
- `build.js` — genera `index.html` con payload encriptado embebido
- `index.html` — output final desplegado vía GitHub Pages
- `apps-script-sync.js` — copia local del Apps Script del Sheet del tracker (la verdad es lo pegado en Google; si cambia aquí hay que repegarlo allá)

## Enlaces directos

La URL refleja la pestaña abierta y, cuando aplica la barra de período, el período: `#canales`, `#embudo/2026-09`, `#trends/last30`. Compartir ese enlace abre esa pestaña. Al recargar, el enlace manda sobre la vista recordada en `sessionStorage`. El formato viejo `#embudo/Sep` sigue funcionando (toma el septiembre más reciente).

## Llaves de día

Cada día del Low Ticket llega en `data.json` bajo `days`. El Apps Script emitía `"Sep 27"` (sin año) y desde 2026-10-05 emite ISO `"2026-09-27"`. La llave interna del tablero es ISO en todo (filtros, gráficas, tablas, cruces con ascensos/closers/atribución), así que el historial puede abarcar varios años: los filtros de mes son `YYYY-MM` y, cuando hay más de un año, las etiquetas llevan el año (`Feb 2026` / `Feb 2027`). `build.js` y `template.html` aceptan también las llaves viejas `"Mes DD"`: se pasan a ISO deduciendo el año por la fecha de sincronización (válido mientras el historial sin año sea menor a 12 meses).

## Seguridad

- El JSON con los números reales **nunca se commitea expuesto** al usuario final: solo el blob AES cifrado dentro de `index.html`
- Sin la clave: HTML útil = 0. El blob es ruido.
- Con la clave: desencripta en el navegador y renderiza.
- Session cache: al entrar una vez, se guarda la clave en `sessionStorage` hasta cerrar la pestaña.

**Nota:** El archivo `data.json` en este repo contiene los datos en plano. Si no quieres que el JSON plano quede público, agrégalo al `.gitignore` y solo commitea el `index.html` generado.
