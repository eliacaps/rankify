#!/usr/bin/env python3
"""
Server Rankify — versione cloud (Railway / Render / qualsiasi host Python).

Differenze rispetto alla versione locale:
  - Porta letta da variabile d'ambiente PORT (Railway la imposta in automatico).
  - I file JSON vengono salvati in DATA_DIR (montato come volume persistente su
    Railway) se definita, altrimenti nella cartella dello script (fallback locale).
  - Niente apertura automatica del browser.
  - Supporto CORS per eventuali accessi cross-origin.
  - Password opzionale: se la variabile d'ambiente RANKIFY_PASSWORD è impostata,
    tutte le chiamate POST /save-* richiedono l'header X-Rankify-Password corretto.
"""

import http.server
import json
import os
import sys
import mimetypes
from socketserver import ThreadingMixIn

# ── Configurazione ─────────────────────────────────────────────────────────────
PORT     = int(os.environ.get('PORT', 8765))

# DATA_DIR: cartella dove scrivere rankify.json e campionato.json
# Su Railway imposta la variabile d'ambiente DATA_DIR al mount path del volume
# (es. /data). Se non è impostata, usa la cartella dello script.
_script_dir = os.path.dirname(os.path.abspath(__file__))
DATA_DIR     = os.environ.get('DATA_DIR', _script_dir)

DB_FILE         = os.path.join(DATA_DIR, 'rankify.json')
CAMPIONATO_FILE = os.path.join(DATA_DIR, 'campionato.json')

# Password opzionale per proteggere le scritture
WRITE_PASSWORD = os.environ.get('RANKIFY_PASSWORD', '').strip()

# Token segreto per accedere come admin (modalità lettura+scrittura).
# Imposta la variabile d'ambiente RANKIFY_ADMIN_TOKEN su Railway.
# Tu apri:   https://tuaapp.railway.app/rankify.html?admin=<token>
# L'amico:   https://tuaapp.railway.app/rankify.html   (senza token = guest)
ADMIN_TOKEN = os.environ.get('RANKIFY_ADMIN_TOKEN', '').strip()

# ── Helper ─────────────────────────────────────────────────────────────────────
def parse_multipart(body, boundary):
    """Parser multipart minimale, restituisce dict {name: bytes}."""
    fields = {}
    delimiter = b'--' + boundary
    parts = body.split(delimiter)
    for part in parts[1:]:
        if part in (b'--\r\n', b'--'):
            continue
        if part.startswith(b'\r\n'):
            part = part[2:]
        if b'\r\n\r\n' not in part:
            continue
        headers_raw, _, content = part.partition(b'\r\n\r\n')
        if content.endswith(b'\r\n'):
            content = content[:-2]
        name = None
        for line in headers_raw.split(b'\r\n'):
            if b'Content-Disposition' in line:
                for token in line.split(b';'):
                    token = token.strip()
                    if token.startswith(b'name='):
                        name = token[5:].strip(b'"').decode('utf-8')
        if name:
            fields[name] = content
    return fields


def atomic_write(filepath, data):
    """Scrittura atomica: scrive su .tmp poi rinomina."""
    tmp = filepath + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, filepath)


