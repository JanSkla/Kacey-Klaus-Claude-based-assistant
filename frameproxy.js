/*
 * Kacey — another local app, served under a path on Kacey's own origin.
 *
 * Kacey frames apps that run on the same host on their own ports: the
 * self-update preview (/preview/) and lightsd (/lights/). Framing them by
 * port does not survive the way Kacey is reached from a phone or a remote
 * laptop: behind an https front (tailscale serve) a frame or fetch on
 * https://host:8080 finds no TLS there, http://host:8080 is mixed content,
 * and the app may only listen on loopback anyway. So every request under the
 * prefix is passed to the app on loopback, and its HTML gets a <base>, its
 * root-absolute src/href/action attributes rewritten, and a small shim so the
 * absolute URLs its code builds (/api/…, the /ws socket) stay under the
 * prefix too. The shim is Kacey's, not the app's, so it works whatever the
 * app's page does.
 */

import http from 'node:http';

function shim(prefix) {
  return `<base href="${prefix}/"><script>(function(){
var P=${JSON.stringify(prefix)};
function fix(u){try{var x=new URL(String(u),location.href);
if(x.host===location.host){
if(location.protocol==='https:'&&x.protocol==='ws:')x.protocol='wss:';
if(x.pathname.indexOf(P+'/')!==0&&x.pathname!==P)x.pathname=P+x.pathname;return x.href;}}catch(e){}return u;}
var F=window.fetch;window.fetch=function(i,o){
if(typeof i==='string'||i instanceof URL)i=fix(i);else if(i&&i.url)i=new Request(fix(i.url),i);return F.call(this,i,o);};
var W=window.WebSocket;function S(u,p){return p===undefined?new W(fix(u)):new W(fix(u),p);}
S.prototype=W.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){S[k]=W[k];});window.WebSocket=S;
var E=window.EventSource;if(E){var ES=function(u,o){return new E(fix(u),o);};ES.prototype=E.prototype;window.EventSource=ES;}
var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(u);return X.apply(this,arguments);};
if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error('framed'));};
})();</script>`;
}

/**
 * @param {object} o
 * @param {string} o.prefix          e.g. '/lights' (no trailing slash)
 * @param {() => string} o.target    the app's base URL on loopback, e.g. 'http://127.0.0.1:8080'
 * @param {string} o.waiting         the HTML page shown while the app does not answer
 * @returns {{ http: Function, upgrade: Function }}  Express middleware mounted at the prefix, and the WebSocket upgrade
 */
export function makeFrameProxy({ prefix, target, waiting }) {
  const SHIM = shim(prefix);
  const where = () => { const u = new URL(target()); return { host: u.hostname, port: Number(u.port) || 80 }; };

  function httpProxy(req, res) {
    const { host, port } = where();
    const headers = { ...req.headers, host: `${host}:${port}`, 'accept-encoding': 'identity' };
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
    const out = http.request({ host, port, method: req.method, path: req.url || '/', headers }, (pr) => {
      const hdrs = { ...pr.headers };
      // A redirect to the app's own root ("/login") stays under the prefix.
      if (typeof hdrs.location === 'string' && hdrs.location.startsWith('/') && !hdrs.location.startsWith('//')) {
        hdrs.location = prefix + hdrs.location;
      }
      const type = String(pr.headers['content-type'] || '');
      if (!type.startsWith('text/html')) {
        res.writeHead(pr.statusCode || 502, hdrs);
        pr.pipe(res);
        return;
      }
      const chunks = [];
      pr.on('data', (c) => chunks.push(c));
      pr.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        // <script src="/app.js"> ignores <base>: root-absolute attributes get the prefix by hand.
        html = html.replace(/\b(src|href|action)=(["'])\/(?!\/)/gi, (_m, attr, q) => `${attr}=${q}${prefix}/`);
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + SHIM) : SHIM + html;
        hdrs['content-length'] = Buffer.byteLength(html);
        hdrs['cache-control'] = 'no-store';
        delete hdrs.etag;
        delete hdrs['transfer-encoding'];
        delete hdrs['last-modified'];
        res.writeHead(pr.statusCode || 200, hdrs);
        res.end(html);
      });
    });
    out.on('error', () => {
      if (res.headersSent) res.end();
      else res.status(503).type('html').send(waiting);
    });
    req.pipe(out);
  }

  /** A socket under the prefix (/lights/ws) → the app's own (/ws). */
  function upgrade(req, socket, head) {
    const { host, port } = where();
    const pathPart = (req.url || '').slice(prefix.length) || '/';
    const out = http.request({
      host, port, method: 'GET', path: pathPart,
      headers: { ...req.headers, host: `${host}:${port}` },
    });
    out.on('upgrade', (pres, psock, phead) => {
      let lines = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (let i = 0; i < pres.rawHeaders.length; i += 2) lines += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
      socket.write(`${lines}\r\n`);
      if (phead?.length) socket.write(phead);
      if (head?.length) psock.write(head);
      psock.on('error', () => socket.destroy());
      socket.on('error', () => psock.destroy());
      psock.pipe(socket).pipe(psock);
    });
    out.on('response', () => socket.destroy());
    out.on('error', () => socket.destroy());
    out.end();
  }

  return { http: httpProxy, upgrade };
}
