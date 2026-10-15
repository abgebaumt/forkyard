/**
 * Makes `https://dev.azure.com` answer from the local host mock – without any call leaving this
 * computer. The connect dialog only knows the public service (`https://dev.azure.com/<org>`), so a
 * test of the real UI path needs that address to work:
 *
 *   app settings: proxyUrl = proxy.url, sslCaFile = proxy.caFile
 *   app --CONNECT dev.azure.com:443--> this proxy --TLS (own CA, certificate for dev.azure.com)-->
 *       decrypted HTTP --> scripts/e2e/host-mock.mjs (organization "firma" under /firma)
 *
 * Every other CONNECT target and every plain proxy request is refused (403) and recorded in
 * `proxy.refused`, so a test can assert that nothing tried to reach anything else.
 *
 *   const mock = await startHostMock();
 *   const proxy = await startAzureProxy(mock);
 *   proxy.seen      [{ method, host, path }] – requests that went to the mock
 *   proxy.refused   ["host:port" | "METHOD url"] – everything refused
 *   proxy.route(fn) answer some requests itself (fn returns { status, json } or null)
 *   await proxy.close()
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { opensslPath } from "../../e2e/git-http-server.mjs";

const HOSTS = new Set(["dev.azure.com"]);

function makeChain(dir) {
  const file = (name) => path.join(dir, name);
  const run = (args) => execFileSync(opensslPath(), args, { stdio: "ignore", windowsHide: true });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("ca-key.pem"), "-out", file("ca.pem"), "-days", "2", "-subj", "/CN=forkyard E2E Azure CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", file("server-key.pem"), "-out", file("server.csr"), "-subj", "/CN=dev.azure.com"]);
  fs.writeFileSync(file("server.ext"), "subjectAltName=DNS:dev.azure.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  run(["x509", "-req", "-in", file("server.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca-key.pem"), "-CAcreateserial", "-out", file("server-cert.pem"), "-days", "2", "-extfile", file("server.ext")]);
  return { key: fs.readFileSync(file("server-key.pem")), cert: fs.readFileSync(file("server-cert.pem")), ca: file("ca.pem") };
}

/** Starts the proxy in front of a running host mock (`startHostMock()`). */
export async function startAzureProxy(mock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-azure-proxy-"));
  const chain = makeChain(dir);
  const seen = [];
  const refused = [];
  const sockets = new Set();

  // Decrypted requests from the tunnel: an own route may answer (data the fixed mock does not
  // have, e.g. a work item created during the test); otherwise forwarded unchanged (Host header
  // included) to the mock.
  const routes = [];
  const inner = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const target = new URL(request.url, "https://dev.azure.com");
      seen.push({ method: request.method, host: request.headers.host, path: request.url });
      let body = null;
      try {
        body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
      } catch {
        body = null;
      }
      for (const route of routes) {
        const answer = route({ method: request.method, path: target.pathname, query: target.searchParams, body, headers: request.headers });
        if (answer) {
          const text = JSON.stringify(answer.json ?? {});
          response.writeHead(answer.status ?? 200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
          response.end(text);
          return;
        }
      }
      const forward = http.request({ host: "127.0.0.1", port: mock.port, method: request.method, path: request.url, headers: request.headers }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      forward.on("error", (error) => {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`azure-proxy: ${error.message}`);
      });
      forward.end(raw);
    });
  });

  const outer = http.createServer((request, response) => {
    refused.push(`${request.method} ${request.url}`);
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("azure-proxy: only CONNECT to dev.azure.com");
  });
  outer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  outer.on("connect", (request, socket, head) => {
    const [host, port = "443"] = String(request.url).split(":");
    if (!HOSTS.has(host.toLowerCase()) || port !== "443") {
      refused.push(String(request.url));
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, { isServer: true, key: chain.key, cert: chain.cert });
    sockets.add(secure);
    secure.on("close", () => sockets.delete(secure));
    secure.on("error", () => socket.destroy());
    inner.emit("connection", secure);
  });

  await new Promise((resolve, reject) => {
    outer.once("error", reject);
    outer.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${outer.address().port}`;
  return {
    url,
    caFile: chain.ca,
    seen,
    refused,
    /** Adds a route: fn({ method, path, query, body, headers }) → { status?, json } to answer, or null to pass on to the mock. */
    route(fn) {
      routes.push(fn);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => outer.close(() => resolve()));
      inner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