class Handler(http.server.SimpleHTTPRequestHandler):

    # ── CORS & headers comuni ──────────────────────────────────────────────────
    def _send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Rankify-Password')

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    # ── Controllo password ─────────────────────────────────────────────────────
    def _check_password(self):
        """Restituisce True se la password è corretta (o non richiesta)."""
        if not WRITE_PASSWORD:
            return True
        sent = self.headers.get('X-Rankify-Password', '').strip()
        return sent == WRITE_PASSWORD

    def _deny(self, msg='Password errata'):
        self.send_response(403)
        self._send_cors()
        self.end_headers()
        self.wfile.write(msg.encode())

    # ── GET — file statici con supporto Range ──────────────────────────────────
    def do_GET(self):
        path = self.path.split('?')[0]

        # Endpoint speciale: genera config.js con il flag IS_ADMIN e la PASSWORD.
        # Il token admin viene letto dal cookie "rankify_admin" (impostato dal browser
        # la prima volta che si apre la URL con ?admin=TOKEN).
        # In questo modo il token non appare più nell'URL dopo il primo caricamento.
        if path == '/config.js':
            cookie_header = self.headers.get('Cookie', '')
            cookie_token  = ''
            for part in cookie_header.split(';'):
                part = part.strip()
                if part.startswith('rankify_admin='):
                    from urllib.parse import unquote
                    cookie_token = unquote(part[len('rankify_admin='):].strip())
                    break
            token_ok   = bool(ADMIN_TOKEN) and cookie_token == ADMIN_TOKEN
            is_admin_js = 'true' if token_ok else 'false'
            pwd_js      = WRITE_PASSWORD.replace("'", "\\'") if token_ok else ''
            script = (
                f"window._RANKIFY_IS_ADMIN = {is_admin_js};\n"
                f"window._RANKIFY_PASSWORD = '{pwd_js}';\n"
            )
            encoded = script.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(encoded)))
            self.send_header('Cache-Control', 'no-store')
            self._send_cors()
            self.end_headers()
            self.wfile.write(encoded)
            return

        fs_path = self.translate_path(path)

        if not os.path.isfile(fs_path):
            self.send_error(404, 'File non trovato')
            return

        file_size = os.path.getsize(fs_path)
        mime_type, _ = mimetypes.guess_type(fs_path)
        if not mime_type:
            mime_type = 'application/octet-stream'

        range_header = self.headers.get('Range')
        start, end = 0, file_size - 1

        if range_header:
            try:
                range_spec = range_header.strip().replace('bytes=', '')
                s, e = range_spec.split('-')
                start = int(s) if s else 0
                end   = int(e) if e else file_size - 1
                end   = min(end, file_size - 1)
            except Exception:
                self.send_error(400, 'Range header non valido')
                return

            chunk_size = end - start + 1
            self.send_response(206)
            self.send_header('Content-Type', mime_type)
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            self.send_header('Content-Length', str(chunk_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-cache')
            self._send_cors()
            self.end_headers()

            with open(fs_path, 'rb') as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        else:
            self.send_response(200)
            self.send_header('Content-Type', mime_type)
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-cache')
            self._send_cors()
            self.end_headers()

            with open(fs_path, 'rb') as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

    # ── POST ───────────────────────────────────────────────────────────────────
    def do_POST(self):
        if self.path == '/save-db':
            if not self._check_password():
                self._deny(); return
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            try:
                data = json.loads(body)
                atomic_write(DB_FILE, data)
                self.send_response(200)
                self._send_cors()
                self.end_headers()
                self.wfile.write(b'OK')
            except Exception as e:
                self.send_response(500)
                self._send_cors()
                self.end_headers()
                self.wfile.write(str(e).encode())

        elif self.path == '/save-campionato':
            if not self._check_password():
                self._deny(); return
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            try:
                data = json.loads(body)
                atomic_write(CAMPIONATO_FILE, data)
                self.send_response(200)
                self._send_cors()
                self.end_headers()
                self.wfile.write(b'OK')
            except Exception as e:
                self.send_response(500)
                self._send_cors()
                self.end_headers()
                self.wfile.write(str(e).encode())

        elif self.path == '/upload-file':
            if not self._check_password():
                self._deny(); return
            content_type = self.headers.get('Content-Type', '')
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            try:
                boundary = None
                for part in content_type.split(';'):
                    part = part.strip()
                    if part.startswith('boundary='):
                        boundary = part[9:].strip('"').encode()
                        break
                if not boundary:
                    raise ValueError('boundary mancante')

                fields = parse_multipart(body, boundary)
                dest_path = fields.get('path', b'').decode('utf-8').strip()
                file_data = fields.get('file')

                if not dest_path or file_data is None:
                    raise ValueError('Campi mancanti (path o file)')

                base = os.path.abspath('.')
                dest_abs = os.path.abspath(os.path.join(base, dest_path))
                if not dest_abs.startswith(base + os.sep):
                    raise ValueError('Path non consentito')

                os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
                with open(dest_abs, 'wb') as f:
                    f.write(file_data)

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({'ok': True, 'path': dest_path}).encode())

            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({'ok': False, 'error': str(e)}).encode())

        else:
            self.send_response(404)
            self._send_cors()
            self.end_headers()

    def log_message(self, fmt, *args):
        # Log minimo visibile nei log di Railway
        print(f'{self.address_string()} - {fmt % args}', flush=True)


# ── Init file JSON se mancanti ─────────────────────────────────────────────────
def ensure_data_files():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(DB_FILE):
        # Se c'è un rankify.json nella cartella dello script (deploy iniziale), copialo
        bundled = os.path.join(_script_dir, 'rankify.json')
        if os.path.exists(bundled) and bundled != DB_FILE:
            import shutil
            shutil.copy(bundled, DB_FILE)
            print(f'📋  Copiato rankify.json da {bundled} → {DB_FILE}')
        else:
            with open(DB_FILE, 'w') as f:
                f.write('[]')
    if not os.path.exists(CAMPIONATO_FILE):
        bundled = os.path.join(_script_dir, 'campionato.json')
        if os.path.exists(bundled) and bundled != CAMPIONATO_FILE:
            import shutil
            shutil.copy(bundled, CAMPIONATO_FILE)
            print(f'📋  Copiato campionato.json da {bundled} → {CAMPIONATO_FILE}')
        else:
            with open(CAMPIONATO_FILE, 'w') as f:
                f.write('{"S":[],"A":[],"B":[],"C":[]}')


if __name__ == '__main__':
    os.chdir(_script_dir)
    ensure_data_files()
    pwd_status   = '🔒 password attiva'   if WRITE_PASSWORD else '⚠️  nessuna password'
    token_status = f'🔑 token admin attivo' if ADMIN_TOKEN    else '⚠️  nessun token admin (tutti vedono i controlli)'
    masked_token = (ADMIN_TOKEN[:4] + '***') if len(ADMIN_TOKEN) > 4 else '***'
    print(f'✅  Rankify server avviato su porta {PORT}', flush=True)
    print(f'   DATA_DIR   = {DATA_DIR}', flush=True)
    print(f'   Scritture: {pwd_status}', flush=True)
    print(f'   Admin:     {token_status}', flush=True)
    print(f'   URL admin: http://localhost:{PORT}/rankify.html?admin={masked_token if ADMIN_TOKEN else "???"}', flush=True)
    try:
        class ThreadingHTTPServer(ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
        httpd = ThreadingHTTPServer(('', PORT), Handler)
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nServer fermato.')
        sys.exit(0)
